import { exitTradeScores, lossSizeInputs, lossSizeScore, type ExitTradeInput } from '@/lib/exit-score'
import { emptyTradeSums, type FactorSum, type TradeSums } from '@/lib/tapescore-axes'
import { reentryAfterLossIds } from '@/lib/behavioral-proxies'
import { REENTRY_WINDOW_MIN, hasFreshTrigger, toProxyTrades } from '@/lib/tapescore-day-rules'

/**
 * Plumbing between the per-trade parts of TapeScore and the places that show
 * them. Nothing here decides how a trade is scored (src/lib/exit-score.ts) or
 * how parts are weighted (src/lib/tapescore-axes.ts) — it stores a day's
 * per-trade inputs, works out the trader's average dollar risk, and reads the
 * result for a day.
 *
 * The per-trade parts: Risk's loss size, stop size and re-entries after a loss,
 * Entry's order-flow Score, and Exit's profit kept, stop respected and runner
 * rules.
 *
 * Why a day cannot simply store its scores: "Loss size" measures a loss against
 * the trader's AVERAGE dollar risk, which comes from EARLIER days. So a day
 * stores the other parts as sums + counts and its losing trades as raw pairs,
 * and loss size is worked out when the days are read in sequence.
 *
 * One rule for the average, used by every surface (dashboard, recaps, the
 * Recap day page), so a day never shows two different Risk numbers:
 *
 *   take the most recent PRIOR days — whole days, strictly before the date —
 *   going back until they cover at least 30 trades with a logged stop; the
 *   average is their summed planned dollar risk ÷ their count. With fewer than
 *   5 such trades there is no average, and each loss is measured against its
 *   own planned risk instead.
 */

/** Prior days are added until they cover this many trades with a logged stop. */
export const AVG_RISK_WINDOW_TRADES = 30
/** Below this many, there is no average. */
export const AVG_RISK_MIN_TRADES = 5

/** What a day keeps for its per-trade parts — JSON-safe, cached in `stats_json`. */
export interface DayTradeInputs {
  /** The trader's ATR stop setting the "Stop size" sums were computed with. A
   *  cached row whose value differs from the current setting is stale. */
  atr_stop: number
  stopSize: FactorSum
  /** Risk's "Re-entries": trades entered within 5 minutes of a losing exit
   *  that day, 1 = fresh trigger, 0 = none. */
  reentry: FactorSum
  /** Order-flow Score: each scored trade's total ÷ 100. Always stored; whether
   *  it counts toward Entry is the trader's setting, applied when read. */
  flow: FactorSum
  kept: FactorSum
  stopRespected: FactorSum
  runner: FactorSum
  /** One entry per losing trade "Loss size" judges:
   *  [dollars lost, the trade's own planned dollar risk or null]. */
  losses: Array<[number, number | null]>
}

/** The trader's ATR stop setting as "Stop size" uses it (default 1). */
export function normalizeAtrStopTarget(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}

/** A trade as the order-flow Score is read from it: the full `review_json`
 *  (the Recap page) or just its total (the rollup's lean JSON-path select). */
export interface FlowScoredTrade {
  review_json?: { score?: { total?: unknown } | null } | null
  flow_total?: unknown
}

/** A trade's order-flow Score total (0-100), or null when it carries none.
 *  Any version — only `total` is read. */
export function tradeFlowTotal(t: FlowScoredTrade): number | null {
  const v = t.review_json?.score?.total ?? t.flow_total
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
}

type StoredKey = 'stopSize' | 'kept' | 'stopRespected' | 'runner'
const STORED: readonly StoredKey[] = ['stopSize', 'kept', 'stopRespected', 'runner']

/** A trade as the per-trade parts read it. Times are optional: without them a
 *  trade is simply never a quick re-entry. */
export type PartsTrade = ExitTradeInput & FlowScoredTrade & {
  id?: string | null
  entry_time?: string | null
  exit_time?: string | null
}

