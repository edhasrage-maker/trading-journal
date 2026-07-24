import { symbolToMultiplier } from '@/lib/futures-symbols'
import { avgCaptureRatio, avgMaeHeatRatio, type TradeWithExcursion } from '@/lib/analytics'
import { tapeScoreFromAnalyses, type TapeScoreResult } from '@/lib/tapescore'
import type { TradingDay } from '@/lib/supabase/types'

/**
 * The per-day dashboard rollup, extracted verbatim from the inline computation
 * that used to live in `dashboard/page.tsx`. Kept as ONE pure function so it can
 * run BOTH at read time (dashboard fallback) and at write time (materialized
 * `trading_days.stats_json`) — a cached row and a freshly computed row are then
 * identical by construction. See docs/dashboard-stats-materialization-plan.md.
 */

/** The trade fields the rollup reads (superset-safe: extra fields are ignored). */
export interface TradeForStats {
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
  pnl: number | null
  direction: 'long' | 'short' | null
  entry_price: number | null
  stop_price: number | null
  high_during_position: number | null
  low_during_position: number | null
  quantity: number | null
  symbol: string | null
  entry_atr_1m: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json: any
  mfe_dollars_per_leg: number | null
}

/** The day-level inputs (columns) the rollup reads. */
export interface DayForStats {
  id: string
  date: string
  eod_pnl: number | null
  day_type: string | null
  day_types: string[] | null
  ai_analysis_json: TradingDay['ai_analysis_json'] | null
  eod_ai_analysis_json: TradingDay['eod_ai_analysis_json'] | null
  /** Earned achievement coin ids (trading_days.achievements_json). */
  achievements?: string[]
}

/** The shape the dashboard consumes per day (unchanged from the old inline map). */
export interface DayStatsRollup {
  id: string
  date: string
  eod_pnl: number | null
  day_type: string | null
  day_types: string[]
  achievements: string[]
  trade_count: number
  trade_wins: number
  trades_with_pnl_count: number
  setups: string[]
  process_score: number | null
  overall_grade: number | null
  process_verdict: 'Compliant' | 'Breach' | null
  process_v13_score: number | null
  tapescore: TapeScoreResult | null
  process_breach_rules: string[] | null
  win_rate: number | null
  avg_mfe_pts: number | null
  avg_mae_pts: number | null
  avg_mfe_dollars: number | null
  avg_mae_dollars: number | null
  avg_capture: number | null
  avg_heat: number | null
  atr_1m: number | null
  avg_live_atr_1m: number | null
  live_atr_count: number
  avg_mfe_atr: number | null
  avg_mae_atr: number | null
}

/**
 * Cache format version for the materialized `trading_days.stats_json`. Bump this
 * whenever `computeDayStats`'s formula or output shape changes: the dashboard
 * read path treats any row whose `stats_version` != this constant as dirty and
 * recomputes it, so a formula change invalidates every cached row at once.
 */
// v2 (2026-07-23): TapeScore amendment 6 changed the derived score's formula
// and its components ({rules,execution,prep} → {risk,entry,capture}). The
// rollup caches that derived result, so every row must recompute — otherwise
// the Review · Month ring + decision-quality list read the stale old-shape
// components as null (0/0/0) and the cached scores stay on the old formula.
export const STATS_VERSION = 2

/** The rollup fields persisted in `stats_json` — everything `computeDayStats`
 *  returns EXCEPT the fields that already live in dedicated `trading_days`
 *  columns (id, date, day_type, day_types) or their own column merged at read
 *  time (achievements). Those are re-attached by `fromStoredStats`. */
export type DayStatsStored = Omit<DayStatsRollup, 'id' | 'date' | 'day_type' | 'day_types' | 'achievements'>

/** Project a full rollup down to what we store in `stats_json` (drops the
 *  column-owned fields so the cache never disagrees with the row). */
export function toStoredStats(r: DayStatsRollup): DayStatsStored {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { id, date, day_type, day_types, achievements, ...stored } = r
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return stored
}

