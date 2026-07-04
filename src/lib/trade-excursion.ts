/**
 * Per-trade MFE/MAE excursion interpretation — the single source of truth for
 * turning a trade's raw fills + in-position extremes into the INTERPRETED risk
 * signals the AI actually reacts to: R-multiple, $ captured of the favorable
 * move, $ left on the table, and heat taken as a fraction of the planned stop.
 *
 * Extracted out of `buildCoachContext` (src/lib/coach-context.ts) so the coach
 * chat, the weekly recap, AND the video-recap frame commentary all compute
 * these numbers identically — they cannot drift. A neutral "avg MFE 23.5 pts"
 * gets ignored by the model; "captured 34% of the move, left $420 on the table,
 * heat 88% of your stop" does not. Keep that framing wherever this feeds a prompt.
 *
 * The clamps here are load-bearing: `mfe_dollars_per_leg` from an old un-capped
 * backfill can exceed the tick-precise full-position ceiling and would massively
 * inflate "$ left on the table", so we clamp to that ceiling (and, for imported
 * trades that have the extremes but no per-leg backfill, use the ceiling itself).
 */

const SYM_MULT: Record<string, number> = { NQ: 20, MNQ: 2, ES: 50, MES: 5 }

/** Dollar-per-point multiplier for a contract symbol (front-month/root aware). */
export function symbolMultiplier(s: string | null): number {
  if (!s) return 1
  const root = s.replace(/\.[A-Z]+$/, '').replace(/[HMUZ]\d+$/, '')
  return SYM_MULT[root] ?? 1
}

/** Minimal trade shape the interpretation needs. Superset-friendly — pass a
 *  full trade row; only these fields are read. */
export interface TradeExcursionInput {
  direction: 'long' | 'short' | null
  entry_price: number | null
  stop_price: number | null
  pnl: number | null
  quantity: number | null
  symbol: string | null
  high_during_position: number | null
  low_during_position: number | null
  mfe_dollars_per_leg: number | null
}

export interface TradeExcursion {
  isWin: boolean
  /** Entry→stop distance in points (the planned max adverse). null without a stop. */
  stopDist: number | null
  /** Realized R-multiple (pnl ÷ risk). Needs a stop + quantity. */
  r: number | null
  /** Best-case $ if each leg had exited at its in-trade peak, clamped to the
   *  tick-precise full-position ceiling. Covers ~all trades (no stop needed). */
  mfeUsd: number | null
  /** Winners only: share of the available favorable $ actually banked (0-1). */
  capPct: number | null
  /** Winners only: $ given back vs the peak (mfeUsd − pnl, floored at 0). */
  leftUsd: number | null
  /** Favorable excursion in risk units (MFE ÷ stop distance). Needs a stop. */
  mfeR: number | null
  /** Heat taken in points — how far price ran against the trade before it resolved. */
  maePts: number | null
  /** Heat taken as a fraction of the planned stop distance (maePts ÷ stopDist). */
  maePct: number | null
}

/**
 * Compute the interpreted excursion metrics for one trade. Pure — no I/O.
 * Mirrors the per-trade block that used to live inline in buildCoachContext.
 */
export function interpretExcursion(t: TradeExcursionInput): TradeExcursion {
  const pnl = t.pnl ?? 0
  const isWin = pnl > 0
  const mult = symbolMultiplier(t.symbol)
  const stopDist = (t.entry_price != null && t.stop_price != null)
    ? Math.abs(t.entry_price - t.stop_price)
    : null
  const r = (stopDist && t.quantity) ? pnl / (stopDist * t.quantity * mult) : null

  // Dollar-basis best case (primary; no stop needed). Clamp the per-leg MFE-$ at
  // the tick-precise full-position ceiling (favorable extreme × qty × mult).
  let mfeUsd = t.mfe_dollars_per_leg
  if (t.entry_price != null && t.quantity != null) {
    const favPts = t.direction === 'short'
      ? (t.low_during_position != null ? t.entry_price - t.low_during_position : null)
      : (t.high_during_position != null ? t.high_during_position - t.entry_price : null)
    if (favPts != null && favPts >= 0) {
      const ceiling = favPts * t.quantity * mult
      if (mfeUsd == null) mfeUsd = ceiling
      else if (ceiling > 0) mfeUsd = Math.min(mfeUsd, ceiling)
    }
  }
  let capPct: number | null = null
  let leftUsd: number | null = null
  if (isWin && mfeUsd != null && mfeUsd > 0) {
    capPct = Math.min(1, pnl / mfeUsd)
    leftUsd = Math.max(0, mfeUsd - pnl)
  }

  // R-basis reachability (secondary; needs a logged stop).
  let mfeR: number | null = null
  if (stopDist && stopDist > 0 && t.entry_price != null) {
    const mfePts = t.direction === 'short'
      ? (t.low_during_position != null ? t.entry_price - t.low_during_position : null)
      : (t.high_during_position != null ? t.high_during_position - t.entry_price : null)
    if (mfePts != null && mfePts >= 0) mfeR = mfePts / stopDist
  }

  // MAE / heat taken (adverse excursion in points; % needs a stop).
  let maePts: number | null = null
  if (t.entry_price != null && t.direction) {
    maePts = t.direction === 'short'
      ? (t.high_during_position != null ? Math.max(0, t.high_during_position - t.entry_price) : null)
      : (t.low_during_position != null ? Math.max(0, t.entry_price - t.low_during_position) : null)
  }
  const maePct = (maePts != null && stopDist && stopDist > 0) ? maePts / stopDist : null

  return { isWin, stopDist, r, mfeUsd, capPct, leftUsd, mfeR, maePts, maePct }
}
