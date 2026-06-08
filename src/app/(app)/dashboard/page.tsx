import { createClient } from '@/lib/supabase/server'
import { format, subDays } from 'date-fns'
import Link from 'next/link'
import { ClipboardList, Activity, BarChart2 } from 'lucide-react'
import RecentDaysSection from '@/components/dashboard/RecentDaysSection'
import DashboardStats, { type DayStat } from '@/components/dashboard/DashboardStats'
import { symbolToMultiplier } from '@/lib/futures-symbols'
import { avgCaptureRatio, avgMaeHeatRatio, type TradeWithExcursion } from '@/lib/analytics'
import { liveAtr, fetchAllBars, type AtrBar } from '@/lib/atr'
import type { TradingDay } from '@/lib/supabase/types'

const PAGE_SIZE = 1000

// Disable static generation so the date is recomputed on every request
// (otherwise this page caches and shows stale "today" across midnight).
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DashboardPage() {
  const today = format(new Date(), 'yyyy-MM-dd')
  const supabase = await createClient()

  const { data: todayRecordRaw } = await supabase
    .from('trading_days')
    .select('*')
    .eq('date', today)
    .single()
  const todayRecord = todayRecordRaw as TradingDay | null

  // Two windows:
  //   - past180Start: drives the Recent Days table + the expensive per-trade
  //     ATR/bars loop. Unchanged from before — keeps the table snappy.
  //   - statsWindowStart: drives the period-selectable stat cards (Week /
  //     Month / 30d / YTD / Last Year). Walks back to the start of LAST year
  //     so "Last Year" has the full ~365-day window even on Dec 31.
  const todayDate = new Date()
  const past30Start = format(subDays(todayDate, 30), 'yyyy-MM-dd')
  const past180Start = format(subDays(todayDate, 180), 'yyyy-MM-dd')
  const statsWindowStart = `${todayDate.getFullYear() - 1}-01-01`
  const { data: recentDaysRaw } = await supabase
    .from('trading_days')
    .select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json')
    .gte('date', statsWindowStart)
    .order('date', { ascending: false })
    .limit(PAGE_SIZE)
  // SELECT '*' would give us day_types automatically; we list columns explicitly,
  // so we also need to coerce day_types to a typed array (it's a Postgres text[]
  // but the supabase-js type only surfaces it when the column exists).
  const recentDaysBase = (recentDaysRaw ?? []).map(d => {
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
  }
  const dayIds = recentDaysBase.map(d => d.id)
  const dayDateById = new Map<string, string>(recentDaysBase.map(d => [d.id, d.date]))
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
          .select('id, trading_day_id, entry_time, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol')
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

  // Per-trade LIVE ATR: compute ATR-10 Wilder from 1-min bars at each trade's
  // entry_time. The dashboard's "in ATR" display previously divided MFE/MAE
  // by the day's prep ATR (one value, possibly hours stale by trade time);
  // this replaces that with the actual ATR reading at the trade's moment.
  //
  // Fetch strategy: one query per distinct (symbol, date) that actually has
  // trades. ~390 1-min bars per RTH day, well under the 1000-row Supabase
  // cap. Concurrent fetches via Promise.all so 30 days of bar loads run in
  // parallel instead of serialized. Falls back silently to prep_atr when bars
  // are missing for that date+symbol (e.g., historical data before SCID
  // import) so the dashboard always renders something.
  const symbolDatePairs = new Set<string>()
  const tradesNeedingAtr: TradeSlim[] = []
  for (const t of (tradesRaw ?? []) as TradeSlim[]) {
    if (!t.symbol || !t.entry_time) continue
    const date = dayDateById.get(t.trading_day_id)
    if (!date) continue
    // Skip ATR for days outside the Recent Days window — the older days
    // only feed the stats cards, which don't use ATR. Avoids dozens of
    // wasted bars/ATR fetches for the YTD/Last-Year period.
    if (date < past180Start) continue
    symbolDatePairs.add(`${t.symbol}|${date}`)
    tradesNeedingAtr.push(t)
  }
  const barsBySymbolDate = new Map<string, AtrBar[]>()
  await Promise.all(
    Array.from(symbolDatePairs).map(async key => {
      const [symbol, date] = key.split('|')
      const bars = await fetchAllBars(supabase, symbol, date)
      barsBySymbolDate.set(key, bars)
    }),
  )
  const liveAtrByTradeId = new Map<string, number>()
  for (const t of tradesNeedingAtr) {
    const date = dayDateById.get(t.trading_day_id)!
    const bars = barsBySymbolDate.get(`${t.symbol}|${date}`)
    if (!bars || bars.length === 0) continue
    const value = liveAtr(bars, new Date(t.entry_time!), 10)
    if (value != null) liveAtrByTradeId.set(t.id, value)
  }

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
        const mfe = isLong
          ? (t.high_during_position! - t.entry_price!)
          : (t.entry_price! - t.low_during_position!)
        const mae = isLong
          ? (t.entry_price! - t.low_during_position!)
          : (t.high_during_position! - t.entry_price!)
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
      // overall_grade: prefer the v1.3 execution.composite (0..1, scaled to 0..10
      // and rounded) over the legacy `score` field. Without the round, composite
      // * 10 prints as a long float (0.59 → 5.8999999989999995) in the pill.
      overall_grade: (() => {
        const j = d.eod_ai_analysis_json
        const composite = j?.execution?.composite
        if (composite != null) return Math.round(composite * 10)
        return j?.score ?? null
      })(),
      // v1.3 Process: binary verdict (Compliant / Breach, threshold-relaxed to
      // 5/7 per 2026-06-08 amendment) + a 0-10 derived from "rules that didn't
      // fail" out of 7. P7 incomplete is tolerated per spec.
      process_verdict: (() => {
        const p = d.eod_ai_analysis_json?.process
        return p?.verdict ?? null
      })(),
      process_v13_score: (() => {
        const p = d.eod_ai_analysis_json?.process
        if (!p?.per_rule) return null
        const ruleIds = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const
        let passCount = 0
        for (const id of ruleIds) {
          const r = p.per_rule[id]
          if (!r) continue
          if (r.status === 'pass') passCount += 1
          else if (r.status === 'incomplete' && id === 'P7') passCount += 1
        }
        return Math.round((passCount / 7) * 10)
      })(),
      process_breach_rules: (() => {
        const p = d.eod_ai_analysis_json?.process
        if (!p?.per_rule) return null
        const ruleIds = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const
        const failed: string[] = []
        for (const id of ruleIds) {
          const r = p.per_rule[id]
          if (!r) continue
          if (r.status === 'fail') failed.push(id)
          else if (r.status === 'incomplete' && id !== 'P7') failed.push(id)
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
  }))

  // Recent Days table still scopes to the 180d window — keeps the table fast
  // and matches the user's "recent" expectation.
  const recentDaysForTable = recentDays.filter(d => d.date >= past180Start)

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1">{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>
      </div>

      {/* Today's quick actions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-white">Today</h2>
          <span className="text-xs text-gray-500">{format(new Date(), 'MM/dd/yyyy')}</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <TodayAction
            href={`/prep/${today}`}
            icon={<ClipboardList className="w-5 h-5" />}
            label="Daily Prep"
            status={todayRecord?.prep_notes_json && Object.keys(todayRecord.prep_notes_json).length > 0 ? 'done' : 'pending'}
          />
          <TodayAction
            href={`/intraday/${today}`}
            icon={<Activity className="w-5 h-5" />}
            label="Intraday"
            // Cascade: once the day is wrapped (EOD notes saved), intraday is
            // implicitly done — you can't be in the session anymore. Tile flips
            // green so the Today row visually reads "fully closed out".
            status={todayRecord?.eod_notes ? 'done' : todayRecord?.id ? 'available' : 'locked'}
          />
          <TodayAction
            href={`/eod/${today}`}
            icon={<BarChart2 className="w-5 h-5" />}
            label="EOD Recap"
            status={todayRecord?.eod_notes ? 'done' : todayRecord?.id ? 'available' : 'locked'}
          />
        </div>
      </div>

      {/* Period-selectable stats: P&L, Day Win %, Trade Win %, Avg MFE/MAE,
          Median Process. Filters by Week / Month / 30d / YTD / Last Year. */}
      <DashboardStats days={statsDays} />

      {/* Recent days */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <RecentDaysSection
          initialDays={recentDaysForTable}
          allSetups={allSetups}
          allDayTypes={allDayTypes}
          windowStart={windowStart}
          windowEnd={windowEnd}
          defaultFilterStart={defaultFilterStart}
        />
      </div>
    </div>
  )
}

function TodayAction({ href, icon, label, status }: {
  href: string
  icon: React.ReactNode
  label: string
  status: 'done' | 'pending' | 'available' | 'locked'
}) {
  const styles = {
    done: 'border-green-800 bg-green-950/30 text-green-400',
    pending: 'border-blue-700 bg-blue-950/30 text-blue-400 hover:bg-blue-950/50',
    available: 'border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700',
    locked: 'border-gray-800 bg-gray-900 text-gray-600 cursor-not-allowed opacity-50',
  }

  if (status === 'locked') {
    return (
      <div className={`flex flex-col items-center gap-2 p-4 rounded-lg border ${styles[status]}`}>
        {icon}
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs opacity-60">Complete prep first</span>
      </div>
    )
  }

  return (
    <Link href={href} className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${styles[status]}`}>
      {icon}
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs opacity-60">{status === 'done' ? 'Completed' : 'Start'}</span>
    </Link>
  )
}

