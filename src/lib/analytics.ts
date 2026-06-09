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
  // Per-trade entry-time snapshots (backfilled by scripts/backfill-entry-metrics.ts).
  // ATR/RVOL at the minute of entry, no afternoon lookahead. ConditionBuckets
  // prefers these when present, falls back to day-level rvol/atr_1m for
  // trades that haven't been backfilled (e.g. pre-2025).
  entry_atr_1m: number | null
  entry_rvol: number | null
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
export function rMultiple(t: TradeLike): number | null {
  const ep = t.entry_price, sp = t.stop_price, pnl = t.pnl, qty = t.quantity
  if (ep == null || sp == null || pnl == null || qty == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  const riskDollars = Math.abs(ep - sp) * qty * mult
  if (riskDollars === 0) return null
  return pnl / riskDollars
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
  const mfe = isLong
    ? t.high_during_position - t.entry_price
    : t.entry_price - t.low_during_position
  const mae = isLong
    ? t.entry_price - t.low_during_position
    : t.high_during_position - t.entry_price
  return { mfe, mae }
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

export function captureComponents(t: TradeWithExcursion): CaptureComponents | null {
  if (t.pnl == null || t.quantity == null) return null
  // Stop is required: without a planned-risk baseline we can't tell whether
  // a small MFE is meaningful or significant. Trades without a stop don't
  // get a capture report.
  if (t.entry_price == null || t.stop_price == null) return null
  const xc = mfeMaePoints(t)
  if (!xc) return null
  if (xc.mfe <= 0) return null
  // Noise filter: require MFE to be at least MIN_MFE_RATIO_FOR_CAPTURE of
  // planned risk so we don't print degenerate ratios on trades that barely
  // tagged green before fading.
  const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
  if (plannedRiskPts > 0 && xc.mfe < plannedRiskPts * MIN_MFE_RATIO_FOR_CAPTURE) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  const mfeDollars = xc.mfe * mult * t.quantity
  if (mfeDollars === 0) return null
  return { pnl: t.pnl, mfeDollars }
}

/** Per-trade capture ratio = pnl / peak-favorable-$. Bounded [0, 1] for
 *  winners (assuming pnl ≤ MFE in $); can be deeply negative for losers
 *  where pnl is negative and mfeDollars is small. For per-trade display
 *  only — use captureComponents for group aggregation. */
export function captureRatio(t: TradeWithExcursion): number | null {
  const c = captureComponents(t)
  return c == null ? null : c.pnl / c.mfeDollars
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
    if (c != null) { pnlSum += c.pnl; mfeSum += c.mfeDollars; n++ }
  }
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
    // Capture / Loss: trades may or may not have high/low_during_position. The
    // helpers accept TradeWithExcursion but the relevant fields are optional
    // on Trade and null-handled internally — cast through unknown so callers
    // that pass TradeLike still type-check, and the helpers null-out trades
    // that don't have the necessary data.
    const cap = captureComponents(t as unknown as TradeWithExcursion)
    if (cap != null) { capPnlSum += cap.pnl; capMfeSum += cap.mfeDollars; capCount++ }
    const lossR = maeHeatRatio(t as unknown as TradeWithExcursion)
    if (lossR != null) { lossSum += lossR; lossCount++ }
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

export function aggregateByTag(trades: TradeLike[], category: TagCategoryKey): TagPerf[] {
  const buckets = new Map<string, TradeLike[]>()
  for (const t of trades) {
    const tags = t.tags_json as TradeTags | null
    if (!tags) continue
    const arr = tags[category] as string[] | undefined
    if (!Array.isArray(arr)) continue
    for (const label of arr) {
      const trimmed = label.trim()
      if (!trimmed) continue
      if (!buckets.has(trimmed)) buckets.set(trimmed, [])
      buckets.get(trimmed)!.push(t)
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
  trades: (TradeWithExcursion & { entry_atr_1m?: number | null; entry_rvol?: number | null })[],
  days: Pick<TradingDay, 'id' | 'date' | 'day_type' | 'day_types'>[],
  contexts: Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>[],
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
      entry_atr_1m: t.entry_atr_1m ?? null,
      entry_rvol: t.entry_rvol ?? null,
    }
  })
}
