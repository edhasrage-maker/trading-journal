/**
 * Score a batch of one user's trades and save the results — the body of
 * POST /api/trades/score, kept apart from the route so it can be run against an
 * in-memory store (scripts/test-flow-score-parity.ts does, so the write rules
 * are tested without writing anywhere).
 *
 * Rules, per trade:
 *   - already carries this version's score for this exact fill → "current",
 *     returned as is; nothing is computed or written
 *   - scored → the row is read AGAIN and only `review_json.score` is replaced
 *     (read-merge: the trader's verdict and every other key survive); if the
 *     fill changed while it was being scored nothing is written
 *   - not scorable / pending / failed → nothing is written
 */
import { FLOW_VERSION, flowFingerprint, flowScoreIsCurrent, type FlowScoreResult } from '../flow-score-meta'
import type { TradeFlowScore, TradeReview } from '@/lib/supabase/types'
import { FlowScoreLoader, type FlowTradeRow } from './flow-score-loader'

export interface FlowTradeRecord extends FlowTradeRow { review_json: TradeReview | null }
export const FLOW_TRADE_COLUMNS = 'id, symbol, entry_time, entry_price, direction, review_json'

/** The trades table as this needs it. Every method is scoped to the caller's own rows by the implementation. */
export interface FlowTradeStore {
  read(ids: string[]): Promise<FlowTradeRecord[]>
  readOne(id: string): Promise<FlowTradeRecord | null>
  writeReview(id: string, review: TradeReview): Promise<void>
}

export async function scoreTrades(
  store: FlowTradeStore, ids: string[], loader: () => FlowScoreLoader | Promise<FlowScoreLoader>,
  opts: { /** stop starting new trades after this long; the rest come back "pending" */ budgetMs?: number; now?: () => Date } = {},
): Promise<Record<string, FlowScoreResult>> {
  const started = Date.now()
  const now = opts.now ?? (() => new Date())
  const rows = await store.read(ids)
  const results: Record<string, FlowScoreResult> = {}
  const todo: FlowTradeRecord[] = []
  for (const r of rows) {
    const stored = r.review_json?.score
    if (stored && flowScoreIsCurrent(stored, r)) results[r.id] = { status: 'current', score: stored }
    else todo.push(r)
  }
  if (!todo.length) return results

  const l = await loader()
  // Same instrument and day together, latest fill first: the day's ticks are then read once.
  const where = (r: FlowTradeRecord) => { const at = FlowScoreLoader.locate(r); return 'reason' in at ? '' : `${at.root}|${at.date}` }
  todo.sort((a, b) => where(a).localeCompare(where(b)) || (b.entry_time ?? '').localeCompare(a.entry_time ?? ''))
  for (const r of todo) {
    if (opts.budgetMs != null && Date.now() - started > opts.budgetMs) { results[r.id] = { status: 'pending', reason: 'not reached in this request' }; continue }
    try {
      const o = await l.score(r)
      if (o.status !== 'scored') { results[r.id] = { status: o.status, reason: o.reason }; continue }
      // the stored shape is the local Python scorer's (push_scores.py), key for key
      const score: TradeFlowScore = {
        v: FLOW_VERSION, total: o.total, max: 100, facts: o.facts, read_at: o.read_at,
        at: `${now().toISOString().slice(0, 19)}+00:00`, src: flowFingerprint(r),
      }
      // read-merge on the row as it is NOW: a verdict saved while this was computing must survive,
      // and a fill edited meanwhile must not get a score read for the old one
      const fresh = await store.readOne(r.id)
      if (!fresh) { results[r.id] = { status: 'error', reason: 'the trade is no longer there' }; continue }
      if (flowFingerprint(fresh) !== score.src) { results[r.id] = { status: 'pending', reason: 'the fill changed while it was being scored' }; continue }
      await store.writeReview(r.id, { ...(fresh.review_json ?? {}), score })
      results[r.id] = { status: 'scored', score }
    } catch (e) {
      console.error('[flow-score]', r.id, e)
      results[r.id] = { status: 'error', reason: 'could not score this trade' }
    }
  }
  return results
}
