/**
 * Break-and-Retest classifier.
 *
 * For a trade tagged "break and retest" (or any close-word variant), decide
 * whether the price action leading into the entry was a *true* break-and-retest
 * — price crossed a key level, then returned to retest it from the broken side
 * before continuation in the broken direction — or one of several look-alikes:
 *
 *   TRUE_BREAK_RETEST    Level broken, retested, trade direction matches the break.
 *                        e.g. price under PDH all morning → closes above PDH → pulls
 *                        back to PDH from above → long entered at PDH.
 *
 *   REJECTION_OFF_LEVEL  Price approached the level but NEVER broke it; trade
 *                        direction is AWAY from the level (level acted as S/R).
 *                        e.g. price under PDH all morning → rallies up to PDH →
 *                        rejects → short entered just below PDH. This is the
 *                        case the user wants separated from true B&R.
 *
 *   BREAK_NO_RETEST      Level was broken but price never returned close enough
 *                        to call it a retest before entry. Often a chase entry.
 *
 *   REVERSAL_AFTER_BREAK Level was broken AND retested, but trade direction is
 *                        AGAINST the break. The trader faded a failed breakout.
 *
 *   NO_NEARBY_LEVEL      Entry isn't within proximity of any known key level.
 *                        Tag likely refers to a level we don't track (a manually
 *                        drawn S/R, VAH/VAL, etc.).
 *
 *   AMBIGUOUS            Level was approached, never broken, but trade direction
 *                        is toward the level (rare — usually means proximity too
 *                        loose or the trade was actually at a different level).
 *
 * The classifier is pure: pass it bars, levels and a trade, get back a verdict
 * plus the anchor level it picked and the moment of the break (if any). Build
 * the bars + level inputs upstream from ohlcv_bars + computeSessionLevels().
 */

import type { RawBar, SessionLevels, LevelSeriesPoint } from '../session-levels'

export type BreakRetestVerdict =
  | 'TRUE_BREAK_RETEST'
  | 'REJECTION_OFF_LEVEL'
  | 'BREAK_NO_RETEST'
  | 'REVERSAL_AFTER_BREAK'
  | 'NO_NEARBY_LEVEL'
  | 'AMBIGUOUS'

export interface BreakRetestConfig {
  /** Max distance (points) from entry to a level to consider that level the anchor. */
  proximityPoints: number
  /** Cross magnitude (points) past the level required to call it "broken". A 1-min bar
   *  must CLOSE on the far side beyond this buffer. Filters out wick-only pokes. */
  breakBufferPoints: number
  /** After a break, how close (points) price must return to the level to call it a retest. */
  retestProximityPoints: number
}

export const DEFAULT_BR_CONFIG: BreakRetestConfig = {
  proximityPoints: 5,
  breakBufferPoints: 2,
  retestProximityPoints: 3,
}

export interface ClassifierTrade {
  entryTime: string         // ISO-8601
  entryPrice: number
  direction: 'long' | 'short'
}

export interface CandidateLevel {
  name: string              // 'PDH', 'IBH', 'VWAP@entry', etc.
  value: number
}

export interface ClassifierResult {
  verdict: BreakRetestVerdict
  /** The level the classifier anchored its judgment to (null when NO_NEARBY_LEVEL). */
  anchor: CandidateLevel | null
  /** Distance from entry to anchor in points (signed: positive = entry above anchor). */
  distanceFromAnchor: number | null
  /** When the level was crossed (ISO ts of the first closing bar past the buffer). Null if never broken. */
  breakAt: string | null
  /** Direction of the break: 'up' = price moved from below→above, 'down' = above→below. */
  breakDirection: 'up' | 'down' | null
  /** When price returned to within retestProximityPoints of the level, after the break. Null otherwise. */
  retestAt: string | null
  /** Plain-English reasoning string — surface this in the UI so the verdict is auditable. */
  reasoning: string
}

/**
 * Build the candidate-level list for a trade: every named static level from
 * computeSessionLevels(), plus VWAP at entry (looked up in `series` by the
 * nearest series point at or before entryTime).
 */
