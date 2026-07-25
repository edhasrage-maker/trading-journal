import type { Trade, TradeTags, TradingDay, MarketContext } from '@/lib/supabase/types'
import { symbolToMultiplier } from '@/lib/futures-symbols'

/**
 * Pure aggregation helpers for the Journal + Analytics views.
 * All functions are tree-shakeable and run client-side over already-fetched
 * trades. Designed for ≤ a few thousand trades — fine for a single trader's journal.
 */

export type TradeLike = Pick<Trade,
  'id' | 'pnl' | 'entry_price' | 'stop_price' | 'quantity' | 'direction' | 'entry_time' | 'tags_json' | 'trading_day_id' | 'symbol'
>

/** Same as TradeLike plus the tick-extreme + symbol fields needed for MFE/MAE math. */
export type TradeWithExcursion = TradeLike & Pick<Trade,
  'high_during_position' | 'low_during_position' | 'symbol'
>

/** Trade with trading_day + market_context fields flattened in for easy filtering.
 *  Extends TradeWithExcursion (not just TradeLike) so MFE/MAE math has the
 *  high_during_position / low_during_position fields available. */
export interface TradeWithContext extends TradeWithExcursion {
  date: string
  day_type: string | null    // Legacy single-tag — kept for un-migrated callers
  day_types: string[]        // Multi-select. Combo days surface every tag here.
  // Day-level market_context (inherited; every trade on the day shares these)
  rvol: number | null
  ib_size: number | null
  ib_vs_10d_avg: number | null
  adr: number | null
  atr_1m: number | null
  // Wilder-10 ATR snapshotted at IB close (07:29 PT) — the calibrated basis for
  // the IB regime lens (ib-day-type.ts REGIME_CUTS_WILDER). Stored on
  // market_context; the generated MarketContext type hasn't caught up, so
  // callers widen it in (same pattern as entry_atr_1m).
  atr_at_ib_close: number | null
  // Per-trade entry-time snapshots (backfilled by scripts/backfill-entry-metrics.ts).
  // ATR/RVOL at the minute of entry, no afternoon lookahead. ConditionBuckets
  // prefers these when present, falls back to day-level rvol/atr_1m for
  // trades that haven't been backfilled (e.g. pre-2025).
  entry_atr_1m: number | null
  entry_rvol: number | null
  // Scaling-aware MFE max-possible (sum over legs of leg_qty × leg_window_peak ×
  // multiplier). Populated by scripts/backfill-per-leg-mfe.ts. When present,
  // captureComponents uses this instead of the simple peak × full-qty formula.
  mfe_dollars_per_leg: number | null
  // Pivot market-structure regime at entry (scripts/backfill-structure-regime.ts).
  // follow/fade derives from (direction, regime).
  structure_5m_regime: 'bull' | 'bear' | 'neutral' | 'insufficient' | null
}

export interface DaySummary {
  date: string
  pnl: number              // eod_pnl override OR sum of trades.pnl
  trade_count: number
  wins: number
  losses: number
  day_type: string | null  // Legacy single-tag — kept for callers that haven't migrated yet
  day_types: string[]      // Multi-select; falls back to [day_type] when the DB row only has the legacy column
}

export interface PerformanceStats {
  count: number
  wins: number
  losses: number
  scratches: number
  win_rate: number          // wins / (wins + losses) — scratches excluded
  total_pnl: number
  avg_pnl: number
  avg_winner: number
  avg_loser: number         // negative number
  expectancy: number        // (winRate * avgWinner) + ((1 - winRate) * avgLoser)
  profit_factor: number     // sum_winners / |sum_losers|; Infinity if no losers
  avg_r: number | null      // mean R-multiple across ALL trades with computable R
  /** Mean R-multiple ACROSS WINNERS ONLY (positive R). Null if no winners
   *  had computable R. Powers the "+winner_r / -loser_r" split display
   *  on the analytics Setup Performance table. */
  avg_winner_r: number | null
  /** Mean R-multiple ACROSS LOSERS ONLY (negative R). Null if no losers
   *  had computable R. */
  avg_loser_r: number | null
  r_count: number           // how many trades had a computable R
  avg_capture: number | null  // mean MFE Capture % (only trades with MFE >= 20% of risk)
  capture_count: number       // how many trades had a computable capture
  avg_heat: number | null     // mean MAE Loss ×R (peak adverse / planned stop, in points)
  heat_count: number          // how many trades had a computable loss
}

const ZERO_STATS: PerformanceStats = {
  count: 0, wins: 0, losses: 0, scratches: 0,
  win_rate: 0, total_pnl: 0, avg_pnl: 0,
  avg_winner: 0, avg_loser: 0,
  expectancy: 0, profit_factor: 0,
  avg_r: null, avg_winner_r: null, avg_loser_r: null, r_count: 0,
  avg_capture: null, capture_count: 0,
  avg_heat: null, heat_count: 0,
}

/**
 * R-multiple for a single trade.
 *
 *   R = pnl / risk_in_dollars
 *   risk_in_dollars = |entry − stop| × quantity × contract_multiplier
 *
 * The contract multiplier is crucial: without it, R is off by the multiplier
 * factor (2× for MNQ, 20× for NQ, 50× for ES, etc.) Earlier versions of this
 * helper omitted the multiplier — the previous incorrect formula
 * `pnl / (|entry − stop| × qty)` produced "dollars per point-contract"
 * which is not R. Fixed here so Avg R on the analytics page and all
 * per-row R displays are unit-correct.
 *
 * Returns null when entry/stop/qty/pnl are missing or risk is zero.
 */
