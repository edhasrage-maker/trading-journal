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

import { MULTIPLIERS, symbolRoot } from './futures-symbols'
import { anchorExcursionToFills } from './excursion-guard'

/**
 * Favorable-excursion bar a trade must clear to count as "was up" for the
 * round-trip / gave-it-back check: it must have run at least this many ×ATR
 * (1m Wilder-10, at entry) in its favor before reversing.
 *
 * ATR-ONLY by design — R is deliberately NOT used. For a 2R trader "up 1R then
 * reversed" is just a trade that never reached target (didn't work out), not a
 * winner handed back; whereas 1×ATR of favorable movement is a real, size- and
 * target-independent move that was given back. (User decision, Pt 5.)
 *
 * This is only the DEFAULT — each trader sets their own multiple in Settings →
 * ATR measurement (`trader_profile.give_back_atr`); callers thread it in via the
 * `roundTripAtr` arg below.
 *
 * DISTINCT from `isGiveBackTrade()` in analytics.ts, which is a per-trade UI
 * bold (loss-only, 1R, stop-required). This layer is the day/window AGGREGATE
 * signal — ≤ breakeven (includes scratches), ATR-based, stop-independent.
 */
const ROUND_TRIP_MFE_ATR = 1

/**
 * Dollar-per-point multiplier for a contract symbol (front-month/root aware).
 * Backed by the canonical `MULTIPLIERS` table (same source the P&L importer
 * uses) so the coach's R-multiples/capture-$ match the trade's booked P&L across
 * the full CME/CBOT/NYMEX/COMEX board (minis + micros).
 *
 * Returns `null` for a genuinely unknown symbol — callers must degrade to
 * points/×ATR rather than emit a confident-but-wrong $1/point figure. (Was
 * previously a 4-symbol table that silently defaulted every other instrument to
 * $1/point, corrupting R / capture% / left-$ / give-back for YM/RTY/CL/GC/6E…)
 */
export function symbolMultiplier(s: string | null): number | null {
  if (!s) return null
  return MULTIPLIERS[symbolRoot(s)] ?? null
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
  /** Closing fill. Optional — used only to anchor the traded range, which the
   *  exit price belongs inside as much as the entry does. */
  exit_price?: number | null
  /** Scaling-aware best-case $ (peak per leg). Optional — callers without the
   *  backfill column (e.g. the EOD trades select) omit it, and the tick-precise
   *  full-position ceiling is used instead. */
  mfe_dollars_per_leg?: number | null
  /** ATR-10 (1m) at entry. Optional — enables volatility-normalized (×ATR)
   *  excursion. Null/absent → the ×ATR fields come back null. */
  entry_atr_1m?: number | null
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
  /** Favorable excursion in points (best in-trade move in the trade's favor).
   *  Covers ~all trades (no stop needed) — the points twin of mfeUsd. */
  mfePts: number | null
  /** Favorable excursion in ATR units (mfePts ÷ entry ATR). Null without ATR.
   *  NOTE: ×ATR is size-agnostic; a big ×ATR capture on small size can be small
   *  $, and a smaller ×ATR capture on big size more $. Read ×ATR next to $, not
   *  instead of it. */
  mfeAtr: number | null
  /** Heat taken in ATR units (maePts ÷ entry ATR). Null without ATR. */
  maeAtr: number | null
  /** Whether "was the trade up ≥ threshold" is even measurable (had ATR or a
   *  stop). Lets the aggregate report an honest denominator ("N of M evaluable"). */
  roundTripMeasurable: boolean
  /** True when the trade was up ≥1×ATR (or ≥1R without ATR) AND closed ≤ BE —
   *  a real winner round-tripped to break-even or worse. */
  roundTripped: boolean
  /** $ handed back from the favorable peak to the exit on a round-trip
   *  (mfeUsd − pnl, floored at 0). Null unless `roundTripped`. */
  roundTripGiveBackUsd: number | null
}

/**
 * Compute the interpreted excursion metrics for one trade. Pure — no I/O.
 * Mirrors the per-trade block that used to live inline in buildCoachContext.
 */
