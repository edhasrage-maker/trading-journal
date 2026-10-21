import { exitTradeScores, lossSizeInputs, lossSizeScore, type ExitTradeInput, type RiskYardstick } from '@/lib/exit-score'
import { emptyTradeSums, type FactorSum, type TradeSums } from '@/lib/tapescore-axes'
import { entryRulesSig, evaluateRules, tradeRulesScore, type EntryRuleConfig } from '@/lib/entry-rules'
import { runnerRulesSig, tradeRunnerPart, type RunnerRuleConfig } from '@/lib/runner-rules'
import type { TradeEntryCtx } from '@/lib/supabase/types'
import {
  reentryReads, sizeUpFails, sizeUpInputs, toProxyTrades, type SizeUpInputs,
} from '@/lib/tapescore-day-rules'

/**
 * Plumbing between the per-trade parts of TapeScore and the places that show
 * them. Nothing here decides how a trade is scored (src/lib/exit-score.ts) or
 * how parts are weighted (src/lib/tapescore-axes.ts) — it stores a day's
 * per-trade inputs, works out the trader's risk yardstick, and reads the
 * result for a day.
 *
 * The per-trade parts: Risk's loss size, stop size and re-entries after a loss,
 * Entry's entry rules and order-flow Score, and Exit's profit kept, stop
 * respected and runner rules.
 *
 * Why a day cannot simply store its scores: "Loss size" measures a loss against
 * the trader's USUAL RISK — the yardstick — which comes from EARLIER days. So a
 * day stores the other parts as sums + counts and its losing trades as raw
 * pairs, and loss size is worked out when the days are read in sequence. The
 * "no size-up after a loss" rule reads the same yardstick, so its inputs ride
 * along (`size_up`) and it is resolved in the same step.
 *
 * One rule for the yardstick, used by every surface (dashboard, recaps, the
 * Recap day page), so a day never shows two different Risk numbers:
 *
 *   take the most recent PRIOR days — whole days, strictly before the date —
 *   going back until they cover at least 30 trades with a logged stop; the
 *   yardstick is the mean and the population standard deviation of those
 *   trades' planned dollar risk. With fewer than 5 such trades there is none:
 *   each loss is measured against its own planned risk instead, and the size-up
 *   rule falls back to comparing contract counts.
 */

/** Prior days are added until they cover this many trades with a logged stop. */
export const AVG_RISK_WINDOW_TRADES = 30
/** Below this many, there is no yardstick. */
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
  /** Entry rules: each trade with a counted rule, the share of its counted
   *  rules it passed (src/lib/entry-rules.ts). Baked in with the trader's
   *  rules — `rules_sig` says which; a cached row whose sig differs is stale. */
  entryRules: FactorSum
  /** traderRulesSig() of the trader's own rules these sums were computed with —
   *  entry rules (`entryRules`) and runner rules (`runner`); '' = none. */
  rules_sig: string
  /** Order-flow Score: each scored trade's total ÷ 100. Always stored; whether
   *  it counts toward Entry is the trader's setting, applied when read. */
  flow: FactorSum
  kept: FactorSum
  stopRespected: FactorSum
  runner: FactorSum
  /** One entry per losing trade "Loss size" judges:
   *  [dollars lost, the trade's own planned dollar risk or null]. */
  losses: Array<[number, number | null]>
  /** What the "no size-up after a loss" rule needs (src/lib/tapescore-day-rules.ts):
   *  the planned $ risk of each trade taken while red or after a loss, judged
   *  against the same yardstick as "Loss size" when the days are read. */
  size_up: SizeUpInputs
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
  /** The entry rules' snapshot: from the full `review_json` (the Recap page) or
   *  the rollup's lean JSON-path select. */
  review_json?: { score?: { total?: unknown } | null; entry_ctx?: TradeEntryCtx | null } | null
  entry_ctx?: TradeEntryCtx | null
}

/** A trade's Entry-rules score, 0..1, under the trader's rules; null when none of them counts on it. */
export function tradeEntryRulesScore(t: PartsTrade, rules: readonly EntryRuleConfig[] | null | undefined): number | null {
  if (!rules?.length) return null
  const ctx = t.review_json?.entry_ctx ?? t.entry_ctx ?? null
  return tradeRulesScore(evaluateRules(rules, ctx, { direction: t.direction, symbol: t.symbol, entry_time: t.entry_time ?? null }))
}

/** Which of the trader's own rules a day's sums were computed with — entry rules, then runner rules ('' = none). */
export function traderRulesSig(entryRules?: readonly EntryRuleConfig[] | null, runnerRules?: readonly RunnerRuleConfig[] | null): string {
  const r = runnerRulesSig(runnerRules)
  return entryRulesSig(entryRules) + (r ? `|${r}` : '')
}

/** A day's per-trade inputs from its trades. `entryRules` / `runnerRules` = the trader's own rules
 *  (none → those parts are absent / the generic Runner part applies). */
