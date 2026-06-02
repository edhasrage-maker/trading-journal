import type { Trade, TradeTags, TradingDay, MarketContext } from '@/lib/supabase/types'
import { symbolToMultiplier } from '@/lib/futures-symbols'

/**
 * Pure aggregation helpers for the Journal + Analytics views.
 * All functions are tree-shakeable and run client-side over already-fetched
 * trades. Designed for ≤ a few thousand trades — fine for a single trader's journal.
 */

export type TradeLike = Pick<Trade,
  'id' | 'pnl' | 'entry_price' | 'stop_price' | 'quantity' | 'direction' | 'entry_time' | 'tags_json' | 'trading_day_id'
>

/** Same as TradeLike plus the tick-extreme + symbol fields needed for MFE/MAE math. */
export type TradeWithExcursion = TradeLike & Pick<Trade,
  'high_during_position' | 'low_during_position' | 'symbol'
>

/** Trade with trading_day + market_context fields flattened in for easy filtering. */
export interface TradeWithContext extends TradeLike {
  date: string
  day_type: string | null
  rvol: number | null
  ib_size: number | null
  ib_vs_10d_avg: number | null
  adr: number | null
  atr_1m: number | null
}

export interface DaySummary {
  date: string
  pnl: number              // eod_pnl override OR sum of trades.pnl
  trade_count: number
  wins: number
  losses: number
  day_type: string | null
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
  avg_r: number | null      // mean R-multiple (only counted when computable)
  r_count: number           // how many trades had a computable R
}

const ZERO_STATS: PerformanceStats = {
  count: 0, wins: 0, losses: 0, scratches: 0,
  win_rate: 0, total_pnl: 0, avg_pnl: 0,
  avg_winner: 0, avg_loser: 0,
  expectancy: 0, profit_factor: 0,
  avg_r: null, r_count: 0,
}

/** R-multiple for a single trade. Returns null when entry/stop/qty/pnl missing or risk is zero. */
export function rMultiple(t: TradeLike): number | null {
  const ep = t.entry_price, sp = t.stop_price, pnl = t.pnl, qty = t.quantity
  if (ep == null || sp == null || pnl == null || qty == null) return null
  const risk = Math.abs(ep - sp) * qty
  if (risk === 0) return null
  return pnl / risk
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
export function captureRatio(t: TradeWithExcursion): number | null {
  if (t.pnl == null || t.quantity == null) return null
  const xc = mfeMaePoints(t)
  if (!xc) return null
  if (xc.mfe <= 0) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  const mfeDollars = xc.mfe * mult * t.quantity
  if (mfeDollars === 0) return null
  return t.pnl / mfeDollars
}

/**
 * MAE loss ratio = peak adverse excursion / planned risk, both in points
 * per contract (so multiplier and quantity cancel).
 *
 *   loss = 0    → trade went green immediately, no adverse pressure
 *   loss = 0.5  → sat through half your stop distance
 *   loss = 1.0  → MAE touched your stop level exactly
 *   loss > 1.0  → MAE went past your stop (you moved it, or got slipped)
 *
 * Note: "loss" here refers to the % of planned-risk distance touched as MAE,
 * not the realized dollar loss on the trade. A winning trade can still have
 * a high loss ratio if it went deep against you first ("lucky escape").
 *
 * Returns null when stop_price, entry_price, or high/low is missing, or when
 * planned risk is zero (entry == stop).
 *
 * Display tip: render as "×R" (e.g. 0.60 → "0.6× R") to preserve the unit.
 */
export function maeLossRatio(t: TradeWithExcursion): number | null {
  if (t.entry_price == null || t.stop_price == null) return null
  const xc = mfeMaePoints(t)
  if (!xc) return null
  const plannedRiskPts = Math.abs(t.entry_price - t.stop_price)
  if (plannedRiskPts === 0) return null
  return xc.mae / plannedRiskPts
}

/** Aggregate capture across a set of trades. Skips trades whose ratio is null. */
export function avgCaptureRatio(trades: TradeWithExcursion[]): { avg: number | null; count: number } {
  let sum = 0
  let n = 0
  for (const t of trades) {
    const r = captureRatio(t)
    if (r != null) { sum += r; n++ }
  }
  return { avg: n > 0 ? sum / n : null, count: n }
}

/** Aggregate MAE loss across a set of trades. Skips trades whose ratio is null. */
export function avgMaeLossRatio(trades: TradeWithExcursion[]): { avg: number | null; count: number } {
  let sum = 0
  let n = 0
  for (const t of trades) {
    const r = maeLossRatio(t)
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
  for (const t of trades) {
    const pnl = t.pnl ?? 0
    total += pnl
    if (pnl > 0) { wins++; sumWinners += pnl }
    else if (pnl < 0) { losses++; sumLosers += pnl }
    else scratches++
    const r = rMultiple(t)
    if (r != null) { rSum += r; rCount++ }
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
    r_count: rCount,
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

/** Day-type aggregation (single-string field, lives at the trade or trading_day level). */
export function aggregateByDayType(trades: TradeWithContext[]): TagPerf[] {
  const buckets = new Map<string, TradeLike[]>()
  for (const t of trades) {
    const dt = (t.day_type ?? '').trim() || 'Untagged'
    if (!buckets.has(dt)) buckets.set(dt, [])
    buckets.get(dt)!.push(t)
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
  days: Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type'>[],
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
    return {
      date: d.date,
      pnl: d.eod_pnl ?? summed,
      trade_count: ts.length,
      wins,
      losses,
      day_type: d.day_type,
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

/** Join trades with day + market_context, returning a flat shape for filtering. */
export function joinTradesWithContext(
  trades: TradeLike[],
  days: Pick<TradingDay, 'id' | 'date' | 'day_type'>[],
  contexts: Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>[],
): TradeWithContext[] {
  const dayById = new Map(days.map(d => [d.id, d]))
  const ctxByDay = new Map(contexts.map(c => [c.trading_day_id, c]))
  return trades.map(t => {
    const d = dayById.get(t.trading_day_id)
    const c = ctxByDay.get(t.trading_day_id)
    return {
      ...t,
      date: d?.date ?? '',
      day_type: d?.day_type ?? null,
      rvol: c?.rvol ?? null,
      ib_size: c?.ib_size ?? null,
      ib_vs_10d_avg: c?.ib_vs_10d_avg ?? null,
      adr: c?.adr ?? null,
      atr_1m: c?.atr_1m ?? null,
    }
  })
}
