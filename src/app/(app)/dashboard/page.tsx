import { createClient } from '@/lib/supabase/server'
import { format, subDays } from 'date-fns'
import { todayPT } from '@/lib/pt-time'
import EmptyStateImport from '@/components/dashboard/EmptyStateImport'
import RecentDaysSection from '@/components/dashboard/RecentDaysSection'
import DashboardStats, { type DayStat } from '@/components/dashboard/DashboardStats'
import DashboardCharts from '@/components/dashboard/DashboardCharts'
import DashboardModeSwitch from '@/components/dashboard/DashboardModeSwitch'
import BeginnerDashboard from '@/components/dashboard/BeginnerDashboard'
import { symbolToMultiplier } from '@/lib/futures-symbols'
import { avgCaptureRatio, avgMaeHeatRatio, type TradeWithExcursion } from '@/lib/analytics'
// Dashboard previously imported liveAtr + fetchAllBars to recompute per-trade
// ATR from `ohlcv_bars` on every request. That path was retired in favor of
// reading the pre-backfilled `trades.entry_atr_1m` column. Imports kept off
// the file so the bundle doesn't carry unused code.
import type { TradingDay } from '@/lib/supabase/types'

const PAGE_SIZE = 1000

// Disable static generation so the date is recomputed on every request
// (otherwise this page caches and shows stale "today" across midnight).
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Plain-English per-day note for the Beginner recent-sessions list: interprets
// the day's win rate + move capture AGAINST the trader's own baseline, so a
// beginner gets meaning ("lower win rate than usual, but kept more of the move")
// instead of raw percentages they can't yet judge. (docs/BEGINNER_PRO_MODES.md)
function beginnerDayNote(opts: {
  winRate: number | null      // that day, 0..100
  capture: number | null      // that day, 0..1
  pnl: number | null
  breach: boolean
  avgWin: number | null       // baseline win rate, 0..100
  avgCap: number | null       // baseline capture, 0..1
  bestDay: number | null      // best day $ in the window (for magnitude context)
  worstDay: number | null     // worst day $ in the window
}): string {
  const { winRate, capture, pnl, breach, avgWin, avgCap, bestDay, worstDay } = opts
  if (breach) return 'Broke one of your rules — the one to review first.'
  const wr = winRate == null ? null : Math.round(winRate)
  const cap = capture == null ? null : Math.round(capture * 100)
  const winLow = avgWin != null && winRate != null && winRate <= avgWin - 8
  const winHigh = avgWin != null && winRate != null && winRate >= avgWin + 8
  const capLow = avgCap != null && capture != null && capture <= avgCap - 0.1
  const capHigh = avgCap != null && capture != null && capture >= avgCap + 0.1

  // Richest read: win rate AND capture together, with the concrete numbers.
  if (wr != null && cap != null) {
    if (winLow && capHigh) return `${wr}% wins, but you kept ${cap}% of the move — you cashed the ones you got right.`
    if (winHigh && capLow) return `${wr}% wins, but only kept ${cap}% of the move — winners cut early.`
    if (winHigh && capHigh) return `${wr}% wins and kept ${cap}% of the move — clean on both.`
    if (winLow && capLow) return `${wr}% wins and kept ${cap}% of the move — off day on both.`
    return `${wr}% wins · kept ${cap}% of the move.`
  }

  // No capture data — lead with the win-rate number + how the day's result sized up.
  if (wr != null) {
    if (pnl != null && pnl > 0) {
      if (bestDay != null && bestDay > 0 && pnl >= bestDay) return `${wr}% wins — your best day this stretch.`
      return `${wr}% wins — a green day.`
    }
    if (pnl != null && pnl < 0) {
      if (worstDay != null && pnl <= worstDay) return `${wr}% wins — your roughest day this stretch.`
      return `${wr}% wins — small red day, kept it contained.`
    }
    return `${wr}% wins.`
  }

  if (pnl != null && pnl > 0) return 'A green day.'
  if (pnl != null && pnl < 0) return 'A red day.'
  return ''
}