/** Rehydrate a full rollup from a stored `stats_json` blob + the day's own
 *  columns. day_types is re-derived exactly as `computeDayStats` does. */
export function fromStoredStats(
  stored: DayStatsStored,
  day: { id: string; date: string; day_type: string | null; day_types: string[] | null; achievements?: string[] },
): DayStatsRollup {
  return {
    ...stored,
    id: day.id,
    date: day.date,
    day_type: day.day_type,
    day_types: (day.day_types && day.day_types.length > 0)
      ? day.day_types
      : (day.day_type ? [day.day_type] : []),
    achievements: day.achievements ?? [],
  }
}

/**
 * Compute the dashboard rollup for one day from its trades + prep ATR. Pure and
 * self-contained: live ATR is read from each trade's own `entry_atr_1m` (no
 * external map), and capture/heat/tapescore come from the shared analytics +
 * tapescore libs, so this matches the EOD recap and analytics exactly.
 *
 * @param prepAtr  the day's market_context.atr_1m (fallback ATR display value).
 */
export function computeDayStats(day: DayForStats, trades: TradeForStats[], prepAtr: number | null): DayStatsRollup {
  // Top setups across the day's trades, sorted by frequency.
  const setupCounts = new Map<string, number>()
  for (const t of trades) {
    const setups = (t.tags_json?.setups ?? []) as string[]
    for (const s of setups) setupCounts.set(s, (setupCounts.get(s) ?? 0) + 1)
  }
  const setupsAll = Array.from(setupCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s)

  // Displayed PnL: explicit eod_pnl override wins; else sum of trades; else null.
  const summedPnl = trades.reduce((acc, t) => acc + (t.pnl ?? 0), 0)
  const displayedPnl = day.eod_pnl != null
    ? day.eod_pnl
    : trades.length > 0 ? summedPnl : null

  const tradesWithPnl = trades.filter(t => t.pnl != null)
  const winsOnDay = tradesWithPnl.filter(t => (t.pnl ?? 0) > 0).length
  const winRate = tradesWithPnl.length > 0
    ? (winsOnDay / tradesWithPnl.length) * 100
    : null

  // Avg MFE / MAE per trade (points + $), floored at 0 per trade.
  const mfeMaeTrades = trades.filter(t =>
    t.entry_price != null &&
    t.high_during_position != null &&
    t.low_during_position != null &&
    t.direction != null
  )
  let avgMfePts: number | null = null
  let avgMaePts: number | null = null
  let avgMfeDollars: number | null = null
  let avgMaeDollars: number | null = null
  if (mfeMaeTrades.length > 0) {
    let mfeSum = 0, maeSum = 0, mfeDollarSum = 0, maeDollarSum = 0
    for (const t of mfeMaeTrades) {
      const isLong = t.direction === 'long'
      const mfe = Math.max(0, isLong
        ? (t.high_during_position! - t.entry_price!)
        : (t.entry_price! - t.low_during_position!))
      const mae = Math.max(0, isLong
        ? (t.entry_price! - t.low_during_position!)
        : (t.high_during_position! - t.entry_price!))
      mfeSum += mfe
      maeSum += mae
      const mult = symbolToMultiplier(t.symbol ?? '')
      const qty = t.quantity ?? 1
      mfeDollarSum += mfe * mult * qty
      maeDollarSum += mae * mult * qty
    }
    avgMfePts = mfeSum / mfeMaeTrades.length
    avgMaePts = maeSum / mfeMaeTrades.length
    avgMfeDollars = mfeDollarSum / mfeMaeTrades.length
    avgMaeDollars = maeDollarSum / mfeMaeTrades.length
  }

  const xcTrades = trades as unknown as TradeWithExcursion[]
  const captureStats = avgCaptureRatio(xcTrades)
  const heatStats = avgMaeHeatRatio(xcTrades)

  // Live ATR averaged across the day's trades (from each trade's entry_atr_1m).
  let avgLiveAtr1m: number | null = null
  let liveAtrCount = 0
  let liveAtrSum = 0
  for (const t of trades) {
    if (t.entry_atr_1m != null && t.entry_atr_1m > 0) { liveAtrSum += t.entry_atr_1m; liveAtrCount++ }
  }
  if (liveAtrCount > 0) avgLiveAtr1m = liveAtrSum / liveAtrCount

  // Average-of-ratios ×ATR (matches the EOD AvgMfeMaeCard): mean of per-trade
  // (excursion / that trade's OWN entry_atr_1m), over the ATR-bearing subset.
  let avgMfeAtr: number | null = null
  let avgMaeAtr: number | null = null
  {
    let mfeAtrSum = 0, maeAtrSum = 0, n = 0
    for (const t of mfeMaeTrades) {
      const atr = t.entry_atr_1m
      if (atr == null || atr <= 0) continue
      const isLong = t.direction === 'long'
      const mfe = Math.max(0, isLong ? (t.high_during_position! - t.entry_price!) : (t.entry_price! - t.low_during_position!))
      const mae = Math.max(0, isLong ? (t.entry_price! - t.low_during_position!) : (t.high_during_position! - t.entry_price!))
      mfeAtrSum += mfe / atr
      maeAtrSum += mae / atr
      n++
    }
    if (n > 0) { avgMfeAtr = mfeAtrSum / n; avgMaeAtr = maeAtrSum / n }
  }

  return {
    id: day.id,
    date: day.date,
    eod_pnl: displayedPnl,
    day_type: day.day_type,
    day_types: (day.day_types && day.day_types.length > 0)
      ? day.day_types
      : (day.day_type ? [day.day_type] : []),
    achievements: day.achievements ?? [],
    trade_count: trades.length,
    trade_wins: winsOnDay,
    trades_with_pnl_count: tradesWithPnl.length,
    setups: setupsAll,
    process_score: day.ai_analysis_json?.score ?? null,
    overall_grade: (() => {
      const j = day.eod_ai_analysis_json
      const composite = j?.execution?.composite
      if (composite != null) return Math.round(composite * 10)
      if (j?.execution != null) return 0
      return j?.score ?? null
    })(),
    process_verdict: (() => {
      const p = day.eod_ai_analysis_json?.process
      return p?.verdict ?? null
    })(),
    process_v13_score: (() => {
      const p = day.eod_ai_analysis_json?.process
      if (!p?.per_rule) return null
      const ruleIds = ['P1', 'P2', 'P3', 'P4', 'P5'] as const
      let passCount = 0
      for (const id of ruleIds) {
        const r = p.per_rule[id]
        if (!r) continue
        if (r.status === 'pass') passCount += 1
      }
      return Math.round((passCount / 5) * 10)
    })(),
    tapescore: tapeScoreFromAnalyses(day.eod_ai_analysis_json, day.ai_analysis_json?.score ?? null),
    process_breach_rules: (() => {
      const p = day.eod_ai_analysis_json?.process
      if (!p?.per_rule) return null
      const ruleIds = ['P1', 'P2', 'P3', 'P4', 'P5'] as const
      const failed: string[] = []
      for (const id of ruleIds) {
        const r = p.per_rule[id]
        if (!r) continue
        if (r.status === 'fail' || r.status === 'incomplete') failed.push(id)
      }
      return failed
    })(),
    win_rate: winRate,
    avg_mfe_pts: avgMfePts,
    avg_mae_pts: avgMaePts,
    avg_mfe_dollars: avgMfeDollars,
    avg_mae_dollars: avgMaeDollars,
    avg_capture: captureStats.avg,
    avg_heat: heatStats.avg,
    atr_1m: prepAtr,
    avg_live_atr_1m: avgLiveAtr1m,
    live_atr_count: liveAtrCount,
    avg_mfe_atr: avgMfeAtr,
    avg_mae_atr: avgMaeAtr,
  }
}
