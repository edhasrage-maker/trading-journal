'use client'

import { useEffect, useRef, useState } from 'react'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { TAPE_KEEP_DAYS } from '@/lib/orderflow/tape'
import { FLOW_SCORE_MAX_IDS, entryCtxIsCurrent, flowFingerprint, flowScoreIsCurrent, type EntryCtxResult, type FlowScoreResult } from '@/lib/orderflow/flow-score-meta'
import type { Trade, TradeEntryCtx, TradeFlowScore } from '@/lib/supabase/types'

/**
 * Scores for the trades on screen that do not carry a current one yet.
 *
 * The recap table shows `trade.review_json.score`. A trade that has none for
 * its present fill (never scored, or re-timed / re-priced since) is sent to
 * POST /api/trades/score in the background; the route computes it from the tick
 * tape, saves it on the trade and returns it, and it appears here without a
 * reload. Returns the scores that arrived this way, by trade id — and, read in
 * the same request, each fill's entry-rules snapshot (`entry`, see
 * src/lib/orderflow/entry-context.ts) for trades that lack a current one.
 *
 * QUIET BY DESIGN. Nothing is ever shown for a failure: a trade the tape cannot
 * read (too old, another instrument, outside the day session) simply keeps its
 * dash. Each fill is asked about once per page view. The route is a private
 * beta — a user outside it gets one 404 and is not asked about again until the
 * page is loaded afresh.
 *
 * A fill the feed has not published yet comes back "pending" and is retried a
 * few times, a minute apart — the feed runs every few minutes in the session.
 */

/** Set once the route has said no to this user (or is not set up); nothing more is sent this page view. */
let gateClosed = false

const RETRY_MS = 60_000
const MAX_RETRIES = 4

const keyOf = (t: Trade) => `${t.id}|${flowFingerprint(t)}`

/** Cheap pre-filter, so trades the route would only turn away are never sent. */
function worthAsking(t: Trade, now: number): boolean {
  if (!t.entry_time || t.entry_price == null || !t.symbol) return false
  if (t.direction !== 'long' && t.direction !== 'short') return false
  const root = chartSeriesRoot(t.symbol)
  if (root !== 'NQ' && root !== 'ES') return false
  const at = Date.parse(t.entry_time)
  return Number.isFinite(at) && now - at < TAPE_KEEP_DAYS * 86_400_000
}

export function useFlowScores(trades: Trade[], enabled: boolean): { scores: Record<string, TradeFlowScore>; entry: Record<string, TradeEntryCtx> } {
  const [scores, setScores] = useState<Record<string, TradeFlowScore>>({})
  const [entry, setEntry] = useState<Record<string, TradeEntryCtx>>({})
  /** Fills already sent (and not due a retry). */
  const asked = useRef(new Set<string>())
  const tries = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const mounted = useRef(true)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    return () => {
      mounted.current = false
      for (const t of pending) clearTimeout(t)
      pending.clear()
    }
  }, [])

  useEffect(() => {
    if (!enabled || gateClosed) return
    const now = Date.now()
    const want = trades.filter(t => worthAsking(t, now)
      && (!flowScoreIsCurrent(t.review_json?.score, t) || !entryCtxIsCurrent(t.review_json?.entry_ctx, t))
      && !asked.current.has(keyOf(t)))
    if (!want.length) return
    for (const t of want) asked.current.add(keyOf(t))

    void (async () => {
      for (let i = 0; i < want.length; i += FLOW_SCORE_MAX_IDS) {
        if (gateClosed || !mounted.current) return
        const batch = want.slice(i, i + FLOW_SCORE_MAX_IDS)
        let results: Record<string, FlowScoreResult>
        let entryRes: Record<string, EntryCtxResult>
        try {
          const res = await fetch('/api/trades/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: batch.map(t => t.id) }),
          })
          if (!res.ok) {
            // not in the beta, signed out, or not set up: stop asking for this page view
            if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 503) gateClosed = true
            return
          }
          const body = (await res.json()) as { results?: Record<string, FlowScoreResult>; entry?: Record<string, EntryCtxResult> }
          results = body.results ?? {}
          entryRes = body.entry ?? {}
        } catch { return }
        if (!mounted.current) return

        const got: Record<string, TradeFlowScore> = {}
        const gotCtx: Record<string, TradeEntryCtx> = {}
        const again: string[] = []
        for (const t of batch) {
          const r = results[t.id], c = entryRes[t.id]
          if (r && (r.status === 'scored' || r.status === 'current')) got[t.id] = r.score
          if (c && (c.status === 'read' || c.status === 'current')) gotCtx[t.id] = c.ctx
          if (r?.status === 'pending' || c?.status === 'pending') {
            const k = keyOf(t), n = (tries.current.get(k) ?? 0) + 1
            tries.current.set(k, n)
            if (n <= MAX_RETRIES) again.push(k)
          }
        }
        if (Object.keys(got).length) setScores(prev => ({ ...prev, ...got }))
        if (Object.keys(gotCtx).length) setEntry(prev => ({ ...prev, ...gotCtx }))
        if (again.length) {
          const timer = setTimeout(() => {
            timers.current.delete(timer)
            for (const k of again) asked.current.delete(k)
            setRetry(x => x + 1)
          }, RETRY_MS)
          timers.current.add(timer)
        }
      }
    })()
  }, [trades, enabled, retry])

  return { scores, entry }
}

/** The score to show for a trade: one that just arrived for its present fill, else the stored one. */
export function flowScoreFor(t: Trade, live: Record<string, TradeFlowScore>): TradeFlowScore | null {
  const fresh = live[t.id]
  if (fresh && flowScoreIsCurrent(fresh, t)) return fresh
  return t.review_json?.score ?? fresh ?? null
}

/** The entry-rules snapshot for a trade: one that just arrived for its present fill, else the stored one if current. */
export function entryCtxFor(t: Trade, live: Record<string, TradeEntryCtx>): TradeEntryCtx | null {
  const fresh = live[t.id]
  if (fresh && entryCtxIsCurrent(fresh, t)) return fresh
  const stored = t.review_json?.entry_ctx
  return stored && entryCtxIsCurrent(stored, t) ? stored : null
}