export function rMultiple(t: TradeLike, atrAtEntry?: number | null): number | null {
  const ep = t.entry_price, sp = t.stop_price, pnl = t.pnl, qty = t.quantity
  if (ep == null || pnl == null || qty == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  // Planned-stop R (default): realized PnL ÷ the dollar risk implied by the stop.
  if (sp != null) {
    const riskDollars = Math.abs(ep - sp) * qty * mult
    return riskDollars === 0 ? null : pnl / riskDollars
  }
  // No stop AND no TP → measure R in ATR units at entry: R = pnl ÷ (1 ATR × qty ×
  // mult), so +1.5 ATR of profit reads +1.5R and a 2-ATR loss reads −2.0R. A trade
  // that has a TP but no stop still returns null (unchanged). `atrAtEntry` lets a
  // caller pass a user-configured ATR; otherwise the stored 1m-Wilder-10 entry ATR.
  const tp = (t as { tp1_price?: number | null }).tp1_price
  const atr = atrAtEntry ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m
  if (tp == null && atr != null && atr > 0) {
    return pnl / (atr * qty * mult)
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// MFE / MAE — raw excursions + execution-quality ratios.
//
// Both excursions are bounded by entry → final exit (Sierra writes high/low
// during position on closing fills; the importer aggregates max/min across
// multi-leg exits). Post-exit moves never appear here — by design.
//
// Capture ratio asks "of the favorable move I was offered, did I take it?".
// MAE burn asks "did I sit through more risk than my plan budgeted?".
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-contract MFE and MAE in price points (positive magnitudes).
 *   long:  MFE = high − entry,    MAE = entry − low
 *   short: MFE = entry − low,     MAE = high − entry
 * Returns null when entry, direction, or high/low is missing.
 */
export function mfeMaePoints(t: TradeWithExcursion): { mfe: number; mae: number } | null {
  if (t.entry_price == null || t.direction == null) return null
  if (t.high_during_position == null || t.low_during_position == null) return null
  const isLong = t.direction === 'long'
  // Floor both at 0: MFE/MAE are *excursion magnitudes* and are non-negative by
  // definition. A trade that never traded below entry (long) has MAE = 0, not a
  // negative "adverse" move. Without the floor, a never-adverse trade subtracts
  // from the day's MAE average and can cancel out real heat from other trades
  // (e.g. one long whose recorded low sits ABOVE entry contributed −55 pts of
  // "MAE", erasing the day's actual adverse excursion). Same reasoning for MFE.
  const mfe = Math.max(0, isLong
    ? t.high_during_position - t.entry_price
    : t.entry_price - t.low_during_position)
  const mae = Math.max(0, isLong
    ? t.entry_price - t.low_during_position
    : t.high_during_position - t.entry_price)
  return { mfe, mae }
}

/**
 * How far (in ATR units) entry_price may sit OUTSIDE the position's own traded
 * range [low, high] before the excursion is treated as corrupt. The 1-minute
 * bar window can miss the exact entry tick, so a sub-ATR overshoot is normal;
 * beyond this the row is bad data — a mis-read entry_price (e.g. an AI
 * screenshot extraction reading 7582.5 as 7182.5) or an excursion backfilled
 * from the wrong bars. Such a row yields MFE = |extreme − entry| of hundreds of
 * ×ATR, and a single one nukes the day's efficiency average, so we exclude it.
 */
const EXCURSION_ENTRY_TOL_ATR = 2

/**
 * MFE and MAE in ATR units — excursion points ÷ ATR-at-entry. The stop-free unit
 * for the efficiency read ("took 0.4×ATR of heat", "captured 2.1×ATR"). Pass a
 * live ATR via `atrAtEntry`; otherwise falls back to the stored entry_atr_1m.
 * Non-negative (mfeMaePoints floors at 0). Null when excursion or a usable ATR
 * is missing, or when entry_price sits implausibly far outside [low, high]
 * (corrupt row — see EXCURSION_ENTRY_TOL_ATR).
 */
export function mfeMaeAtr(
  t: TradeWithExcursion & { entry_atr_1m?: number | null },
  atrAtEntry?: number | null,
): { mfe: number; mae: number } | null {
  const pts = mfeMaePoints(t)
  if (!pts) return null
  const atr = atrAtEntry ?? t.entry_atr_1m
  if (atr == null || atr <= 0) return null
  // Data-integrity guard: entry_price must sit within the range the position
  // actually traded through. When it doesn't, the excursion is fabricated and
  // can be hundreds of ×ATR — discard rather than let one bad row dominate.
  const { high_during_position: hi, low_during_position: lo, entry_price: e } = t
  if (hi != null && lo != null && e != null && Math.max(e - hi, lo - e) > EXCURSION_ENTRY_TOL_ATR * atr) {
    return null
  }
  return { mfe: pts.mfe / atr, mae: pts.mae / atr }
}

/**
 * Session/period aggregate of MFE and MAE in ATR units — powers the "you take
 * X×ATR of heat to capture Y×ATR" verdict. Averages over trades that have both
 * excursion and a usable ATR. `atrByTradeId` supplies live ATRs; falls back to
 * each trade's entry_atr_1m. Works with or without planned stops (excursion is
 * bar-derived), so it lights up on a fills-only import.
 */
export function avgMfeMaeAtr(
  trades: (TradeWithExcursion & { entry_atr_1m?: number | null })[],
  atrByTradeId?: Record<string, number>,
): { mfe: number | null; mae: number | null; count: number } {
  let sumMfe = 0, sumMae = 0, n = 0
  for (const t of trades) {
    const live = t.id != null ? atrByTradeId?.[t.id] : undefined
    const r = mfeMaeAtr(t, live)
    if (!r) continue
    sumMfe += r.mfe
    sumMae += r.mae
    n++
  }
  if (n === 0) return { mfe: null, mae: null, count: 0 }
  return { mfe: sumMfe / n, mae: sumMae / n, count: n }
}

/**
 * Capture ratio = realized PnL / peak favorable excursion in $.
 *
 * Both sides scale by the symbol multiplier and quantity, so we can express
 * directly as pnl / mfeDollars. Bounded [0, 1] in theory (MFE = max favorable
 * while held; pnl ≤ MFE in $); floating-point may push slightly past 1 on
 * exits at the exact high.
 *
 * Returns null when:
 *   - pnl, quantity, or any MFE input is missing
 *   - MFE ≤ 0 (trade never moved favorably — ratio undefined, not 0)
 *
 * Display tip: multiply by 100 and render as "%".
 */
/**
 * Minimum MFE-to-planned-risk ratio required before captureRatio reports a
 * value. Below this, the trade barely went favorable and the capture ratio
 * is dominated by noise — a +$50 MFE on a -$200 loss becomes "-400% capture"
 * which doesn't mean "gave back a winner," it means "trade went against you
 * almost immediately with a small tick-up at entry." Hide rather than mislead.
 *
 * 0.5R is the chosen floor: the trade has to have made it at least halfway
 * toward a 1:1 reward target before reversing. This aligns the capture
 * calculation more closely with the give-back classifier (which requires 1R,
 * see `isGiveBackTrade`) so a trade with negative capture % is at least in
 * the ballpark of "you had something to give back."
 */
const MIN_MFE_RATIO_FOR_CAPTURE = 0.5

/**
 * Volatility-relative noise floor: MFE must reach at least this fraction of the
 * trade's entry-time ATR before its capture ratio is meaningful. Preferred over
 * the planned-risk floor because a tight-stop trade can clear 0.5R on a move
 * that's tiny in ATR terms (pure noise). Falls back to MIN_MFE_RATIO_FOR_CAPTURE
 * of planned risk when the trade has no entry_atr_1m (GBX / pre-backfill rows).
 */
const MIN_MFE_ATR_RATIO = 0.5

/** True when a trade's MFE clears the noise floor (capture worth computing).
 *  Prefers 0.5×ATR; falls back to 0.5×planned-risk when entry ATR is absent.
 *  entry_atr_1m isn't on the base TradeWithExcursion type (it's an entry-time
 *  snapshot column) so it's widened in locally, same pattern as elsewhere. */
function mfeClearsNoiseFloor(t: TradeWithExcursion & { entry_atr_1m?: number | null }, mfePts: number): boolean {
  const atr = t.entry_atr_1m
  if (atr != null && atr > 0) return mfePts >= atr * MIN_MFE_ATR_RATIO
  const plannedRiskPts = t.entry_price != null && t.stop_price != null
    ? Math.abs(t.entry_price - t.stop_price)
    : 0
  if (plannedRiskPts > 0) return mfePts >= plannedRiskPts * MIN_MFE_RATIO_FOR_CAPTURE
  return true // no ATR and no stop — can't gauge noise, don't filter out
}

/** The two components a capture ratio is built from — PnL on top, peak
 *  favorable move in $ on the bottom. Returned for trades that have all
 *  the inputs to compute it AND pass the MFE noise filter. Aggregating at
 *  the group level (tag rollup, period) requires summing the numerator and
 *  denominator separately and then dividing — see avg_capture in
 *  computeStats. A naive mean-of-per-trade-ratios produces pathological
 *  results when even one losing trade has small mfeDollars (a -$200 loss
 *  with $20 of MFE = -1000% individual ratio, dwarfing every other trade
 *  in a simple mean). */
export interface CaptureComponents {
  pnl: number
  mfeDollars: number
}

/**
 * Bars-free scaling-aware MFE-$ ceiling for a SCALED-OUT trade. Mirrors the
 * intent of perLegMaxDollars() but without 1-minute bars (e.g. overnight/GBX
 * sessions that have no imported bars). The plain `peak × full-qty` formula is
 * unfair to a scale-out — it grades every contract against the absolute high,
 * including lots that were already sold before the high printed.
 *
 * Model: earlier exits are treated as planned partials that filled AT the
 * highest price reachable up to that moment — a resting limit fills the instant
 * price first touches it, so that leg captured 100% of its own window and is
 * graded against ITS exit price. The FINAL leg (the runner, usually trailed out
 * below the high) is graded against the trade's overall peak
 * (high_during_position / low_during_position), since on a scale-then-trail the
 * peak almost always prints while the runner is still open. Returns null for
 * non-scaled trades (≤1 leg) so the caller uses the plain full-qty formula.
 *
 * Worked example (the 10-lot long that read 52%): 7 @ +30 then 3 @ +20.75, peak
 * +52.25 → 7×30 + 3×52.25 = 210 + 156.75 ⇒ $733.5 ceiling vs $544.5 booked = 74%.
 */
function noBarsScaledMfeDollars(t: TradeWithExcursion & { exits_json?: ExitLeg[] | null }): number | null {
  const raw = t.exits_json
  if (!Array.isArray(raw) || raw.length < 2) return null
  if (t.entry_price == null || t.direction == null) return null
  if (t.high_during_position == null || t.low_during_position == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  if (mult === 0) return null
  const isLong = t.direction === 'long'
  const entry = t.entry_price // narrowed local — closures below don't keep the field narrowing
  const legs = [...raw].sort((a, b) => a.time.localeCompare(b.time))
  const overallExc = isLong ? t.high_during_position - entry : entry - t.low_during_position
  let total = 0
  legs.forEach((leg, i) => {
    const legExc = isLong ? leg.price - entry : entry - leg.price
    // Final leg (runner) is graded against the overall peak. A non-final leg
    // is graded against its OWN exit ONLY when that exit was favorable (a real
    // profit scale-out that locked in a local high). When a non-final leg
    // exited at a LOSS (legExc ≤ 0 — e.g. the whole position stopped out, or
    // an exit split into two same-instant fills below entry), it was NOT a
    // profit-take: those contracts were held through the position's favorable
    // peak before reversing, so credit them the overall peak like the runner.
    // Without this, a stopped-out scale-out collapses the MFE ceiling to ~0 and
    // capture% explodes (e.g. -638% instead of the true -128%).
    const exc = i === legs.length - 1 || legExc <= 0 ? overallExc : legExc
    total += Math.max(0, exc) * leg.qty * mult
  })
  return total > 0 ? total : null
}

export function captureComponents(t: TradeWithExcursion): CaptureComponents | null {
  if (t.pnl == null || t.quantity == null) return null
  // entry_price is required for the excursion math; stop_price is NOT. Capture
  // (pnl / peak-favorable-$) doesn't need a stop — the stop only feeds the
  // noise-floor baseline in mfeClearsNoiseFloor, which already tolerates its
  // absence (falls back to ATR, then to no filter). Imported trades (Sierra
  // logs, Tradezella, broker CSVs) carry no stop price, so requiring one here
  // blanked "Move captured" for every imported account.
  if (t.entry_price == null) return null
  const xc = mfeMaePoints(t)
  if (!xc) return null
  if (xc.mfe <= 0) return null
  // Noise filter: require MFE to clear ~0.5×ATR (volatility-relative) so we
  // don't print degenerate ratios on trades that barely tagged green before
  // fading. Falls back to 0.5×planned-risk when entry ATR is absent.
  if (!mfeClearsNoiseFloor(t, xc.mfe)) return null
  // Prefer the per-leg backfilled value when present — that's the
  // scaling-aware ceiling (sum over legs of leg_qty × leg_window_peak ×
  // multiplier). Populated by scripts/backfill-per-leg-mfe.ts after the
  // 2026-06-09 migration. Falls back to the simple peak × full-qty
  // formula for trades that haven't been backfilled yet OR pre-2025
  // trades outside the CSV+SCID bar coverage window.
  const tx = t as TradeWithExcursion & { mfe_dollars_per_leg?: number | null; exits_json?: ExitLeg[] | null }
  if (tx.mfe_dollars_per_leg != null && tx.mfe_dollars_per_leg > 0) {
    // Clamp at the tick-precise full-position ceiling. A correct per-leg value
    // (Σ leg_qty × leg_window_peak) can NEVER exceed full_qty × overall_peak,
    // since each leg's window peak ≤ the overall favorable extreme. A stored
    // value above this is corrupt — e.g. the old un-capped backfill walked a bad
    // bar tick to a spurious peak ($3,715 of "MFE" on a 5-lot MNQ scalp whose
    // tick-extreme only supports ~$614). Bounding here stops the corruption from
    // reaching the capture ratio AND the coach's "$ left on the table".
    const legQty = Array.isArray(tx.exits_json) && tx.exits_json.length > 0
      ? tx.exits_json.reduce((s, e) => s + (e?.qty ?? 0), 0)
      : 0
    const ceiling = xc.mfe * symbolToMultiplier(t.symbol ?? '') * (legQty > 0 ? legQty : t.quantity)
    return { pnl: t.pnl, mfeDollars: ceiling > 0 ? Math.min(tx.mfe_dollars_per_leg, ceiling) : tx.mfe_dollars_per_leg }
  }
  // Bars-free scaling-aware fallback for scaled-out trades that have neither a
  // backfilled per-leg value nor 1m bars (e.g. overnight/GBX). Avoids grading a
  // legitimate scale-out against an impossible hold-all-to-peak ceiling.
  const scaled = noBarsScaledMfeDollars(tx)
  if (scaled != null) return { pnl: t.pnl, mfeDollars: scaled }
  const mult = symbolToMultiplier(t.symbol ?? '')
  // Use the qty actually TRADED (sum of exit fills) for the dollar ceiling, not
  // the trades.quantity field — they can disagree on mis-imported/edited rows
  // (e.g. quantity=3 but exits_json + pnl reflect 5 contracts), which divides a
  // 5-lot realized pnl by a 3-lot ceiling and pushes capture past 100%.
  const exitQty = Array.isArray(tx.exits_json) && tx.exits_json.length > 0
    ? tx.exits_json.reduce((s, e) => s + (e?.qty ?? 0), 0)
    : 0
  const qtyForMfe = exitQty > 0 ? exitQty : t.quantity
  const mfeDollars = xc.mfe * mult * qtyForMfe
  if (mfeDollars === 0) return null
  return { pnl: t.pnl, mfeDollars }
}

/** Per-trade capture ratio = pnl / peak-favorable-$, FLOORED at 0. A losing
 *  give-back captured 0% of its favorable move, not a negative percentage —
 *  "you gave it all back" reads as 0%, never -128%/-638%. The upper bound is
 *  left unclamped so a >100% reading still surfaces a data bug (e.g. a stale
 *  quantity) rather than being silently hidden. For per-trade display only —
 *  use captureComponents for group aggregation. */
export function captureRatio(t: TradeWithExcursion): number | null {
  const c = captureComponents(t)
  return c == null ? null : Math.max(0, c.pnl / c.mfeDollars)
}

/** 1-minute (or any TF) OHLC bar shape needed by the per-leg max walk.
 *  Matches the row shape returned by /api/bars and used by LiveChart. */
export interface BarLike {
  ts: string  // ISO-8601
  high: number
  low: number
}

/** Single scale-out leg in trades.exits_json. Mirrors the TradeExit type
 *  in src/lib/supabase/types.ts but redeclared here to avoid the analytics
 *  lib taking a dependency on the generated supabase types. */
export interface ExitLeg {
  time: string  // ISO-8601 exit timestamp
  price: number
  qty: number
}

/**
 * Sum of MAX-POSSIBLE dollars per leg, walking exits_json. Each leg's max
 * = the highest favorable price seen between (prev leg's exit time OR
 * trade entry_time) and that leg's exit time, multiplied by the leg's
 * own qty.
 *
 * Why this matters: the simple captureComponents() uses
 *   max$ = peak_MFE × FULL_initial_qty × multiplier
 * which assumes the trader could've held every contract to the peak. For
 * scaled-out trades that's mathematically impossible — once a leg exits
 * at TP1 +20 pts, it can't possibly capture more even if price runs to
 * +25 later. perLegMaxDollars gives the honest ceiling: each leg can
 * only capture up to the peak BEFORE it exited.
 *
 * Example: 5 lots entered at $100, 3 lots out at $120 (+20), price runs
 * to $125 (+25), 2 lots out at $120 (+20).
 *   - Leg 1 (3 lots, exit at $120): peak between entry & this exit was
 *     $120 → max = 3 × 20 × mult = 3 × 20 × $2 = $120
 *   - Leg 2 (2 lots, exit at $120): peak between leg 1's exit & this
 *     exit was $125 → max = 2 × 25 × mult = $100
 *   - Total max = $220
 *
 * Whereas the simple formula gives 5 × 25 × $2 = $250, understating
 * actual capture by 14%.
 *
 * Returns null when:
 *   - Required trade fields missing (entry_price/direction/quantity/entry_time)
 *   - Bars don't cover at least one leg's window
 *   - Symbol has no multiplier mapping
 *
 * Falls back to the simple formula when exits_json is missing or empty
 * (single-leg trade — the per-leg math reduces to the simple math anyway).
 */
export function perLegMaxDollars(
  t: TradeWithExcursion & {
    exits_json?: ExitLeg[] | null
    entry_time?: string | null
  },
  bars: BarLike[],
): number | null {
  if (t.entry_price == null || t.direction == null || t.quantity == null) return null
  if (!t.entry_time) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  if (mult === 0) return null

  // Sort legs chronologically. exits_json should already be sorted at
  // import time, but the import flow has multiple sources (Sierra log,
  // Tradezella, manual) so don't trust it.
  const legs: ExitLeg[] = Array.isArray(t.exits_json) && t.exits_json.length > 0
    ? [...t.exits_json].sort((a, b) => a.time.localeCompare(b.time))
    : []

  // Single-leg trade — no scaling, defer to the simple captureComponents().
  if (legs.length === 0) {
    const xc = mfeMaePoints(t)
    if (!xc) return null
    return Math.max(0, xc.mfe) * t.quantity * mult
  }

  const isLong = t.direction === 'long'
  let totalMax = 0
  let windowStartTs = t.entry_time

  for (const leg of legs) {
    const rawPeak = findFavorablePeak(bars, windowStartTs, leg.time, isLong)
    if (rawPeak == null) return null  // bar coverage gap — caller should fall back

    // Cap the bar-derived peak at the tick-precise in-position extreme. 1-minute
    // bars include ticks AFTER a mid-bar exit, so the exit bar's high/low can
    // overshoot what was actually reachable while the position was open — which
    // UNDERSTATES capture (a TP exit taken AT the high then reading <100% because
    // price wicked past the TP in the back half of the exit minute, after the
    // fill). high_during_position / low_during_position are the true extremes.
    const peak = isLong
      ? (t.high_during_position != null ? Math.min(rawPeak, t.high_during_position) : rawPeak)
      : (t.low_during_position != null ? Math.max(rawPeak, t.low_during_position) : rawPeak)

    // Excursion is the favorable distance from entry to the leg's peak.
    // Floor at 0 — a leg that never went favorable shouldn't get NEGATIVE
    // max possible (which would inflate the capture ratio).
    const excursionPts = isLong
      ? Math.max(0, peak - t.entry_price)
      : Math.max(0, t.entry_price - peak)
    totalMax += excursionPts * leg.qty * mult
    windowStartTs = leg.time
  }

  return totalMax
}

/** Walk bars in [startTs, endTs] inclusive, returning the highest high
 *  (for longs) or lowest low (for shorts). Returns null when no bars fall
 *  in the window — caller should treat as "bar coverage gap" and fall
 *  back to the simple max-possible formula. */
function findFavorablePeak(bars: BarLike[], startTs: string, endTs: string, isLong: boolean): number | null {
  let peak = isLong ? -Infinity : Infinity
  let found = false
  for (const b of bars) {
    if (b.ts < startTs) continue
    if (b.ts > endTs) break  // bars are sorted ASC — past the window
    if (isLong) {
      if (b.high > peak) { peak = b.high; found = true }
    } else {
      if (b.low < peak) { peak = b.low; found = true }
    }
  }
  return found ? peak : null
}

/**
 * Scaling-aware version of captureComponents. Identical to the simple one
 * except mfeDollars is computed from perLegMaxDollars() instead of the
 * peak × full-qty formula. Used by per-trade displays where bars are
 * available; aggregate analytics fall back to captureComponents() because
 * we don't yet pre-compute the per-leg value at write time.
 *
 * Returns null when perLegMaxDollars returns null (bar gap) OR when the
 * underlying trade fails the same MFE noise filter as captureComponents.
 */
export function captureComponentsScaled(
  t: TradeWithExcursion & {
    exits_json?: ExitLeg[] | null
    entry_time?: string | null
  },
  bars: BarLike[],
): CaptureComponents | null {
  if (t.pnl == null || t.quantity == null) return null
  if (t.entry_price == null || t.stop_price == null) return null
  const xc = mfeMaePoints(t)
  if (!xc) return null
  if (xc.mfe <= 0) return null
  if (!mfeClearsNoiseFloor(t, xc.mfe)) return null

  const mfeDollars = perLegMaxDollars(t, bars)
  if (mfeDollars == null || mfeDollars === 0) return null
  return { pnl: t.pnl, mfeDollars }
}

/** Per-trade capture ratio with per-leg-aware denominator. Mirror of
 *  captureRatio() but uses captureComponentsScaled. */
export function captureRatioScaled(
  t: TradeWithExcursion & {
    exits_json?: ExitLeg[] | null
    entry_time?: string | null
  },
  bars: BarLike[],
): number | null {
  const c = captureComponentsScaled(t, bars)
  return c == null ? null : Math.max(0, c.pnl / c.mfeDollars)  // floor at 0 — give-backs read as 0%, not negative
}

/**
 * Display tolerance for capture / conversion ratios. A legitimate ratio can
 * float a hair past 1.0 when an exit prints at the exact favorable extreme
 * (independent rounding in the excursion vs the realized-PnL paths). Anything
 * beyond this is a DATA MISMATCH — realized PnL exceeding the peak-favorable-$
 * ceiling is physically impossible (you can't bank more than the best price the
 * trade ever reached), so it must never render as a raw percentage. See the
 * invariant note on captureComponents (~line 231). 2 percentage points of slack
 * absorbs rounding without letting a true corruption (116%, 129%, 218%) through.
 */
export const CAPTURE_DISPLAY_EPSILON = 0.02

/** The tooltip shown in place of an out-of-bounds capture/conversion value. */
export const CAPTURE_MISMATCH_TOOLTIP = 'Unavailable — data mismatch'

/**
 * Format a capture / conversion RATIO (0..1, where 1 = 100% of the favorable
 * move banked) for display as a bounded percent string. This is the single
 * render-time invariant guard for every capture/conversion surface.
 *
 *   - null / non-finite            → null  (caller renders "—", missing data)
 *   - outside [0, 1 + ε]           → null  (caller renders "—" + mismatch tip)
 *   - in-range, incl. ≤ε overshoot → "N%"  (values in (1, 1+ε] clamp to 100%)
 *
 * Returning null for BOTH missing-data and data-mismatch keeps callers simple;
 * they distinguish the two by whether the underlying inputs exist (a mismatch
 * has a value, it's just impossible) and attach CAPTURE_MISMATCH_TOOLTIP.
 */
export function formatCapturePct(ratio: number | null | undefined): string | null {
  if (ratio == null || !Number.isFinite(ratio)) return null
  if (ratio < 0 || ratio > 1 + CAPTURE_DISPLAY_EPSILON) return null
  return `${Math.round(Math.min(ratio, 1) * 100)}%`
}

/**
 * True if the trade is a "real" give-back: closed at a loss AND had MFE of
 * at least 1.0R favorable before reversing. Used to bold the capture chip in
 * the row header so the trader sees these on review.
 *
 * Why 1.0R: that's the "I had a winner" threshold — the trade reached the
 * trader's own unit of meaningful profit (1× planned risk) before going red.
 * A trade that only tagged green by 0.2R isn't a give-back; it's just a small
 * loss that briefly turned positive. The bold should be reserved for trades
 * where there was a real winner to give back.
 */
export function isGiveBackTrade(t: TradeWithExcursion): boolean {
  if ((t.pnl ?? 0) >= 0) return false
  if (t.entry_price == null || t.stop_price == null) return false
  const xc = mfeMaePoints(t)
  if (!xc) return false
  const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
  if (plannedRiskPts === 0) return false
  return xc.mfe >= plannedRiskPts // MFE >= 1R favorable
}

/**
 * MAE heat ratio = peak adverse excursion / planned risk, both in points
 * per contract (so multiplier and quantity cancel).
 *
 * Named "Heat" rather than "Loss" because it measures pressure DURING the
 * position, not realized dollar loss. A winning trade can still have a high
 * heat reading if it went deep against you first ("lucky escape").
 *
 *   heat = 0   → trade went green immediately, no adverse pressure
 *   heat = 0.5 → sat through half your stop distance
 *   heat = 1.0 → MAE touched your stop level exactly
 *   heat > 1.0 → MAE went past your stop (you moved it, or got slipped)
 *
 * Display tip: multiply by 100 and render as "%" so it reads alongside
 * Capture % uniformly. 80% = sat through 80% of planned risk before
 * reversing.
 *
 * Returns null when stop_price, entry_price, or high/low is missing, or when
 * planned risk is zero (entry == stop).
 *
 * Display tip: render as "×R" (e.g. 0.60 → "0.6× R") to preserve the unit.
 */
export function maeHeatRatio(t: TradeWithExcursion): number | null {
  if (t.entry_price == null || t.stop_price == null) return null
  const xc = mfeMaePoints(t)
  if (!xc) return null
  const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
  if (plannedRiskPts === 0) return null
  return xc.mae / plannedRiskPts
}

/** Aggregate capture across a set of trades. Skips trades whose ratio is null. */
/** Group-level MFE capture — weighted by per-trade mfeDollars so a single
 *  losing trade with tiny MFE can't drag the aggregate ratio into the
 *  ground. Formula: sum(pnl) / sum(mfeDollars) over capturable trades. */
export function avgCaptureRatio(trades: TradeWithExcursion[]): { avg: number | null; count: number } {
  let pnlSum = 0
  let mfeSum = 0
  let n = 0
  for (const t of trades) {
    const c = captureComponents(t)
    if (c != null) {
      // Floor PER TRADE, not on the net. A losing day still realized MFE if any
      // single trade banked a favorable move — 1 winner + 4 losers is red but
      // captured positive MFE on the winner. Each loser contributes 0 to the
      // captured numerator (you can't bank negative favorable $) while its MFE
      // still counts in the denominator (favorable that WAS available, given
      // back). So the day reflects the winners' real capture, never negative.
      pnlSum += Math.max(0, c.pnl)
      mfeSum += c.mfeDollars
      n++
    }
  }
  // Upper bound left unclamped so a >100% reading still flags a data bug.
  return { avg: mfeSum > 0 ? pnlSum / mfeSum : null, count: n }
}

/** Aggregate MAE loss across a set of trades. Skips trades whose ratio is null. */
export function avgMaeHeatRatio(trades: TradeWithExcursion[]): { avg: number | null; count: number } {
  let sum = 0
  let n = 0
  for (const t of trades) {
    const r = maeHeatRatio(t)
    if (r != null) { sum += r; n++ }
  }
  return { avg: n > 0 ? sum / n : null, count: n }
}

/**
 * Size-weighted MFE:MAE ratio for a set of trades: total favorable dollars ÷
 * total adverse dollars, where each trade contributes its peak MFE and peak
 * MAE in points × contracts × multiplier. Because it sums dollars BEFORE
 * dividing, a larger position weights that trade proportionally more — and the
 * result equals avg(MFE_$) / avg(MAE_$) (the per-trade count cancels), i.e. the
 * quotient of the two figures the AvgMfeMaeCard already shows in $ mode.
 *
 * Stop-independent: uses only bar-derived MFE/MAE points (mfeMaePoints), so it
 * computes on every trade with excursion data — unlike maeHeatRatio, whose
 * denominator is the planned stop distance and which silently drops stop-less
 * fills. Dollar basis (not raw points) so a mixed NQ/MNQ day weights by
 * contract VALUE, not contract count.
 *
 * Returns { ratio, count }; ratio is null when no trade has data or total
 * adverse dollars is 0 (a spotless day — undefined rather than infinite).
 */
export function avgMfeMaeRatio(trades: TradeWithExcursion[]): { ratio: number | null; count: number } {
  let mfeSum = 0
  let maeSum = 0
  let n = 0
  for (const t of trades) {
    const xc = mfeMaePoints(t)
    if (!xc) continue
    const mult = symbolToMultiplier(t.symbol ?? '')
    if (mult === 0) continue
    const qty = t.quantity ?? 1
    mfeSum += xc.mfe * qty * mult
    maeSum += xc.mae * qty * mult
    n++
  }
  return { ratio: maeSum > 0 ? mfeSum / maeSum : null, count: n }
}

/** Aggregate a set of trades into performance stats. */
export function computeStats(trades: TradeLike[]): PerformanceStats {
  if (trades.length === 0) return ZERO_STATS
  let wins = 0, losses = 0, scratches = 0
  let total = 0, sumWinners = 0, sumLosers = 0
  let rSum = 0, rCount = 0
  // Winner-only and loser-only R aggregates, so the analytics Setup
  // Performance table can show "+1.20R / -0.50R" instead of a single
  // mean-of-all-R that hides the win/loss asymmetry.
  let winnerRSum = 0, winnerRCount = 0
  let loserRSum = 0, loserRCount = 0
  // MFE Capture is WEIGHTED at the group level: sum(pnl) / sum(mfeDollars)
  // over capturable trades. A naive mean of per-trade ratios is dominated
  // by losers with small mfeDollars (a -$200 loss with $20 of MFE = -1000%
  // individual ratio, drowning every other trade). Weighted aggregation
  // answers "of every dollar of favorable move offered, how much did I
  // book?" which is what the metric MEANS at a group level. See
  // captureComponents for the per-trade numerator/denominator extraction.
  let capPnlSum = 0, capMfeSum = 0, capCount = 0
  let lossSum = 0, lossCount = 0
  for (const t of trades) {
    const pnl = t.pnl ?? 0
    total += pnl
    if (pnl > 0) { wins++; sumWinners += pnl }
    else if (pnl < 0) { losses++; sumLosers += pnl }
    else scratches++
    const r = rMultiple(t)
    if (r != null) {
      rSum += r; rCount++
      if (r > 0) { winnerRSum += r; winnerRCount++ }
      else if (r < 0) { loserRSum += r; loserRCount++ }
    }
    // Capture / Heat — NATIVE trades only. Historical (Tradezella) trades carry
    // symbol: null (multiplier 1) for realized_rr R-parity, which puts their
    // capture denominator on a DIFFERENT unit basis than native trades; blending
    // the two yields a misleading % (and the column tooltip already says native-
    // only). trading_day_id is empty on historical rows (see isNative). PnL is
    // floored PER TRADE so a give-back contributes 0 — never a negative that
    // eats into winners' capture — matching avgCaptureRatio / the EOD MFE
    // Realized %. The helpers accept TradeWithExcursion but the excursion fields
    // are optional on Trade and null-handled internally, so cast through unknown.
    if (t.trading_day_id) {
      const cap = captureComponents(t as unknown as TradeWithExcursion)
      if (cap != null) { capPnlSum += Math.max(0, cap.pnl); capMfeSum += cap.mfeDollars; capCount++ }
      const lossR = maeHeatRatio(t as unknown as TradeWithExcursion)
      if (lossR != null) { lossSum += lossR; lossCount++ }
    }
  }
  const decided = wins + losses
  const winRate = decided > 0 ? wins / decided : 0
  const avgWinner = wins > 0 ? sumWinners / wins : 0
  const avgLoser = losses > 0 ? sumLosers / losses : 0
  const expectancy = decided > 0
    ? (winRate * avgWinner) + ((1 - winRate) * avgLoser)
    : 0
  const profitFactor = sumLosers === 0
    ? (sumWinners > 0 ? Infinity : 0)
    : sumWinners / Math.abs(sumLosers)
  return {
    count: trades.length,
    wins, losses, scratches,
    win_rate: winRate,
    total_pnl: total,
    avg_pnl: total / trades.length,
    avg_winner: avgWinner,
    avg_loser: avgLoser,
    expectancy,
    profit_factor: profitFactor,
    avg_r: rCount > 0 ? rSum / rCount : null,
    avg_winner_r: winnerRCount > 0 ? winnerRSum / winnerRCount : null,
    avg_loser_r: loserRCount > 0 ? loserRSum / loserRCount : null,
    r_count: rCount,
    avg_capture: capMfeSum > 0 ? capPnlSum / capMfeSum : null,
    capture_count: capCount,
    avg_heat: lossCount > 0 ? lossSum / lossCount : null,
    heat_count: lossCount,
  }
}

export type TagCategoryKey = 'setups' | 'confluences' | 'order_flow' | 'trade_management' | 'mistakes' | 'emotions'

/** Tag-level aggregation. For each label seen in a category, computes stats over trades carrying that label. */
export interface TagPerf {
  label: string
  stats: PerformanceStats
}

/** Virtual bucket label for trades with no setup tag — surfaced under
 *  the 'setups' category only. Display-only: the trade row's tags_json
 *  stays empty in the DB. Lets the trader see honest performance of their
 *  un-planned / improvised entries as its own bucket instead of dropping
 *  out of the analytics entirely. */
const DISCRETIONARY_SETUP_LABEL = 'Discretionary/No Setup'

export function aggregateByTag(trades: TradeLike[], category: TagCategoryKey): TagPerf[] {
  const buckets = new Map<string, TradeLike[]>()
  for (const t of trades) {
    const tags = t.tags_json as TradeTags | null
    const arr = tags ? (tags[category] as string[] | undefined) : undefined
    const labels = Array.isArray(arr) ? arr.map(l => l.trim()).filter(Boolean) : []
    // Setups-only: trades without any setup tag fall into a virtual
    // "Discretionary/No Setup" bucket so improvised entries get scored
    // alongside the playbook setups. Other categories (confluences,
    // order_flow, mistakes, emotions) can legitimately be empty — we
    // don't bucketize their absence.
    if (labels.length === 0) {
      if (category === 'setups') {
        if (!buckets.has(DISCRETIONARY_SETUP_LABEL)) buckets.set(DISCRETIONARY_SETUP_LABEL, [])
        buckets.get(DISCRETIONARY_SETUP_LABEL)!.push(t)
      }
      continue
    }
    for (const label of labels) {
      if (!buckets.has(label)) buckets.set(label, [])
      buckets.get(label)!.push(t)
    }
  }
  const out: TagPerf[] = []
  for (const [label, ts] of buckets) {
    out.push({ label, stats: computeStats(ts) })
  }
  return out.sort((a, b) => b.stats.total_pnl - a.stats.total_pnl)
}

/** Day-type aggregation — combo days count under EACH tag in `day_types[]`.
 *  Per design call: a trade on a "Trend + IB Hold" day contributes to BOTH
 *  the Trend and the IB Hold buckets independently (so the sum across buckets
 *  exceeds the trade count, by construction — that's intentional). */
export function aggregateByDayType(trades: TradeWithContext[]): TagPerf[] {
  const buckets = new Map<string, TradeLike[]>()
  for (const t of trades) {
    const types = t.day_types.length > 0
      ? t.day_types
      : (t.day_type ? [t.day_type] : ['Untagged'])
    for (const raw of types) {
      const label = raw.trim() || 'Untagged'
      if (!buckets.has(label)) buckets.set(label, [])
      buckets.get(label)!.push(t)
    }
  }
  return Array.from(buckets, ([label, ts]) => ({ label, stats: computeStats(ts) }))
    .sort((a, b) => b.stats.total_pnl - a.stats.total_pnl)
}

/** Follow vs Fade by the pivot 5m structure regime at entry. long+bull /
 *  short+bear = following the HH-HL trend; long+bear / short+bull = fading it;
 *  neutral / insufficient structure are their own buckets. Trades without a
 *  regime (no .scid coverage) are skipped. Mirrors the follow/fade study. */
export function aggregateByStructureFollowFade(trades: TradeWithContext[]): TagPerf[] {
  const buckets = new Map<string, TradeLike[]>()
  for (const t of trades) {
    const r = t.structure_5m_regime
    if (!r) continue
    let label: string
    if (r === 'bull' || r === 'bear') {
      if (!t.direction) continue
      const withTrend = (t.direction === 'long' && r === 'bull') || (t.direction === 'short' && r === 'bear')
      label = withTrend ? 'Follow' : 'Fade'
    } else {
      label = r === 'neutral' ? 'Neutral structure' : 'No structure'
    }
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label)!.push(t)
  }
  return Array.from(buckets, ([label, ts]) => ({ label, stats: computeStats(ts) }))
    .sort((a, b) => b.stats.total_pnl - a.stats.total_pnl)
}

/** Comparison of "trades WITH this tag" vs "trades WITHOUT this tag". */
export interface TagImpact {
  label: string
  withStats: PerformanceStats
  withoutStats: PerformanceStats
  delta_avg_pnl: number   // avg_pnl(with) - avg_pnl(without)
}

export function tagImpact(trades: TradeLike[], category: TagCategoryKey): TagImpact[] {
  const seen = new Set<string>()
  for (const t of trades) {
    const tags = t.tags_json as TradeTags | null
    const arr = tags?.[category] as string[] | undefined
    arr?.forEach(l => l && seen.add(l.trim()))
  }
  const out: TagImpact[] = []
  for (const label of seen) {
    const withTrades: TradeLike[] = []
    const withoutTrades: TradeLike[] = []
    for (const t of trades) {
      const arr = ((t.tags_json as TradeTags | null)?.[category] as string[] | undefined) ?? []
      if (arr.includes(label)) withTrades.push(t)
      else withoutTrades.push(t)
    }
    const w = computeStats(withTrades)
    const wo = computeStats(withoutTrades)
    out.push({ label, withStats: w, withoutStats: wo, delta_avg_pnl: w.avg_pnl - wo.avg_pnl })
  }
  return out.sort((a, b) => a.delta_avg_pnl - b.delta_avg_pnl) // worst-impact first
}

export interface Bucket {
  label: string
  range: [number | null, number | null]
  trades: TradeWithContext[]
  stats: PerformanceStats
}

/**
 * Bucket trades by a numeric field with custom breakpoints.
 * `breaks` are inclusive lower bounds. Example: breaks=[0, 1, 1.5, 2] yields
 * buckets: <0, 0-1, 1-1.5, 1.5-2, ≥2. Trades with null values go into a
 * separate "Unknown" bucket at the end.
 */
export function bucketByNumeric(
  items: TradeWithContext[],
  getValue: (t: TradeWithContext) => number | null,
  breaks: number[],
  fmt: (n: number) => string = n => n.toString(),
): Bucket[] {
  const sorted = [...breaks].sort((a, b) => a - b)
  const buckets: Bucket[] = []
  // <first
  buckets.push({
    label: `< ${fmt(sorted[0])}`,
    range: [null, sorted[0]],
    trades: [],
    stats: ZERO_STATS,
  })
  for (let i = 0; i < sorted.length - 1; i++) {
    buckets.push({
      label: `${fmt(sorted[i])}–${fmt(sorted[i + 1])}`,
      range: [sorted[i], sorted[i + 1]],
      trades: [],
      stats: ZERO_STATS,
    })
  }
  buckets.push({
    label: `≥ ${fmt(sorted[sorted.length - 1])}`,
    range: [sorted[sorted.length - 1], null],
    trades: [],
    stats: ZERO_STATS,
  })
  const unknown: Bucket = { label: 'Unknown', range: [null, null], trades: [], stats: ZERO_STATS }

  for (const t of items) {
    const v = getValue(t)
    if (v == null || !Number.isFinite(v)) {
      unknown.trades.push(t)
      continue
    }
    if (v < sorted[0]) {
      buckets[0].trades.push(t)
      continue
    }
    let placed = false
    for (let i = 0; i < sorted.length - 1; i++) {
      if (v >= sorted[i] && v < sorted[i + 1]) {
        buckets[i + 1].trades.push(t)
        placed = true
        break
      }
    }
    if (!placed) {
      buckets[buckets.length - 1].trades.push(t)
    }
  }

  for (const b of buckets) b.stats = computeStats(b.trades)
  unknown.stats = computeStats(unknown.trades)
  if (unknown.trades.length > 0) buckets.push(unknown)
  return buckets
}

/** Rolling cumulative + windowed stats. Trades expected sorted by entry_time ascending. */
export interface RollingPoint {
  index: number               // 1-based trade number
  date: string                // YYYY-MM-DD of the trade
  pnl: number
  cum_pnl: number
  rolling_win_rate: number    // over the trailing N trades (or fewer at the start)
  rolling_expectancy: number
}

export function rollingStats(trades: TradeLike[], window: number): RollingPoint[] {
  const sorted = [...trades]
    .filter(t => t.entry_time && t.pnl != null)
    .sort((a, b) => new Date(a.entry_time!).getTime() - new Date(b.entry_time!).getTime())
  const points: RollingPoint[] = []
  let cum = 0
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].pnl ?? 0
    const start = Math.max(0, i + 1 - window)
    const slice = sorted.slice(start, i + 1)
    const stats = computeStats(slice)
    points.push({
      index: i + 1,
      date: (sorted[i].entry_time ?? '').slice(0, 10),
      pnl: sorted[i].pnl ?? 0,
      cum_pnl: cum,
      rolling_win_rate: stats.win_rate,
      rolling_expectancy: stats.expectancy,
    })
  }
  return points
}

/** Per-day rollups for the calendar heatmap. Falls back to summed trades.pnl if eod_pnl is null. */
export function buildDaySummaries(
  days: Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type' | 'day_types'>[],
  trades: Pick<Trade, 'pnl' | 'trading_day_id'>[],
): DaySummary[] {
  const tradesByDay = new Map<string, Pick<Trade, 'pnl' | 'trading_day_id'>[]>()
  for (const t of trades) {
    const k = t.trading_day_id
    if (!tradesByDay.has(k)) tradesByDay.set(k, [])
    tradesByDay.get(k)!.push(t)
  }
  return days.map(d => {
    const ts = tradesByDay.get(d.id) ?? []
    const summed = ts.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const wins = ts.filter(t => (t.pnl ?? 0) > 0).length
    const losses = ts.filter(t => (t.pnl ?? 0) < 0).length
    const types = (d.day_types && d.day_types.length > 0)
      ? d.day_types
      : (d.day_type ? [d.day_type] : [])
    return {
      date: d.date,
      pnl: d.eod_pnl ?? summed,
      trade_count: ts.length,
      wins,
      losses,
      day_type: d.day_type,
      day_types: types,
    }
  })
}

/** Cumulative drawdown from peak equity. Useful for top-line stats. */
export function maxDrawdown(points: { cum_pnl: number }[]): number {
  let peak = 0
  let maxDD = 0
  for (const p of points) {
    peak = Math.max(peak, p.cum_pnl)
    const dd = peak - p.cum_pnl
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

/** Join trades with day + market_context, returning a flat shape for filtering.
 *  Trades MUST carry high_during_position / low_during_position (they're
 *  required on TradeWithExcursion, the supertype of TradeWithContext) — the
 *  analytics page is responsible for selecting them from the DB.
 *
 *  Per-trade entry-time snapshots (entry_atr_1m / entry_rvol) are read off
 *  the trade row if present. The Trade DB row carries them as of the
 *  2026-06-09 migration; until the generated Supabase types catch up, the
 *  caller widens the row type locally and we tolerate them being missing. */
export function joinTradesWithContext(
  trades: (TradeWithExcursion & { entry_atr_1m?: number | null; entry_rvol?: number | null; mfe_dollars_per_leg?: number | null; structure_5m_regime?: 'bull' | 'bear' | 'neutral' | 'insufficient' | null })[],
  days: Pick<TradingDay, 'id' | 'date' | 'day_type' | 'day_types'>[],
  contexts: (Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'> & { atr_at_ib_close?: number | null })[],
): TradeWithContext[] {
  const dayById = new Map(days.map(d => [d.id, d]))
  const ctxByDay = new Map(contexts.map(c => [c.trading_day_id, c]))
  return trades.map(t => {
    const d = dayById.get(t.trading_day_id)
    const c = ctxByDay.get(t.trading_day_id)
    const types = (d?.day_types && d.day_types.length > 0)
      ? d.day_types
      : (d?.day_type ? [d.day_type] : [])
    return {
      ...t,
      date: d?.date ?? '',
      day_type: d?.day_type ?? null,
      day_types: types,
      rvol: c?.rvol ?? null,
      ib_size: c?.ib_size ?? null,
      ib_vs_10d_avg: c?.ib_vs_10d_avg ?? null,
      adr: c?.adr ?? null,
      atr_1m: c?.atr_1m ?? null,
      atr_at_ib_close: c?.atr_at_ib_close ?? null,
      entry_atr_1m: t.entry_atr_1m ?? null,
      entry_rvol: t.entry_rvol ?? null,
      mfe_dollars_per_leg: t.mfe_dollars_per_leg ?? null,
      structure_5m_regime: t.structure_5m_regime ?? null,
    }
  })
}
