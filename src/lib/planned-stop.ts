/**
 * The stop a trade was planned with, and whether the trader moved it away —
 * from Sierra's own stop history (review_json.stops, src/lib/sc-stops.ts) when
 * the trade has one, else the logged stop (founder's call, 2026-10-16).
 *
 *   Planned stop  where the trade's stop orders stood 60 s after each went
 *                 working (the entry fill, or its placement if later). Inside
 *                 that minute the trader is still setting it: the bracket
 *                 default is dragged out to the real stop within seconds of the
 *                 fill (66 of 111 such moves since May came inside 10 s), so
 *                 neither the stop at the fill nor a stop tightened later is the
 *                 plan. A move to breakeven or better inside the minute is not
 *                 the plan either, so the last price still on the loss side
 *                 counts. Several stop orders (one per entry fill) average.
 *   Moved away    a change the trader made after that minute that put a stop
 *                 further from entry. Tightening never counts; neither does
 *                 Sierra's own automation.
 *
 * Every planned-risk number (R, heat and "past stop", Stop respected, Stop
 * size, Loss size, the checklist's stop checks, the coach's R) reads
 * `plannedStopPrice`, so a stop tightened during the trade no longer shrinks the
 * risk it was taken with. The trade form still shows and saves the LOGGED stop.
 * Pure and client-safe.
 */
import { storedStops } from '@/lib/sc-stops'
import type { TradeStops } from '@/lib/supabase/types'

/** How long after a stop goes working the trader is still setting it. */
export const STOP_SETTLE_MS = 60_000

/** The trade fields the planned stop reads (superset-safe). */
export interface StopSource {
  stop_price?: number | null
  entry_price?: number | null
  direction?: string | null
  /** review_json.stops selected on its own … */
  stops?: TradeStops | null
  /** … or inside the full review_json. */
  review_json?: unknown
}

export interface StopPlan {
  /** The planned stop price; null = none (no usable history, nothing logged). */
  price: number | null
  /** Where it came from. */
  source: 'sierra' | 'logged' | null
  /** First change by the trader, after the settle minute, that put a stop further from entry. Sierra history only. */
  movedAway: { t: string; from: number; to: number } | null
  /** Where the stop stood when the trade ended (how it ended: stopped or not). Sierra's last price, else the logged stop. */
  final: number | null
}

const NONE: StopPlan = { price: null, source: null, movedAway: null, final: null }

/** Sierra's read of one stop history, by entry and direction (parsing once per stored object). */
const cache = new WeakMap<object, Map<string, StopPlan | null>>()

function rawStops(t: StopSource): unknown {
  return t.stops ?? (t.review_json as { stops?: unknown } | null | undefined)?.stops ?? null
}

function fromSierra(raw: unknown, entry: number, sign: 1 | -1): StopPlan | null {
  const st = storedStops(raw)
  if (!st || !st.orders.length) return null
  // distance from entry on the loss side; > 0 = a stop still risking something
  const dist = (px: number) => (entry - px) * sign
  const planned: number[] = [], finals: number[] = []
  let movedAway: StopPlan['movedAway'] = null
  for (const o of st.orders) {
    const start = Date.parse(o.start.t)
    if (!Number.isFinite(start)) continue
    const settle = start + STOP_SETTLE_MS
    const pts = [{ t: o.start.t, ms: start, px: o.start.px, by: 'you' as const }, ...o.moves.map(m => ({ ...m, ms: Date.parse(m.t) }))]
    let plan: number | null = null
    for (const p of pts) {
      if (!(p.ms <= settle)) break
      if (dist(p.px) > 1e-9) plan = p.px
    }
    if (plan != null) planned.push(plan)
    finals.push(pts[pts.length - 1].px)
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], prev = pts[i - 1]
      if (!(p.ms > settle) || p.by !== 'you') continue
      if (dist(p.px) > dist(prev.px) + 1e-9 && (!movedAway || p.ms < Date.parse(movedAway.t))) movedAway = { t: p.t, from: prev.px, to: p.px }
    }
  }
  if (!planned.length) return null
  const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100
  return { price: mean(planned), source: 'sierra', movedAway, final: mean(finals) }
}

/** The trade's planned stop, where it came from, and whether the trader moved it away. */
export function stopPlan(t: StopSource): StopPlan {
  const logged = t.stop_price != null && Number.isFinite(Number(t.stop_price)) ? Number(t.stop_price) : null
  const fallback: StopPlan = logged != null ? { price: logged, source: 'logged', movedAway: null, final: logged } : NONE
  const raw = rawStops(t)
  const entry = t.entry_price != null ? Number(t.entry_price) : NaN
  const sign = t.direction === 'long' ? 1 : t.direction === 'short' ? -1 : 0
  if (!raw || typeof raw !== 'object' || !Number.isFinite(entry) || sign === 0) return fallback
  const key = `${entry}|${sign}`
  let byKey = cache.get(raw)
  if (!byKey) { byKey = new Map(); cache.set(raw, byKey) }
  let read = byKey.get(key)
  if (read === undefined) { read = fromSierra(raw, entry, sign); byKey.set(key, read) }
  return read ?? fallback
}

/** The stop every planned-risk number reads: Sierra's planned stop, else the logged one. */
export function plannedStopPrice(t: StopSource): number | null {
  return stopPlan(t).price
}
