/**
 * Read and save the entry rules' snapshot for a batch of one user's trades —
 * the second half of POST /api/trades/score (the first is flow-score-run.ts,
 * whose write rules this mirrors). Kept apart so it runs against an in-memory
 * store in scripts/test-entry-rules-parity.ts.
 *
 * Per trade:
 *   - already carries this version's snapshot of this exact fill → "current",
 *     returned as is; nothing read or written
 *   - read → the row is read AGAIN and only `review_json.entry_ctx` is replaced
 *     (read-merge: the Score, the verdict and every other key survive); if the
 *     fill changed meanwhile nothing is written
 *   - not readable / pending / failed → nothing is written
 */
import { ENTRY_CTX_VERSION, entryCtxIsCurrent, flowFingerprint, type EntryCtxResult } from '../flow-score-meta'
import type { TradeEntryCtx } from '@/lib/supabase/types'
import { FlowScoreLoader } from './flow-score-loader'
import type { FlowTradeRecord, FlowTradeStore } from './flow-score-run'

export async function readEntryContexts(
  store: FlowTradeStore, ids: string[], loader: () => FlowScoreLoader | Promise<FlowScoreLoader>,
  opts: { /** stop starting new trades at this Date.now(); the rest come back "pending" */ deadline?: number; now?: () => Date } = {},
): Promise<Record<string, EntryCtxResult>> {
  const now = opts.now ?? (() => new Date())
  const rows = await store.read(ids)
  const results: Record<string, EntryCtxResult> = {}
  const todo: FlowTradeRecord[] = []
  for (const r of rows) {
    const stored = r.review_json?.entry_ctx
    if (stored && entryCtxIsCurrent(stored, r)) results[r.id] = { status: 'current', ctx: stored }
    else todo.push(r)
  }
  if (!todo.length) return results

  const l = await loader()
  // same instrument and day together, latest fill first: the day's ticks are read once
  const where = (r: FlowTradeRecord) => `${r.symbol ?? ''}|${(r.entry_time ?? '').slice(0, 10)}`
  todo.sort((a, b) => where(a).localeCompare(where(b)) || (b.entry_time ?? '').localeCompare(a.entry_time ?? ''))
  for (const r of todo) {
    if (opts.deadline != null && Date.now() > opts.deadline) { results[r.id] = { status: 'pending', reason: 'not reached in this request' }; continue }
    try {
      const o = await l.entryContext(r)
      if (o.status !== 'read') { results[r.id] = { status: o.status, reason: o.reason }; continue }
      const ctx: TradeEntryCtx = {
        v: ENTRY_CTX_VERSION, src: flowFingerprint(r), read_at: o.read_at, bars: o.bars, tape: o.tape, tape_clock: o.tape_clock,
        at: `${now().toISOString().slice(0, 19)}+00:00`,
      }
      const fresh = await store.readOne(r.id)
      if (!fresh) { results[r.id] = { status: 'error', reason: 'the trade is no longer there' }; continue }
      if (flowFingerprint(fresh) !== ctx.src) { results[r.id] = { status: 'pending', reason: 'the fill changed while it was being read' }; continue }
      await store.writeReview(r.id, { ...(fresh.review_json ?? {}), entry_ctx: ctx })
      results[r.id] = { status: 'read', ctx }
    } catch (e) {
      console.error('[entry-context]', r.id, e)
      results[r.id] = { status: 'error', reason: 'could not read this trade' }
    }
  }
  return results
}