export default async function DashboardPage() {
  // PT-anchored, not machine-local — see todayPT(). Prevents a mis-set OS
  // timezone on either synced machine from filing today's prep/intraday/EOD
  // under the wrong calendar day.
  const today = todayPT()
  const supabase = await createClient()
  const perf = { phases: [] as Array<{ name: string; ms: number; rows?: number }>, t0: Date.now() }
  const tick = (name: string, rows?: number) => {
    const ms = Date.now() - perf.t0
    perf.phases.push({ name, ms, rows })
    perf.t0 = Date.now()
  }

  // Two windows:
  //   - past180Start: drives the Recent Days table + the expensive per-trade
  //     ATR/bars loop. Unchanged from before — keeps the table snappy.
  //   - statsWindowStart: drives the period-selectable stat cards (Week /
  //     Month / 30d / YTD / Last Year). Walks back to the start of LAST year
  //     so "Last Year" has the full ~365-day window even on Dec 31.
  const todayDateForWindows = new Date()
  const past30StartParallel = format(subDays(todayDateForWindows, 30), 'yyyy-MM-dd')
  const past180StartParallel = format(subDays(todayDateForWindows, 180), 'yyyy-MM-dd')
  const statsWindowStartParallel = `${todayDateForWindows.getFullYear() - 1}-01-01`

  // Single top-level trading_days query: the period stats + Recent Days table
  // + the new top-of-page charts all derive from this one window (start-of-
  // last-year → today). The separate per-date "today" fetch was dropped along
  // with the Today quick-action tiles it fed.
  const recentResult = await supabase
    .from('trading_days')
    .select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json')
    .gte('date', statsWindowStartParallel)
    .order('date', { ascending: false })
    .limit(PAGE_SIZE)
  tick('recentDays')

  // Reuse the window constants computed for the parallel fetch above so we
  // don't recompute Date math (and so the labels in the perf log stay correct).
  const past30Start = past30StartParallel
  const past180Start = past180StartParallel

  // SELECT '*' would give us day_types automatically; we list columns explicitly,
  // so we also need to coerce day_types to a typed array (it's a Postgres text[]
  // but the supabase-js type only surfaces it when the column exists).
  const recentDaysBase = (recentResult.data ?? []).map(d => {
    const row = d as Record<string, unknown> & Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type' | 'ai_analysis_json' | 'eod_ai_analysis_json'>
    return {
      ...row,
      day_types: Array.isArray(row.day_types) ? (row.day_types as string[]) : null,
    }
  })

  // Trade stats per day (count + setup tags + summed pnl + MFE/MAE inputs) —
  // one batched query, grouped in code. PnL is needed so the dashboard can
  // fall back to sum(trades.pnl) when the user hasn't saved an explicit
  // eod_pnl override yet. high_during_position / low_during_position +
  // direction + entry_price + symbol + quantity feed the per-day avg
  // MFE / MAE computed below.
  type TradeSlim = {
    id: string
    trading_day_id: string
    entry_time: string | null
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
    // Per-trade Wilder ATR-10 at entry minute, populated by
    // scripts/backfill-entry-metrics.ts. Replaces the dashboard's old
    // bars-fetch-and-recompute pass (which paid 500-600ms cold latency per
    // load). When null (e.g. pre-2025 trades), falls back to day-level
    // market_context.atr_1m via the same precedence the dashboard had before.
    entry_atr_1m: number | null
    // Needed by the scaling-aware MFE-capture calc (captureComponents): the
    // per-leg exits + any backfilled per-leg $. Without exits_json the dashboard
    // silently fell back to the harsh full-qty capture, so a scaled-out trade
    // read LOWER here than on the EOD recap (which has the full trade data).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exits_json: any
    mfe_dollars_per_leg: number | null
  }
  const dayIds = recentDaysBase.map(d => d.id)
  // Chunk trading_day_ids for the .in() — 50 UUIDs per chunk to stay under
  // PostgREST URL-length limits (same pattern as /api/metric-buckets).
  // Trades pagination per chunk: range() up to PAGE_SIZE per loop because a
  // busy 6-month chunk could exceed the 1000-row Supabase cap.
  async function fetchTradesAll(): Promise<TradeSlim[]> {
    if (dayIds.length === 0) return []
    const CHUNK = 50
    const out: TradeSlim[] = []
    for (let i = 0; i < dayIds.length; i += CHUNK) {
      const slice = dayIds.slice(i, i + CHUNK)
      for (let p = 0; p < 50; p++) {
        const { data, error } = await supabase
          .from('trades')
          .select('id, trading_day_id, entry_time, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, exits_json, mfe_dollars_per_leg')
          .in('trading_day_id', slice)
          .order('id', { ascending: true })
          .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
        if (error) throw new Error(`trades: ${error.message}`)
        const batch = (data ?? []) as TradeSlim[]
        out.push(...batch)
        if (batch.length < PAGE_SIZE) break
      }
    }
    return out
  }
  async function fetchContexts(): Promise<{ trading_day_id: string; atr_1m: number | null }[]> {
    if (dayIds.length === 0) return []
    const CHUNK = 50
    const out: { trading_day_id: string; atr_1m: number | null }[] = []
    for (let i = 0; i < dayIds.length; i += CHUNK) {
      const slice = dayIds.slice(i, i + CHUNK)
      const { data } = await supabase
        .from('market_context')
        .select('trading_day_id, atr_1m')
        .in('trading_day_id', slice)
      if (data) out.push(...(data as { trading_day_id: string; atr_1m: number | null }[]))
    }
    return out
  }
  const [tradesAll, contextsRaw] = await Promise.all([fetchTradesAll(), fetchContexts()])
  tick('tradesAll + contexts', tradesAll.length)
  const tradesRaw: TradeSlim[] = tradesAll
  const tradesByDay = new Map<string, TradeSlim[]>()
  for (const t of (tradesRaw ?? []) as TradeSlim[]) {
    const arr = tradesByDay.get(t.trading_day_id) ?? []
    arr.push(t)
    tradesByDay.set(t.trading_day_id, arr)
  }
  const prepAtrByDay = new Map<string, number | null>()
  for (const c of (contextsRaw ?? []) as { trading_day_id: string; atr_1m: number | null }[]) {
    prepAtrByDay.set(c.trading_day_id, c.atr_1m)
  }

  // Per-trade LIVE ATR: read from trades.entry_atr_1m, populated by
  // scripts/backfill-entry-metrics.ts (Wilder ATR-10 at the trade's entry
  // minute, computed from 1m bars at backfill time). Previously the
  // dashboard fetched 14+ sym-day bars-of-day from `ohlcv_bars` and
  // recomputed `liveAtr()` per-trade on every request — paid 500-600ms cold
  // latency per load for a value that already lives in the DB. New SC
  // imports also populate this column at insert time. Falls back silently to
  // prep_atr (market_context.atr_1m) when entry_atr_1m is null (pre-2025
  // trades that predate the backfill cutoff).
  const liveAtrByTradeId = new Map<string, number>()
  for (const t of (tradesRaw ?? []) as TradeSlim[]) {
    if (t.entry_atr_1m != null && t.entry_atr_1m > 0) {
      liveAtrByTradeId.set(t.id, t.entry_atr_1m)
    }
  }
  tick('liveAtr from entry_atr_1m', liveAtrByTradeId.size)

  const recentDays = recentDaysBase.map(d => {
    const trades = tradesByDay.get(d.id) ?? []
    // Top 2 most-frequent setups across the day's trades.
    const setupCounts = new Map<string, number>()
    for (const t of trades) {
      const setups = (t.tags_json?.setups ?? []) as string[]
      for (const s of setups) setupCounts.set(s, (setupCounts.get(s) ?? 0) + 1)
    }
    // Full sorted-by-frequency setups list — drives the filter dropdown and
    // any future "main setups" display column (just slice the first N).
    const setupsAll = Array.from(setupCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([s]) => s)
    // Displayed PnL: explicit eod_pnl override wins; else sum of trades; else null
    // (so the row shows "—" for days with no trades and no manual override).
    const summedPnl = trades.reduce((acc, t) => acc + (t.pnl ?? 0), 0)
    const displayedPnl = d.eod_pnl != null
      ? d.eod_pnl
      : trades.length > 0 ? summedPnl : null
    // Win rate: wins / total trades. Null when the day has no trades —
    // dividing by zero would be misleading, and "0%" reads as "all losses".
    const tradesWithPnl = trades.filter(t => t.pnl != null)
    const winsOnDay = tradesWithPnl.filter(t => (t.pnl ?? 0) > 0).length
    const winRate = tradesWithPnl.length > 0
      ? (winsOnDay / tradesWithPnl.length) * 100
      : null

    // Avg MFE / MAE per trade for the day. Per-trade definitions:
    //   long:  MFE = high - entry,   MAE = entry - low
    //   short: MFE = entry - low,    MAE = high - entry
    // Both stored as positive magnitudes — display layer applies sign.
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
        // Floor at 0 — MFE/MAE are non-negative excursion magnitudes. A trade
        // that never went adverse has MAE = 0, not a negative value that would
        // cancel out real heat in the day's average. Mirrors mfeMaePoints().
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

    // Day-level execution quality: avg MFE capture % and avg MAE loss ×R.
    // Cast trades to TradeWithExcursion[] via unknown — TradeSlim has the
    // fields the helpers actually read; id/trading_day_id/entry_time/tags_json
    // are unused by the helpers but kept in TradeSlim for other code paths.
    const xcTrades = trades as unknown as TradeWithExcursion[]
    const captureStats = avgCaptureRatio(xcTrades)
    const heatStats = avgMaeHeatRatio(xcTrades)

    // Live ATR averaged across the day's trades — replaces prep_atr for the
    // dashboard "in ATR" display. Falls back to prep_atr when bars are
    // missing (older days before SCID import).
    let avgLiveAtr1m: number | null = null
    let liveAtrCount = 0
    let liveAtrSum = 0
    for (const t of trades) {
      const v = liveAtrByTradeId.get(t.id)
      if (v != null) { liveAtrSum += v; liveAtrCount++ }
    }
    if (liveAtrCount > 0) avgLiveAtr1m = liveAtrSum / liveAtrCount

    // ×ATR average that MATCHES the EOD recap's AvgMfeMaeCard: the mean of
    // per-trade (excursion / that trade's OWN entry_atr_1m), skipping trades
    // without a live entry ATR. The dashboard historically divided the day's
    // AVG points by the AVG ATR (ratio-of-averages) over a mismatched trade
    // set — numerator counted every excursion trade, denominator only the
    // ATR-bearing ones — so it diverged from the EOD card whenever ATR varied
    // across trades or a no-ATR (e.g. GBX) trade was present. Average-of-ratios
    // over the same skip-null set reconciles the two surfaces exactly.
    let avgMfeAtr: number | null = null
    let avgMaeAtr: number | null = null
    {
      let mfeAtrSum = 0, maeAtrSum = 0, n = 0
      for (const t of mfeMaeTrades) {
        const atr = liveAtrByTradeId.get(t.id)
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
      id: d.id,
      date: d.date,
      eod_pnl: displayedPnl,
      day_type: d.day_type,
      // Multi-select array (Option C in the dashboard layout discussion).
      // Falls back to [day_type] when the array is empty/null so legacy days
      // (saved before the array column landed) still render their chip.
      day_types: (d.day_types && d.day_types.length > 0)
        ? d.day_types
        : (d.day_type ? [d.day_type] : []),
      trade_count: trades.length,
      // Trade-level win counts — feeds the per-trade win rate stat card
      // (distinct from `win_rate` which is the same value but per-day, used
      // for the table row's own column). Stored as raw counts so the client
      // can sum across a period and divide once for the aggregate rate.
      trade_wins: winsOnDay,
      trades_with_pnl_count: tradesWithPnl.length,
      setups: setupsAll,
      process_score: d.ai_analysis_json?.score ?? null,
      // overall_grade: prefer v1.3+ execution.composite (0..1 scaled to 0..10
      // and rounded) over the legacy `score` field.
      //
      // v1.4 null-composite case: if the EOD AI ran v1.4 (execution object
      // present) but couldn't compute a composite because zero trades passed
      // every per-trade rule, return 0 rather than null. "0 execution" is
      // semantically correct — every trade either breached or had no data
      // to score against — and it stops the dashboard from showing "—" as
      // if the analysis hadn't run yet.
      overall_grade: (() => {
        const j = d.eod_ai_analysis_json
        const composite = j?.execution?.composite
        if (composite != null) return Math.round(composite * 10)
        if (j?.execution != null) return 0   // ran but couldn't aggregate → 0
        return j?.score ?? null
      })(),
      // v1.3 Process: binary verdict (Compliant / Breach, threshold-relaxed to
      // 5/7 per 2026-06-08 amendment) + a 0-10 derived from "rules that didn't
      // fail" out of 7. P7 incomplete is tolerated per spec.
      process_verdict: (() => {
        const p = d.eod_ai_analysis_json?.process
        return p?.verdict ?? null
      })(),
      // v1.4 (2026-06-08 amendment 3): Process is now 5 hard safety-rail
      // rules (P1-P5). Score is Math.round((pass_count / 5) * 10). Legacy
      // rows analyzed pre-amendment may have P1-P7 in their data; only the
      // new P1-P5 IDs are counted, so legacy rows will appear understated
      // (their old P5/P6/P7 entries don't map to anything). Re-running the
      // analyze-session button on those days will refresh under v1.4.
      process_v13_score: (() => {
        const p = d.eod_ai_analysis_json?.process
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
      process_breach_rules: (() => {
        const p = d.eod_ai_analysis_json?.process
        if (!p?.per_rule) return null
        const ruleIds = ['P1', 'P2', 'P3', 'P4', 'P5'] as const
        const failed: string[] = []
        for (const id of ruleIds) {
          const r = p.per_rule[id]
          if (!r) continue
          // v1.4: all 5 rules are enforcement-critical. No incomplete tier.
          if (r.status === 'fail' || r.status === 'incomplete') failed.push(id)
        }
        return failed
      })(),
      win_rate: winRate,
      avg_mfe_pts: avgMfePts,
      avg_mae_pts: avgMaePts,
      avg_mfe_dollars: avgMfeDollars,
      avg_mae_dollars: avgMaeDollars,
      avg_capture: captureStats.avg,    // 0..1 fraction, or null
      avg_heat: heatStats.avg,          // 0..n× of planned stop (displayed as %), or null
      atr_1m: prepAtrByDay.get(d.id) ?? null,
      avg_live_atr_1m: avgLiveAtr1m,
      live_atr_count: liveAtrCount,
      // Per-trade average-of-ratios ×ATR (matches the EOD AvgMfeMaeCard).
      // Null when no trade on the day had a live entry ATR.
      avg_mfe_atr: avgMfeAtr,
      avg_mae_atr: avgMaeAtr,
    }
  })

  // Global filter dropdown values — distinct setups and day types across the
  // 180-day window. Empty strings filtered out. day_types is the array
  // column so combo-tag days contribute every label to the filter list.
  const allSetups = Array.from(new Set(recentDays.flatMap(d => d.setups))).sort()
  const allDayTypes = Array.from(
    new Set(recentDays.flatMap(d => d.day_types).map(s => s.trim()).filter(Boolean)),
  ).sort()
  const windowStart = past180Start
  const windowEnd = today
  const defaultFilterStart = past30Start // list view defaults to "last 30 days"; calendar view defaults to current month

  // Stats dataset: lightweight projection of recentDays for the
  // period-selectable DashboardStats component. Includes all days fetched
  // (start-of-last-year → today) so the client can switch among Week / Month /
  // 30d / YTD / Last Year without another round trip.
  const statsDays: DayStat[] = recentDays.map(d => ({
    date: d.date,
    eod_pnl: d.eod_pnl,
    trade_wins: d.trade_wins,
    trades_with_pnl_count: d.trades_with_pnl_count,
    avg_mfe_pts: d.avg_mfe_pts,
    avg_mae_pts: d.avg_mae_pts,
    avg_mfe_dollars: d.avg_mfe_dollars,
    avg_mae_dollars: d.avg_mae_dollars,
    atr_1m: d.atr_1m,
    avg_live_atr_1m: d.avg_live_atr_1m,
    process_score: d.process_score,
    process_v13_score: d.process_v13_score,
    // Execution composite (0-10) + Process verdict piped through so the
    // dashboard card can show median Execution / Compliance rate.
    overall_grade: d.overall_grade,
    process_verdict: d.process_verdict,
  }))

  // Recent Days table still scopes to the 180d window — keeps the table fast
  // and matches the user's "recent" expectation.
  const recentDaysForTable = recentDays.filter(d => d.date >= past180Start)

  // Beginner-mode data (docs/BEGINNER_PRO_MODES.md): plain-English 30-day
  // summary + one "focus" derived from the same capture math Pro shows raw +
  // a simple recent-session list. All computed here so the client view is dumb.
  const beginner30 = recentDays.filter(d => d.date >= past30Start && d.eod_pnl != null)
  const beginnerPnl = beginner30.reduce((a, d) => a + (d.eod_pnl ?? 0), 0)
  const beginnerGreenDays = beginner30.filter(d => (d.eod_pnl ?? 0) > 0).length
  const beginnerTradedDays = beginner30.length
  const beginnerBestDay = beginner30.length ? Math.max(...beginner30.map(d => d.eod_pnl ?? 0)) : null
  const beginnerWorstDay = beginner30.length ? Math.min(...beginner30.map(d => d.eod_pnl ?? 0)) : null
  const greenPnls = beginner30.filter(d => (d.eod_pnl ?? 0) > 0).map(d => d.eod_pnl as number)
  const redPnls = beginner30.filter(d => (d.eod_pnl ?? 0) < 0).map(d => d.eod_pnl as number)
  const avgGreenDay = greenPnls.length ? greenPnls.reduce((a, b) => a + b, 0) / greenPnls.length : null
  const avgRedDay = redPnls.length ? redPnls.reduce((a, b) => a + b, 0) / redPnls.length : null   // negative
  const capVals = recentDays
    .filter(d => d.date >= past30Start && d.avg_capture != null)
    .map(d => d.avg_capture as number)
  const avgCap = capVals.length ? capVals.reduce((a, b) => a + b, 0) / capVals.length : null
  // Trade win rate + capture % over the 30-day window — plain "how am I doing"
  // signals for the Beginner summary (same numbers Pro shows, plainly labeled).
  const beginnerWinWindow = recentDays.filter(d => d.date >= past30Start)
  const beginnerWins = beginnerWinWindow.reduce((a, d) => a + d.trade_wins, 0)
  const beginnerTradesWithPnl = beginnerWinWindow.reduce((a, d) => a + d.trades_with_pnl_count, 0)
  const beginnerWinRate = beginnerTradesWithPnl > 0 ? (beginnerWins / beginnerTradesWithPnl) * 100 : null
  const beginnerCapturePct = avgCap != null ? Math.round(avgCap * 100) : null
  const beginnerFocus = (() => {
    if (beginnerTradedDays === 0) return 'Log or import a few sessions and your #1 focus will show up here.'
    if (avgCap != null && avgCap < 0.5) return `You're exiting winners early — on average you keep about ${Math.round(avgCap * 100)}% of the move you're offered. This week, try holding to your planned target before you take profit.`
    if (avgCap != null) return `Your exits are solid — you're capturing about ${Math.round(avgCap * 100)}% of the move. Keep that up and put your attention on entry timing.`
    // No capture data yet (imports without stops/MFE) — coach from win rate + how
    // your green vs red days size up, so it still says something specific.
    if (beginnerPnl < 0) {
      if (avgRedDay != null && avgGreenDay != null && Math.abs(avgRedDay) > avgGreenDay) {
        return `You're down over the last 30 days, and your red days are bigger than your green ones. The fastest fix isn't more winners — it's cutting losers sooner. Pick a hard daily loss limit and honor it.`
      }
      return `You're down over the last 30 days. Get selective — track which setups actually make you money and skip the rest.`
    }
    if (beginnerWinRate != null && beginnerWinRate < 50) {
      return `You're green even at a ${Math.round(beginnerWinRate)}% win rate — your winners are outsizing your losers, which is a real edge. Protect it by keeping every loss small.`
    }
    if (beginnerWinRate != null) {
      return `A ${Math.round(beginnerWinRate)}% win rate and green overall — strong. Your next gain is size discipline: don't hand back a good stretch on one oversized trade.`
    }
    return 'Green over the last 30 days. Keep logging every session — the more you tag, the sharper this gets.'
  })()
  const beginnerSessions = recentDaysForTable.slice(0, 6).map(d => ({
    date: d.date,
    pnl: d.eod_pnl,
    note: beginnerDayNote({
      winRate: d.win_rate,
      capture: d.avg_capture,
      pnl: d.eod_pnl,
      breach: (d.process_breach_rules?.length ?? 0) > 0,
      avgWin: beginnerWinRate,
      avgCap,
      bestDay: beginnerBestDay,
      worstDay: beginnerWorstDay,
    }),
  }))

  tick('per-day computation loop')
  console.log('[dashboard perf]', perf.phases.map(p => `${p.name}=${p.ms}ms${p.rows != null ? ` (${p.rows})` : ''}`).join(' | '))

  // First-run empty state: the account has no trades and no logged days in the
  // whole stats window (and hasn't even opened today). Show an onboarding CTA
  // instead of empty stat cards / an empty Recent Days table.
  const isEmptyAccount =
    tradesAll.length === 0 && recentDaysBase.length === 0

  if (isEmptyAccount) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>

        <EmptyStateImport today={today} />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">{format(new Date(`${today}T12:00:00`), 'EEEE, MMMM d, yyyy')}</p>
        </div>
      </div>

      {/* Top-of-page performance charts: cumulative equity curve + per-day
          net P&L bars. Replaces the old "Today" quick-action tiles. */}
      <DashboardCharts days={statsDays} />

      {/* Beginner (default) = plain summary + one focus + simple session list.
          Pro = the full instrument (period stats grid + Recent Days table). */}
      <DashboardModeSwitch
        beginner={
          <BeginnerDashboard
            pnl={beginnerPnl}
            winRate={beginnerWinRate}
            capturePct={beginnerCapturePct}
            greenDays={beginnerGreenDays}
            tradedDays={beginnerTradedDays}
            bestDay={beginnerBestDay}
            focus={beginnerFocus}
            sessions={beginnerSessions}
          />
        }
      >
        {/* Period-selectable stats: P&L, Day Win %, Trade Win %, Avg MFE/MAE,
            Median Process. Filters by Week / Month / 30d / YTD / Last Year. */}
        <DashboardStats days={statsDays} />

        {/* Recent days */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mt-6">
          <RecentDaysSection
            initialDays={recentDaysForTable}
            allSetups={allSetups}
            allDayTypes={allDayTypes}
            windowStart={windowStart}
            windowEnd={windowEnd}
            defaultFilterStart={defaultFilterStart}
          />
        </div>
      </DashboardModeSwitch>
    </div>
  )
}

