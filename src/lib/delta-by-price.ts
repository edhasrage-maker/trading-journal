import type { DeltaRow, DeltaBar } from './scid-delta'

/**
 * Delta-by-price level detector — PURE. No fs, no network, no clock.
 * `scid-delta.ts` produces the rows and bars; everything here is arithmetic on
 * them, so the whole thing is unit-testable from synthetic fixtures.
 *
 * The detector answers one question: which price rows saw aggressive volume
 * large enough to matter, and did the aggressor get what they paid for?
 *
 * THREE INPUTS, AND NONE OF THEM IS A FIXED CONSTANT — that is the design:
 *
 *  1. ROW HEIGHT (`scid-delta.ts`) — 1 point on ES, ~5 on NQ. Set by what the
 *     chart draws, not by the instrument's tick.
 *
 *  2. A SESSION-RELATIVE THRESHOLD — the p99 of this session's own row |delta|.
 *     A hardcoded number cannot work: 1,200 contracts in a row was the single
 *     largest print of 2026-07-28 and would be unremarkable on a heavy day.
 *     Significance is "large FOR TODAY", so the threshold is re-derived per
 *     session from the distribution the session actually produced.
 *
 *  3. A DID-PRICE-HOLD-AFTER CHECK — without it, a big red row is just a big
 *     red row. Heavy selling that price refuses to follow is ABSORPTION (the
 *     other side ate it); the identical delta with price breaking through is
 *     CONTINUATION (the aggressor was right). Same number, opposite meaning,
 *     and only the follow-through separates them.
 *
 * Percentiles are the LOWER quantile — `floor(p × (n−1))` into the ascending
 * array — never interpolated. Two reasons, and the second one is not cosmetic:
 *
 *   - The threshold is always a delta some row in this session genuinely
 *     printed, so the cutoff is explainable ("as big as the 2nd-largest row")
 *     rather than a synthetic value between two observations.
 *
 *   - Textbook nearest-rank (`ceil(p × n)`) DEGENERATES HERE. A session bins to
 *     roughly 60–90 price rows, and for any n ≤ 100 the p99 of nearest-rank is
 *     always the single largest row. That makes the threshold exactly "the
 *     biggest row of the day", which by construction detects one level and can
 *     never detect two. Measured on the ESU6 fixture: nearest-rank put p99 at
 *     1,949 (the max) and found one level; the lower quantile puts it at 1,209
 *     and finds the level the session was actually about.
 */

/** Aggressive side that dominated a row. */
export type DeltaSide = 'buy' | 'sell'

/**
 * What happened to price after the row traded.
 *  - `absorption`   — the aggressor did NOT get follow-through; price held.
 *  - `continuation` — price broke through in the aggressor's direction.
 *  - `unresolved`   — not enough price history after the row to judge (the row
 *                     traded at the very end of the window). Never guessed.
 */
export type DeltaLevelKind = 'absorption' | 'continuation' | 'unresolved'

export interface RowDeltaStats {
  /** Number of rows that traded. */
  count: number
  /** Percentiles of row |delta| across the session. */
  median: number
  p90: number
  p99: number
  max: number
}

export interface DetectedDeltaLevel {
  /** Low edge of the row. */
  price: number
  /** Signed delta of the row. */
  delta: number
  volume: number
  side: DeltaSide
  kind: DeltaLevelKind
  /** |delta| ÷ threshold. 1.0 sits exactly on the cutoff. */
  strength: number
  /** Share of session volume that traded in this row, 0..1. */
  volumeShare: number
  /** Last trade time in the row (ms) — the anchor for the hold check. */
  lastMs: number
  /**
   * How far price traveled IN THE AGGRESSOR'S DIRECTION beyond the row within
   * the hold window, in price units. Negative means it never got past the row.
   */
  followThrough: number
}

export interface DetectorConfig {
  /** Row height used to bin the rows, in price units. Must match the reader. */
  rowHeight: number
  /** Percentile of row |delta| that defines significance. Default 0.99. */
  thresholdPercentile?: number
  /**
   * Absolute floor on |delta|, in contracts. Defaults to 0 (off). A thin
   * session's p99 can be small enough that noise clears it; set this when you
   * would rather detect nothing than detect nothing-rows.
   */
  minDelta?: number
  /** How long after the row's last trade to judge follow-through. Default 30 min. */
  holdWindowMs?: number
  /**
   * How far beyond the row price must travel to count as a break, in price
   * units. Below this, price is still effectively at the level.
   */
  breakDistance: number
  /**
   * Minimum bars required after the row before a verdict is given. Fewer than
   * this and the level is `unresolved` rather than assumed absorbed. Default 3.
   */
  minBarsAfter?: number
}

export interface DetectionResult {
  levels: DetectedDeltaLevel[]
  stats: RowDeltaStats
  /** The |delta| cutoff actually used (max of the percentile and `minDelta`). */
  threshold: number
  sessionDelta: number
  sessionVolume: number
}

const EMPTY_STATS: RowDeltaStats = { count: 0, median: 0, p90: 0, p99: 0, max: 0 }

/**
 * Lower quantile of an ASCENDING array — index `floor(p × (n−1))`, no
 * interpolation, so the result is always an observed value. `p` is clamped to
 * [0,1]; p=0 returns the minimum and p=1 the maximum.
 */
