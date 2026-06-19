/**
 * Pivot-based market structure (HH/HL vs LH/LL) — a faithful TypeScript port of
 * the `market_structure.py` used in the trader's follow/fade study.
 *
 * Definitions (all on 5-minute CLOSE prices):
 *   - A bar i is a swing HIGH if its close is the STRICT max of the window
 *     close[i-K .. i+K] (K=4); a swing LOW if the strict min. "Strict" = ties
 *     (the close appears more than once in the window) do not count as a pivot.
 *   - A pivot is only CONFIRMED at bar i+K — the K bars after it must exist. So
 *     evaluating structure at bar T uses only pivots with confirm_idx ≤ T
 *     (no lookahead). i+K confirmation means the forming bar's structure is
 *     always K bars (20 min at 5m) stale — that is deliberate and non-repainting.
 *   - Confirmed pivots collapse into an alternating zig-zag (H,L,H,L…): on a run
 *     of same-type pivots, keep the more extreme one.
 *   - From the last two highs and last two lows of the zig-zag:
 *       bull  = higher-high AND higher-low (HH + HL)
 *       bear  = lower-high  AND lower-low  (LH + LL)
 *       neutral = mixed (HH+LL expansion, or LH+HL contraction)
 *       insufficient = fewer than 2 highs and 2 lows confirmed
 *
 * `seg` is a per-bar roll-segment id so a pivot window never straddles a
 * contract roll and the zig-zag resets at each roll. For a single continuous
 * back-adjusted series, pass a constant seg (e.g. all zeros).
 *
 * K is the one knob: K=4 on 5m ≈ intraday swing degree (the whole study used 4).
 * Larger K = fewer, bigger swings; smaller = noisier.
 */

export type Regime = 'bull' | 'bear' | 'neutral' | 'insufficient'
export type PivotType = 'H' | 'L'

export interface Pivot {
  /** Bar index of the pivot. */
  i: number
  type: PivotType
  price: number
  /** Bar index at which the pivot becomes known (i + K). */
  confirmIdx: number
}

/**
 * Detect confirmed fractal pivots over a close series, returned sorted by
 * confirmation bar (== chronological, since confirmIdx = i + K with K constant).
 * Mirrors the Python `find_pivots` exactly, including the strict-extreme guard
 * and the roll-segment check.
 */
export function findPivots(closes: number[], seg: number[], K = 4): Pivot[] {
  const n = closes.length
  const pivots: Pivot[] = []
  for (let i = K; i < n - K; i++) {
    if (seg[i - K] !== seg[i + K]) continue // don't let a pivot window span a roll
    const c = closes[i]
    let max = -Infinity, min = Infinity, countC = 0
    for (let j = i - K; j <= i + K; j++) {
      const v = closes[j]
      if (v > max) max = v
      if (v < min) min = v
      if (v === c) countC++
    }
    if (c === max && countC === 1) pivots.push({ i, type: 'H', price: c, confirmIdx: i + K })
    else if (c === min && countC === 1) pivots.push({ i, type: 'L', price: c, confirmIdx: i + K })
  }
  pivots.sort((a, b) => a.confirmIdx - b.confirmIdx)
  return pivots
}

/** Binary search: count of pivots whose confirmIdx ≤ T (bisect_right on the
 *  ascending confirmIdx list). */
function knownByBar(confirmIdx: number[], T: number): number {
  let lo = 0, hi = confirmIdx.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (confirmIdx[mid] <= T) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Market-structure regime at bar T, using only pivots confirmed by T and only
 * those in the same roll segment as T. Faithful port of Python `structure_at`.
 */
export function structureAt(
  pivots: Pivot[],
  confirmIdx: number[],
  seg: number[],
  T: number,
): Regime {
  const k = knownByBar(confirmIdx, T)
  const segT = seg[T]
  const cleaned: Array<{ type: PivotType; price: number }> = []
  for (let j = 0; j < k; j++) {
    const p = pivots[j]
    if (seg[p.i] !== segT) continue
    const last = cleaned[cleaned.length - 1]
    if (last && last.type === p.type) {
      // Consecutive same-type pivot → keep the more extreme one.
      if ((p.type === 'H' && p.price > last.price) || (p.type === 'L' && p.price < last.price)) {
        last.price = p.price
      }
    } else {
      cleaned.push({ type: p.type, price: p.price })
    }
  }
  const highs = cleaned.filter(c => c.type === 'H').map(c => c.price)
  const lows = cleaned.filter(c => c.type === 'L').map(c => c.price)
  if (highs.length >= 2 && lows.length >= 2) {
    const HH = highs[highs.length - 1] > highs[highs.length - 2]
    const HL = lows[lows.length - 1] > lows[lows.length - 2]
    const LH = highs[highs.length - 1] < highs[highs.length - 2]
    const LL = lows[lows.length - 1] < lows[lows.length - 2]
    if (HH && HL) return 'bull'
    if (LH && LL) return 'bear'
    return 'neutral'
  }
  return 'insufficient'
}

/**
 * Compute the regime at every bar in one pass (mirrors the Python
 * `structure_series`). Useful for tagging a whole dataset; per-trade callers can
 * use `structureAt` directly. O(n · avg-zigzag-length).
 */
export function structureSeries(closes: number[], seg: number[], K = 4): Regime[] {
  const pivots = findPivots(closes, seg, K)
  const confirmIdx = pivots.map(p => p.confirmIdx)
  const out: Regime[] = new Array(closes.length)
  for (let T = 0; T < closes.length; T++) out[T] = structureAt(pivots, confirmIdx, seg, T)
  return out
}

export type FollowFade = 'follow' | 'fade' | 'neutral_struct' | 'no_struct'

/**
 * Compare a trade's side to the structure regime at entry → follow / fade.
 * long+bull or short+bear = following the trend; long+bear or short+bull =
 * fading it; neutral / insufficient are not counted as follow/fade.
 */
export function followFade(side: 'long' | 'short', regime: Regime): FollowFade {
  if (regime === 'bull' || regime === 'bear') {
    const withTrend = (side === 'long' && regime === 'bull') || (side === 'short' && regime === 'bear')
    return withTrend ? 'follow' : 'fade'
  }
  return regime === 'neutral' ? 'neutral_struct' : 'no_struct'
}