export function candidateLevelsAtEntry(
  levels: SessionLevels,
  series: LevelSeriesPoint[],
  entryTime: string,
): CandidateLevel[] {
  const out: CandidateLevel[] = []
  const push = (name: string, value: number | null) => {
    if (value != null && Number.isFinite(value)) out.push({ name, value })
  }
  push('PDH', levels.pdh)
  push('PDL', levels.pdl)
  push('PDH (full)', levels.pdhFull)
  push('PDL (full)', levels.pdlFull)
  push('ONH', levels.onh)
  push('ONL', levels.onl)
  push('IBH', levels.ibh)
  push('IBL', levels.ibl)
  push('RTH Open', levels.rthOpen)
  push('Weekly Open', levels.weeklyOpen)
  if (levels.ibhExt) {
    levels.ibhExt.forEach((v, i) => push(`IBH +${[25, 50, 100][i]}%`, v))
  }
  if (levels.iblExt) {
    levels.iblExt.forEach((v, i) => push(`IBL -${[25, 50, 100][i]}%`, v))
  }

  // VWAP at entry — pick the last series point at or before entryTime.
  const entryMs = Date.parse(entryTime)
  let vwap: number | null = null
  for (const p of series) {
    const pMs = Date.parse(p.ts)
    if (pMs > entryMs) break
    if (p.vwap != null) vwap = p.vwap
  }
  push('VWAP @ entry', vwap)
  return out
}

/**
 * Pick the level closest to entryPrice within `proximityPoints`. If multiple
 * levels are within proximity, the closest wins. Returns the level + signed
 * distance (entryPrice - level.value).
 */
export function pickAnchor(
  entryPrice: number,
  candidates: CandidateLevel[],
  proximityPoints: number,
): { anchor: CandidateLevel; distance: number } | null {
  let best: { anchor: CandidateLevel; distance: number } | null = null
  for (const c of candidates) {
    const dist = entryPrice - c.value
    if (Math.abs(dist) > proximityPoints) continue
    if (!best || Math.abs(dist) < Math.abs(best.distance)) {
      best = { anchor: c, distance: dist }
    }
  }
  return best
}

/**
 * Core verdict logic. Bars must cover the lookback window (prior day's ETH
 * open through entry time, or wider — anything outside the entry timestamp is
 * ignored). Bars should be 1-minute, ascending by ts.
 */