/** A day's per-trade inputs from its trades. */
export function dayTradeInputs(trades: readonly PartsTrade[], atrStopTarget?: number | null): DayTradeInputs {
  const target = normalizeAtrStopTarget(atrStopTarget)
  const sums = emptyTradeSums()
  const losses: DayTradeInputs['losses'] = []
  // Re-entries: found on the whole day's sequence, then judged per trade.
  const proxies = toProxyTrades(trades)
  const reentries = new Set(reentryAfterLossIds(proxies, REENTRY_WINDOW_MIN))
  trades.forEach((t, i) => {
    if (reentries.has(proxies[i].id)) { sums.reentry.n += 1; sums.reentry.sum += hasFreshTrigger(t) ? 1 : 0 }
  })
  for (const t of trades) {
    // avgRiskDollars is deliberately absent: the average belongs to the read.
    const s = exitTradeScores(t, { atrStopTarget: target })
    for (const k of STORED) { const v = s[k]; if (v != null) { sums[k].n += 1; sums[k].sum += v } }
    const pair = lossSizeInputs(t)
    if (pair) losses.push(pair)
    const flow = tradeFlowTotal(t)
    if (flow != null) { sums.flow.n += 1; sums.flow.sum += flow / 100 }
  }
  return {
    atr_stop: target,
    stopSize: sums.stopSize, reentry: sums.reentry, flow: sums.flow,
    kept: sums.kept, stopRespected: sums.stopRespected, runner: sums.runner,
    losses,
  }
}

/** A day's full per-trade sums, with "Loss size" scored against `avgRiskDollars`
 *  (null = no average; each loss falls back to its own planned risk). */
export function dayTradeSums(stored: DayTradeInputs | null | undefined, avgRiskDollars: number | null): TradeSums | null {
  if (!stored) return null
  const sums = emptyTradeSums()
  for (const k of [...STORED, 'reentry', 'flow'] as const) {
    sums[k].n = stored[k]?.n || 0
    sums[k].sum = stored[k]?.sum || 0
  }
  for (const pair of stored.losses ?? []) {
    const s = lossSizeScore(pair[0], pair[1] ?? null, avgRiskDollars)
    if (s != null) { sums.lossSize.n += 1; sums.lossSize.sum += s }
  }
  return sums
}

/** The part of a day the average-risk rule reads. */
export interface RiskDay {
  date: string
  /** Summed planned dollar risk of the day's trades with a logged stop. */
  sum_risk_dollars?: number | null
  /** How many trades that sum covers. */
  risk_sample?: number | null
}

/**
 * The trader's average planned dollar risk going INTO `date`: the most recent
 * whole days strictly before it, added newest-first until they cover at least
 * AVG_RISK_WINDOW_TRADES stop trades. Null with fewer than AVG_RISK_MIN_TRADES.
 * `days` may be in any order and may include `date` itself or later days.
 */
export function avgRiskBefore(date: string, days: readonly RiskDay[]): number | null {
  const prior = days
    .filter(d => d.date < date && (d.risk_sample ?? 0) > 0)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  let sum = 0, n = 0
  for (const d of prior) {
    sum += d.sum_risk_dollars ?? 0
    n += d.risk_sample ?? 0
    if (n >= AVG_RISK_WINDOW_TRADES) break
  }
  return n >= AVG_RISK_MIN_TRADES && sum > 0 ? sum / n : null
}

/** One day's per-trade parts, read in sequence. */
export interface DayTradeRead {
  /** The average dollar risk "Loss size" was measured against (null = none yet). */
  avgRiskDollars: number | null
  /** Sums + counts per part — what a period pools. Null when the day carries no inputs. */
  sums: TradeSums | null
}

/**
 * Read a set of days in sequence: each day's average risk comes from the days
 * before it — the other days passed here plus `history` (earlier days the
 * caller loaded only for this purpose). A date present in both counts once,
 * from `days`. Returns one entry per input day, in input order.
 */
export function tradeSumsInSequence<T extends RiskDay & { trade_parts?: DayTradeInputs | null }>(
  days: readonly T[],
  history: readonly RiskDay[] = [],
): DayTradeRead[] {
  const own = new Set(days.map(d => d.date))
  const all: RiskDay[] = [...days, ...history.filter(h => !own.has(h.date))]
    .filter(d => (d.risk_sample ?? 0) > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return days.map(d => {
    // `all` is ascending, so the days strictly before this one are a prefix.
    let hi = lowerBound(all, d.date)
    let sum = 0, n = 0
    while (hi > 0 && n < AVG_RISK_WINDOW_TRADES) {
      hi -= 1
      sum += all[hi].sum_risk_dollars ?? 0
      n += all[hi].risk_sample ?? 0
    }
    const avgRiskDollars = n >= AVG_RISK_MIN_TRADES && sum > 0 ? sum / n : null
    return { avgRiskDollars, sums: dayTradeSums(d.trade_parts, avgRiskDollars) }
  })
}

/** First index whose date is not before `date`. */
function lowerBound(sorted: readonly RiskDay[], date: string): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return lo
}