export function dayTradeInputs(
  trades: readonly PartsTrade[], atrStopTarget?: number | null,
  entryRules?: readonly EntryRuleConfig[] | null, runnerRules?: readonly RunnerRuleConfig[] | null,
): DayTradeInputs {
  const target = normalizeAtrStopTarget(atrStopTarget)
  const sums = emptyTradeSums()
  const losses: DayTradeInputs['losses'] = []
  // Re-entries (and trades tagged revenge): found on the whole day's sequence,
  // judged per trade — the same reads as each trade's "Waited after a loss".
  const proxies = toProxyTrades(trades)
  const reads = reentryReads(trades)
  trades.forEach((_, i) => {
    const r = reads.get(proxies[i].id)
    if (r) { sums.reentry.n += 1; sums.reentry.sum += r.fresh ? 1 : 0 }
  })
  for (const t of trades) {
    // The yardstick is deliberately absent: it belongs to the read.
    const s = exitTradeScores(t, { atrStopTarget: target })
    for (const k of STORED) {
      if (k === 'runner') continue
      const v = s[k]; if (v != null) { sums[k].n += 1; sums[k].sum += v }
    }
    // Runner rules: the trader's own on trades where one counts (a trade that is not a
    // runner then has no runner score), else the generic part as before.
    const rp = tradeRunnerPart(t, runnerRules)
    const runner = rp.own ? rp.score : (s.runner ?? null)
    if (runner != null) { sums.runner.n += 1; sums.runner.sum += runner }
    const pair = lossSizeInputs(t)
    if (pair) losses.push(pair)
    const flow = tradeFlowTotal(t)
    if (flow != null) { sums.flow.n += 1; sums.flow.sum += flow / 100 }
    const rule = tradeEntryRulesScore(t, entryRules)
    if (rule != null) { sums.entryRules.n += 1; sums.entryRules.sum += rule }
  }
  return {
    atr_stop: target,
    stopSize: sums.stopSize, reentry: sums.reentry, entryRules: sums.entryRules, rules_sig: traderRulesSig(entryRules, runnerRules), flow: sums.flow,
    kept: sums.kept, stopRespected: sums.stopRespected, runner: sums.runner,
    losses,
    size_up: sizeUpInputs(trades),
  }
}

/** A day's full per-trade sums, with "Loss size" scored against the trader's
 *  `yardstick` (null = none yet; each loss falls back to its own planned risk). */
export function dayTradeSums(stored: DayTradeInputs | null | undefined, yardstick: RiskYardstick | null): TradeSums | null {
  if (!stored) return null
  const sums = emptyTradeSums()
  for (const k of [...STORED, 'reentry', 'entryRules', 'flow'] as const) {
    sums[k].n = stored[k]?.n || 0
    sums[k].sum = stored[k]?.sum || 0
  }
  for (const pair of stored.losses ?? []) {
    const s = lossSizeScore(pair[0], pair[1] ?? null, yardstick)
    if (s != null) { sums.lossSize.n += 1; sums.lossSize.sum += s }
  }
  return sums
}

/** The part of a day the yardstick rule reads. */
export interface RiskDay {
  date: string
  /** Summed planned dollar risk of the day's trades with a logged stop. */
  sum_risk_dollars?: number | null
  /** The same trades' planned dollar risk, squared and summed (for the SD). */
  sum_risk_sq?: number | null
  /** How many trades those sums cover. */
  risk_sample?: number | null
}

/** Mean and population SD from a window's sums; null under the minimum. */
function yardstickOf(sum: number, sq: number, n: number): RiskYardstick | null {
  if (n < AVG_RISK_MIN_TRADES || !(sum > 0)) return null
  const mean = sum / n
  return { mean, sd: Math.sqrt(Math.max(0, sq / n - mean * mean)), n }
}

/**
 * The trader's risk yardstick going INTO `date`: the most recent whole days
 * strictly before it, added newest-first until they cover at least
 * AVG_RISK_WINDOW_TRADES stop trades — the mean and population SD of those
 * trades' planned dollar risk. Null with fewer than AVG_RISK_MIN_TRADES.
 * `days` may be in any order and may include `date` itself or later days.
 */
export function riskYardstickBefore(date: string, days: readonly RiskDay[]): RiskYardstick | null {
  const prior = days
    .filter(d => d.date < date && (d.risk_sample ?? 0) > 0)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  let sum = 0, sq = 0, n = 0
  for (const d of prior) {
    sum += d.sum_risk_dollars ?? 0
    sq += d.sum_risk_sq ?? 0
    n += d.risk_sample ?? 0
    if (n >= AVG_RISK_WINDOW_TRADES) break
  }
  return yardstickOf(sum, sq, n)
}

/** One day's per-trade parts, read in sequence. */
export interface DayTradeRead {
  /** The yardstick "Loss size" and the size-up rule were measured against (null = none yet). */
  yardstick: RiskYardstick | null
  /** Sums + counts per part — what a period pools. Null when the day carries no inputs. */
  sums: TradeSums | null
  /** "No size-up after a loss": how many trades risked more than the trader's
   *  usual spread (the quantity rule with no yardstick). Null when the day
   *  carries no inputs. */
  sizeUpFails: number | null
}

/**
 * Read a set of days in sequence: each day's yardstick comes from the days
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
    let sum = 0, sq = 0, n = 0
    while (hi > 0 && n < AVG_RISK_WINDOW_TRADES) {
      hi -= 1
      sum += all[hi].sum_risk_dollars ?? 0
      sq += all[hi].sum_risk_sq ?? 0
      n += all[hi].risk_sample ?? 0
    }
    const yardstick = yardstickOf(sum, sq, n)
    return {
      yardstick,
      sums: dayTradeSums(d.trade_parts, yardstick),
      sizeUpFails: d.trade_parts?.size_up ? sizeUpFails(d.trade_parts.size_up, yardstick) : null,
    }
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
