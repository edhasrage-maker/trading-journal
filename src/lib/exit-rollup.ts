import {
  EXIT_FACTORS, EXIT_LABELS, emptyExitSums, exitScoreView, exitTradeScores, lossSizeInputs, lossSizeScore,
  type ExitFactorKey, type ExitFactorSum, type ExitScoreView, type ExitSums, type ExitTradeInput,
} from '@/lib/exit-score'

/**
 * Plumbing between the Exit score definition (src/lib/exit-score.ts) and the
 * places that show it. Nothing here decides how a trade is scored — it stores a
 * day's inputs, works out the trader's average dollar risk, and reads the
 * result for a day or a period.
 *
 * Why a day cannot simply store its Exit score: four of the five factors need
 * only the trade itself, but "Loss size" measures a loss against the trader's
 * AVERAGE dollar risk, which comes from EARLIER days. So a day stores the four
 * self-contained factors as sums + counts and its losing trades as raw pairs,
 * and the fifth factor is worked out when the days are read in sequence.
 *
 * One rule for the average, used by every surface (dashboard, recaps, the
 * Recap day page), so a day never shows two different Exit numbers:
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

/** What a day keeps for its Exit score — JSON-safe, cached in `stats_json`. */
export interface DayExitStored {
  /** The trader's ATR stop setting the "Stop size" sums were computed with. A
   *  cached row whose value differs from the current setting is stale. */
  atr_stop: number
  kept: ExitFactorSum
  stopRespected: ExitFactorSum
  stopSize: ExitFactorSum
  runner: ExitFactorSum
  /** One entry per losing trade "Loss size" judges:
   *  [dollars lost, the trade's own planned dollar risk or null]. */
  losses: Array<[number, number | null]>
}

/** The trader's ATR stop setting as the Exit score uses it (default 1). */
export function normalizeAtrStopTarget(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}

/** A day's Exit inputs from its trades. */
export function dayExitStored(trades: readonly ExitTradeInput[], atrStopTarget?: number | null): DayExitStored {
  const target = normalizeAtrStopTarget(atrStopTarget)
  const sums = emptyExitSums()
  const losses: DayExitStored['losses'] = []
  for (const t of trades) {
    // avgRiskDollars is deliberately absent: the average belongs to the read.
    const s = exitTradeScores(t, { atrStopTarget: target })
    for (const k of SELF_CONTAINED) { const v = s[k]; if (v != null) { sums[k].n += 1; sums[k].sum += v } }
    const pair = lossSizeInputs(t)
    if (pair) losses.push(pair)
  }
  return {
    atr_stop: target,
    kept: sums.kept, stopRespected: sums.stopRespected, stopSize: sums.stopSize, runner: sums.runner,
    losses,
  }
}
type SelfContainedKey = Exclude<ExitFactorKey, 'lossSize'>
const SELF_CONTAINED: readonly SelfContainedKey[] = ['kept', 'stopRespected', 'stopSize', 'runner']

/** A day's full Exit sums, with "Loss size" scored against `avgRiskDollars`
 *  (null = no average; each loss falls back to its own planned risk). */
export function dayExitSums(stored: DayExitStored | null | undefined, avgRiskDollars: number | null): ExitSums | null {
  if (!stored) return null
  const sums = emptyExitSums()
  for (const k of SELF_CONTAINED) {
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

/** One day's Exit, read in sequence. */
export interface DayExit {
  /** The average dollar risk "Loss size" was measured against (null = none yet). */
  avgRiskDollars: number | null
  /** Sums + counts per factor — what a period pools. Null when the day carries no Exit inputs. */
  sums: ExitSums | null
  /** The day's Exit score, 0..100 unrounded; null when no factor had a trade to judge. */
  score: number | null
}

/**
 * Read a set of days in sequence: each day's average risk comes from the days
 * before it — the other days passed here plus `history` (earlier days the
 * caller loaded only for this purpose). A date present in both counts once,
 * from `days`. Returns one entry per input day, in input order.
 */
export function exitInSequence<T extends RiskDay & { exit?: DayExitStored | null }>(
  days: readonly T[],
  history: readonly RiskDay[] = [],
): DayExit[] {
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
    const sums = dayExitSums(d.exit, avgRiskDollars)
    return { avgRiskDollars, sums, score: sums ? exitScoreView(sums).score : null }
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

// ── Showing why ───────────────────────────────────────────────────────────

/** What the Exit axis is made of, in one phrase — for the places that describe the axis. */
export const EXIT_AXIS_DESC = EXIT_FACTORS.map(k => EXIT_LABELS[k].toLowerCase()).join(', ')

export interface ExitFactorLine {
  key: ExitFactorKey
  label: string
  /** 0..100 rounded; null = no trade to judge. */
  score: number | null
  /** How many trades the factor judged. */
  n: number
  /** "81 · 12 trades" / "not applicable". */
  detail: string
}

/** The five factors behind an Exit number, in order, ready to print. */
export function exitFactorLines(factors: ExitScoreView['factors'] | null | undefined): ExitFactorLine[] {
  return EXIT_FACTORS.map(key => {
    const f = factors?.[key]
    const n = f?.n ?? 0
    const score = f?.score != null && n > 0 ? Math.round(f.score) : null
    return {
      key,
      label: EXIT_LABELS[key],
      score,
      n,
      detail: score != null ? `${score} · ${n} trade${n === 1 ? '' : 's'}` : 'not applicable',
    }
  })
}

/** The same five lines as hover text, one per line, under a heading. */
export function exitFactorsTooltip(heading: string, factors: ExitScoreView['factors'] | null | undefined): string {
  return [heading, ...exitFactorLines(factors).map(l => `${l.label}: ${l.detail}`)].join('\n')
}
