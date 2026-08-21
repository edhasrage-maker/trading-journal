import { mfeMaePoints, type TradeWithExcursion } from '@/lib/analytics'

/**
 * "How close did it come to your stop before it resolved?" — bucketed against
 * the trader's own history.
 *
 * This replaces the old Entry-efficiency verdict (avg MFE vs avg MAE), which
 * could only ever say one thing: losers are capped by the stop and winners
 * aren't, so MFE > MAE is a property of USING a stop, not of entry timing. It
 * then asserted a cause ("your entry timing is sharp") from a fact that doesn't
 * isolate timing.
 *
 * What varies — and is worth reading — is the WIN RATE at each level of heat.
 * On the owner's book: trades whose MAE stayed inside half the planned risk won
 * 89% of the time; ones that pushed past half won 43%.
 *
 * Two deliberate honesty rules:
 *  1. Trades that REACHED the stop are excluded from the comparison. Reaching
 *     your stop closes the trade as a loss, so a "0% win rate" there is
 *     mechanical, not evidence. They're counted separately for context.
 *  2. Nothing is claimed below MIN_SAMPLE — a thin book gets no line at all
 *     rather than a confident number built on twelve trades.
 *
 * The number itself is NOT new to the UI: the trade table's MAE cell already
 * renders MAE ÷ planned risk (see `maeHeatRatio`). What was missing is whether
 * a given reading is good or bad. That's all this provides.
 */

/** Trades needed before the split is shown at all. */
export const MIN_SAMPLE = 40

/** A trade counts as "reached the stop" at or beyond this share of planned risk.
 *  Slightly over 1.0 because a fill can print a tick through the stop. */
const STOPPED_AT = 0.99

/** The split point: half the distance from entry to stop. */
const HALFWAY = 0.5

export interface HeatBaseline {
  /** Trades that never reached the stop and stayed inside halfway. */
  insideN: number
  /** Win rate (0-100) of those. */
  insideWinPct: number
  /** Trades that never reached the stop but went past halfway. */
  pastN: number
  pastWinPct: number
  /** Trades that reached the stop — reported, never compared. */
  stoppedN: number
  /** insideN + pastN + stoppedN — the measurable sample. */
  measuredN: number
}

type HeatTrade = TradeWithExcursion & { stop_price?: number | null }

/**
 * Compute the split. Returns null when there isn't enough measurable history,
 * or when either side of the comparison is empty (a split needs two sides).
 */
export function computeHeatBaseline(trades: HeatTrade[]): HeatBaseline | null {
  let insideN = 0, insideWins = 0
  let pastN = 0, pastWins = 0
  let stoppedN = 0

  for (const t of trades) {
    if (t.entry_price == null || t.stop_price == null || t.pnl == null) continue
    const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
    if (plannedRiskPts === 0) continue
    const xc = mfeMaePoints(t)
    if (!xc) continue

    const heat = xc.mae / plannedRiskPts
    const won = t.pnl > 0

    if (heat >= STOPPED_AT) { stoppedN++; continue }
    if (heat < HALFWAY) { insideN++; if (won) insideWins++ }
    else { pastN++; if (won) pastWins++ }
  }

  const measuredN = insideN + pastN + stoppedN
  if (measuredN < MIN_SAMPLE) return null
  // A one-sided sample can't support "inside vs past".
  if (insideN === 0 || pastN === 0) return null

  return {
    insideN,
    insideWinPct: Math.round((insideWins / insideN) * 100),
    pastN,
    pastWinPct: Math.round((pastWins / pastN) * 100),
    stoppedN,
    measuredN,
  }
}

/** Where a trade sits on that split. */
export function heatOf(t: HeatTrade): number | null {
  if (t.entry_price == null || t.stop_price == null) return null
  const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
  if (plannedRiskPts === 0) return null
  const xc = mfeMaePoints(t)
  return xc ? xc.mae / plannedRiskPts : null
}

/** Today's own split — what the trader actually did in this session. The
 *  baseline is context for THIS, not the other way round: a line that opens
 *  with a lifetime average and never mentions the session reads as trivia. */
export interface TodayHeat {
  /** Trades with a stop set and excursion data — the ones this can speak to. */
  measurable: number
  /** Worst point stayed inside half the planned risk. */
  inside: number
  /** Past half, but never reached the stop. */
  past: number
  /** Reached the stop. */
  stopped: number
  /** Only set when exactly one trade is measurable, so the copy can name the
   *  exact number instead of a count. */
  singlePct: number | null
}

export function summarizeTodayHeat(trades: HeatTrade[]): TodayHeat | null {
  const heats = trades.map(heatOf).filter((h): h is number => h != null)
  if (heats.length === 0) return null
  return {
    measurable: heats.length,
    inside: heats.filter(h => h < HALFWAY).length,
    past: heats.filter(h => h >= HALFWAY && h < STOPPED_AT).length,
    stopped: heats.filter(h => h >= STOPPED_AT).length,
    singlePct: heats.length === 1 ? heats[0] * 100 : null,
  }
}