export function classifyBreakRetest(
  trade: ClassifierTrade,
  bars: RawBar[],
  levels: SessionLevels,
  series: LevelSeriesPoint[],
  config: BreakRetestConfig = DEFAULT_BR_CONFIG,
): ClassifierResult {
  const entryMs = Date.parse(trade.entryTime)
  const lookback = bars.filter(b => {
    const ms = Date.parse(b.ts)
    return ms <= entryMs
  })

  const candidates = candidateLevelsAtEntry(levels, series, trade.entryTime)
  const picked = pickAnchor(trade.entryPrice, candidates, config.proximityPoints)

  if (!picked) {
    return {
      verdict: 'NO_NEARBY_LEVEL',
      anchor: null,
      distanceFromAnchor: null,
      breakAt: null,
      breakDirection: null,
      retestAt: null,
      reasoning: `Entry @ ${trade.entryPrice.toFixed(2)} is not within ${config.proximityPoints}pt of any tracked level.`,
    }
  }

  const { anchor, distance } = picked
  const L = anchor.value

  // Determine starting side from the EARLIEST lookback bar with finite data.
  if (lookback.length === 0) {
    return {
      verdict: 'NO_NEARBY_LEVEL',
      anchor,
      distanceFromAnchor: distance,
      breakAt: null,
      breakDirection: null,
      retestAt: null,
      reasoning: `No bars available before entry — cannot classify.`,
    }
  }
  const first = lookback[0]
  const startMid = (first.high + first.low) / 2
  const startedAbove = startMid > L

  // Scan for the first closing-bar break past the buffer.
  let breakAt: string | null = null
  let breakDirection: 'up' | 'down' | null = null
  let breakIdx = -1
  for (let i = 0; i < lookback.length; i++) {
    const b = lookback[i]
    if (startedAbove && b.close < L - config.breakBufferPoints) {
      breakAt = b.ts
      breakDirection = 'down'
      breakIdx = i
      break
    }
    if (!startedAbove && b.close > L + config.breakBufferPoints) {
      breakAt = b.ts
      breakDirection = 'up'
      breakIdx = i
      break
    }
  }

  const sideStr = trade.direction === 'long' ? 'long' : 'short'
  const levelLabel = `${anchor.name} (${L.toFixed(2)})`

  if (breakAt && breakDirection) {
    // Look for a retest AFTER the break: any bar whose price range comes within
    // retestProximityPoints of L.
    let retestAt: string | null = null
    for (let i = breakIdx + 1; i < lookback.length; i++) {
      const b = lookback[i]
      const nearest = Math.min(Math.abs(b.high - L), Math.abs(b.low - L), Math.abs(b.close - L))
      if (nearest <= config.retestProximityPoints) {
        retestAt = b.ts
        break
      }
    }

    // True B&R direction match: trade direction equals the broken direction.
    const directionMatchesBreak =
      (breakDirection === 'up' && trade.direction === 'long') ||
      (breakDirection === 'down' && trade.direction === 'short')

    if (retestAt && directionMatchesBreak) {
      return {
        verdict: 'TRUE_BREAK_RETEST',
        anchor,
        distanceFromAnchor: distance,
        breakAt,
        breakDirection,
        retestAt,
        reasoning:
          `${levelLabel} broke ${breakDirection} at ${fmtTime(breakAt)} (closed past buffer), ` +
          `retested at ${fmtTime(retestAt)}, ${sideStr} entry matches break direction.`,
      }
    }
    if (retestAt && !directionMatchesBreak) {
      return {
        verdict: 'REVERSAL_AFTER_BREAK',
        anchor,
        distanceFromAnchor: distance,
        breakAt,
        breakDirection,
        retestAt,
        reasoning:
          `${levelLabel} broke ${breakDirection} at ${fmtTime(breakAt)} and retested at ${fmtTime(retestAt)}, ` +
          `but ${sideStr} entry FADES the break (failed breakout play, not a true B&R).`,
      }
    }
    return {
      verdict: 'BREAK_NO_RETEST',
      anchor,
      distanceFromAnchor: distance,
      breakAt,
      breakDirection,
      retestAt: null,
      reasoning:
        `${levelLabel} broke ${breakDirection} at ${fmtTime(breakAt)} but price never came back within ` +
        `${config.retestProximityPoints}pt before entry — likely a chase/late entry, not a retest.`,
    }
  }

  // Never broken: pure approach. Rejection direction = AWAY from the level.
  // If price came up from below to the level → rejection means trade SHORTS off it.
  // If price came down from above to the level → rejection means trade LONGS off it.
  const rejectionDirectionMatch =
    (!startedAbove && trade.direction === 'short') ||  // approached from below, short at resistance
    (startedAbove && trade.direction === 'long')       // approached from above, long off support

  if (rejectionDirectionMatch) {
    return {
      verdict: 'REJECTION_OFF_LEVEL',
      anchor,
      distanceFromAnchor: distance,
      breakAt: null,
      breakDirection: null,
      retestAt: null,
      reasoning:
        `${levelLabel} was never broken in the lookback (price stayed ${startedAbove ? 'above' : 'below'}). ` +
        `${sideStr} entry off the level = rejection, NOT a true break-and-retest.`,
    }
  }
  return {
    verdict: 'AMBIGUOUS',
    anchor,
    distanceFromAnchor: distance,
    breakAt: null,
    breakDirection: null,
    retestAt: null,
    reasoning:
      `${levelLabel} was never broken (price stayed ${startedAbove ? 'above' : 'below'}), and ${sideStr} ` +
      `entry doesn't match a clean rejection pattern. Tag may refer to a different level.`,
  }
}

function fmtTime(iso: string): string {
  // Compact HH:MM PT for the reasoning string.
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}