export function interpretExcursion(t: TradeExcursionInput, roundTripAtr: number = ROUND_TRIP_MFE_ATR): TradeExcursion {
  const pnl = t.pnl ?? 0
  const isWin = pnl > 0
  // null for an unknown instrument → every $-denominated metric below is skipped
  // (points and ×ATR still populate). Never fabricate $1/point dollars.
  const mult = symbolMultiplier(t.symbol)
  const stopDist = (t.entry_price != null && t.stop_price != null)
    ? Math.abs(t.entry_price - t.stop_price)
    : null
  const r = (mult != null && stopDist && t.quantity) ? pnl / (stopDist * t.quantity * mult) : null

  // Anchor the traded range to the trade's own fills before measuring off it —
  // the same rule analytics.mfeMaePoints applies, so the coach's excursion and
  // the dashboard's can never disagree about the same trade. A feed that starts
  // recording just after the entry tick otherwise leaves a long's high sitting
  // below its entry.
  const range = (t.high_during_position != null && t.low_during_position != null)
    ? anchorExcursionToFills(t.high_during_position, t.low_during_position, t.entry_price, t.exit_price)
    : null

  // Favorable excursion in points — the best in-trade move in the trade's favor.
  // Computed once (no stop needed) and reused for $, R, and ×ATR below.
  let mfePts: number | null = null
  if (t.entry_price != null && t.direction && range) {
    mfePts = t.direction === 'short'
      ? Math.max(0, t.entry_price - range.low)
      : Math.max(0, range.high - t.entry_price)
  }

  // Dollar-basis best case (primary; no stop needed). Clamp the per-leg MFE-$ at
  // the tick-precise full-position ceiling (favorable extreme × qty × mult).
  // Unknown instrument (mult == null) → no $ figure at all (a backfilled
  // mfe_dollars_per_leg for such a symbol is itself untrustworthy $1/point).
  let mfeUsd: number | null = null
  if (mult != null) {
    mfeUsd = t.mfe_dollars_per_leg ?? null
    if (mfePts != null && t.quantity != null) {
      const ceiling = mfePts * t.quantity * mult
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
  const mfeR = (mfePts != null && stopDist && stopDist > 0) ? mfePts / stopDist : null

  // MAE / heat taken (adverse excursion in points; % needs a stop).
  let maePts: number | null = null
  if (t.entry_price != null && t.direction && range) {
    maePts = t.direction === 'short'
      ? Math.max(0, range.high - t.entry_price)
      : Math.max(0, t.entry_price - range.low)
  }
  const maePct = (maePts != null && stopDist && stopDist > 0) ? maePts / stopDist : null

  // Volatility-normalized (×ATR) — the third unit. Lets $ / points / ×ATR be
  // compared so size can be pulled apart (big ×ATR ≠ big $ when size is small).
  const atr = t.entry_atr_1m
  const mfeAtr = (atr != null && atr > 0 && mfePts != null) ? mfePts / atr : null
  const maeAtr = (atr != null && atr > 0 && maePts != null) ? maePts / atr : null

  // Round-trip / "gave it back": did the trade run ≥ `roundTripAtr`×ATR in its
  // favor then close ≤ breakeven? ATR-only — R is intentionally not used (see
  // ROUND_TRIP_MFE_ATR). rtMet === null means no usable ATR → can't tell.
  const rtMet = mfeAtr != null ? mfeAtr >= roundTripAtr : null
  const roundTripMeasurable = rtMet != null
  const roundTripped = rtMet === true && t.pnl != null && pnl <= 0
  const roundTripGiveBackUsd = (roundTripped && mfeUsd != null) ? Math.max(0, mfeUsd - pnl) : null

  return { isWin, stopDist, r, mfeUsd, capPct, leftUsd, mfeR, maePts, maePct, mfePts, mfeAtr, maeAtr, roundTripMeasurable, roundTripped, roundTripGiveBackUsd }
}

/** Window/day-level round-trip ("gave it back") rollup. */
export interface RoundTripStats {
  /** N — trades that were up ≥ threshold then closed ≤ BE. */
  count: number
  /** M — total trades passed in (the day/window's trade count). */
  total: number
  /** Trades where "was up" was evaluable (had ATR or a stop) — honest denominator. */
  measurable: number
  /** Σ peak-to-exit give-back ($) across the round-trips. */
  giveBackUsd: number
  /** The ×ATR multiple used to classify "was up" — echoed so callers can render
   *  "≥N×ATR" without re-plumbing the trader's setting. */
  thresholdAtr: number
}

/**
 * Aggregate the round-trip signal across a set of trades. Pure — no I/O. Runs
 * `interpretExcursion` per trade, optionally overriding each trade's entry ATR
 * with a live ATR from `atrByTradeId` (mirrors `avgMfeMaeAtr` in analytics.ts so
 * the EOD ×ATR panel and this line agree on which ATR they used). `roundTripAtr`
 * is the trader's own "was up" multiple (Settings → ATR measurement; default 1×).
 */
export function aggregateRoundTrips(
  trades: (TradeExcursionInput & { id?: string | null })[],
  atrByTradeId?: Record<string, number>,
  roundTripAtr: number = ROUND_TRIP_MFE_ATR,
): RoundTripStats {
  let count = 0, measurable = 0, giveBackUsd = 0
  for (const t of trades) {
    const live = t.id != null ? atrByTradeId?.[t.id] : undefined
    const x = interpretExcursion(live != null ? { ...t, entry_atr_1m: live } : t, roundTripAtr)
    if (x.roundTripMeasurable) measurable++
    if (x.roundTripped) { count++; giveBackUsd += x.roundTripGiveBackUsd ?? 0 }
  }
  return { count, total: trades.length, measurable, giveBackUsd, thresholdAtr: roundTripAtr }
}