export function quantileLower(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length
  if (n === 0) return 0
  const clamped = Math.min(1, Math.max(0, p))
  const idx = Math.min(n - 1, Math.max(0, Math.floor(clamped * (n - 1))))
  return sortedAsc[idx]
}

/** Percentile summary of |delta| across the session's rows. */
export function rowDeltaStats(rows: DeltaRow[]): RowDeltaStats {
  if (rows.length === 0) return { ...EMPTY_STATS }
  const abs = rows.map(r => Math.abs(r.delta)).sort((a, b) => a - b)
  return {
    count: abs.length,
    median: quantileLower(abs, 0.5),
    p90: quantileLower(abs, 0.9),
    p99: quantileLower(abs, 0.99),
    max: abs[abs.length - 1],
  }
}

/**
 * Net delta and volume across a price zone, inclusive of both edges.
 * A zone read is not the same as its biggest row: heavy selling at 7467/7468
 * can be partly offset by buying at 7470, and the zone total is what the
 * trader was actually leaning on.
 */
export function zoneTotal(
  rows: DeltaRow[],
  lowPrice: number,
  highPrice: number,
): { delta: number; volume: number; rows: number } {
  let delta = 0
  let volume = 0
  let count = 0
  for (const r of rows) {
    if (r.price < lowPrice || r.price > highPrice) continue
    delta += r.delta
    volume += r.volume
    count++
  }
  return { delta, volume, rows: count }
}

/**
 * Judge follow-through for one row. Returns the verdict plus how far price got
 * in the aggressor's direction beyond the row edge.
 *
 * For a SELL row the relevant edge is the row's LOW edge and the direction is
 * down; for a BUY row it is the HIGH edge and up. Using the correct edge
 * matters at row heights well above the tick — measuring a buy row's break from
 * its low edge would score a 1-point ES row as broken while price is still
 * inside it.
 */
function judgeHold(
  row: DeltaRow,
  side: DeltaSide,
  bars: DeltaBar[],
  cfg: Required<Pick<DetectorConfig, 'rowHeight' | 'holdWindowMs' | 'breakDistance' | 'minBarsAfter'>>,
): { kind: DeltaLevelKind; followThrough: number } {
  const windowEnd = row.lastMs + cfg.holdWindowMs
  const after = bars.filter(b => b.ts > row.lastMs && b.ts <= windowEnd)
  if (after.length < cfg.minBarsAfter) {
    return { kind: 'unresolved', followThrough: 0 }
  }

  if (side === 'sell') {
    // Aggressive selling at the row. Did price follow them down?
    const lowest = Math.min(...after.map(b => b.low))
    const followThrough = row.price - lowest
    return {
      kind: followThrough > cfg.breakDistance ? 'continuation' : 'absorption',
      followThrough,
    }
  }

  const rowTop = row.price + cfg.rowHeight
  const highest = Math.max(...after.map(b => b.high))
  const followThrough = highest - rowTop
  return {
    kind: followThrough > cfg.breakDistance ? 'continuation' : 'absorption',
    followThrough,
  }
}

/**
 * Detect significant delta rows and classify each one.
 *
 * Rows are ranked by |delta| descending, so the caller reading only the first
 * few gets the session's most meaningful levels. A row whose |delta| ties the
 * threshold exactly is INCLUDED — with nearest-rank percentiles the threshold
 * is itself an observed row, and excluding it would silently drop the very row
 * that defined the cutoff.
 */
export function detectDeltaLevels(
  rows: DeltaRow[],
  bars: DeltaBar[],
  cfg: DetectorConfig,
): DetectionResult {
  const stats = rowDeltaStats(rows)
  const sessionDelta = rows.reduce((s, r) => s + r.delta, 0)
  const sessionVolume = rows.reduce((s, r) => s + r.volume, 0)

  const pct = cfg.thresholdPercentile ?? 0.99
  const threshold = Math.max(quantileLower(
    rows.map(r => Math.abs(r.delta)).sort((a, b) => a - b),
    pct,
  ), cfg.minDelta ?? 0)

  const holdCfg = {
    rowHeight: cfg.rowHeight,
    holdWindowMs: cfg.holdWindowMs ?? 30 * 60_000,
    breakDistance: cfg.breakDistance,
    minBarsAfter: cfg.minBarsAfter ?? 3,
  }

  const levels: DetectedDeltaLevel[] = []
  for (const row of rows) {
    const mag = Math.abs(row.delta)
    // A row with delta exactly 0 is never a level, even if the threshold is 0.
    if (mag === 0 || mag < threshold) continue
    const side: DeltaSide = row.delta < 0 ? 'sell' : 'buy'
    const { kind, followThrough } = judgeHold(row, side, bars, holdCfg)
    levels.push({
      price: row.price,
      delta: row.delta,
      volume: row.volume,
      side,
      kind,
      strength: threshold > 0 ? mag / threshold : 0,
      volumeShare: sessionVolume > 0 ? row.volume / sessionVolume : 0,
      lastMs: row.lastMs,
      followThrough,
    })
  }

  levels.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  return { levels, stats, threshold, sessionDelta, sessionVolume }
}
