import { createClient } from '@/lib/supabase/server'
import { format, subDays } from 'date-fns'
import Link from 'next/link'
import { ClipboardList, Activity, BarChart2 } from 'lucide-react'
import RecentDaysSection from '@/components/dashboard/RecentDaysSection'
import { symbolToMultiplier } from '@/lib/sc-importer'
import type { TradingDay } from '@/lib/supabase/types'

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

  // Wider fetch (180 days) so the new monthly-calendar view in Recent Days
  // can navigate ~6 months back. The 30d stat cards below filter down to
  // last-30 explicitly so their semantics are unchanged.
  const past30Start = format(subDays(new Date(), 30), 'yyyy-MM-dd')
  const past180Start = format(subDays(new Date(), 180), 'yyyy-MM-dd')
  const { data: recentDaysRaw } = await supabase
    .from('trading_days')
    .select('id, date, eod_pnl, day_type, ai_analysis_json, eod_ai_analysis_json')
    .gte('date', past180Start)
    .order('date', { ascending: false })
    .limit(200)
  const recentDaysBase = (recentDaysRaw ?? []) as Array<Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type' | 'ai_analysis_json' | 'eod_ai_analysis_json'>>

  // Trade stats per day (count + setup tags + summed pnl + MFE/MAE inputs) —
  // one batched query, grouped in code. PnL is needed so the dashboard can
  // fall back to sum(trades.pnl) when the user hasn't saved an explicit
  // eod_pnl override yet. high_during_position / low_during_position +
  // direction + entry_price + symbol + quantity feed the per-day avg
  // MFE / MAE computed below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TradeSlim = {
    trading_day_id: string
    tags_json: any
    pnl: number | null
    direction: 'long' | 'short' | null
    entry_price: number | null
    high_during_position: number | null
    low_during_position: number | null
    quantity: number | null
    symbol: string | null
  }
  const dayIds = recentDaysBase.map(d => d.id)
  const { data: tradesRaw } = dayIds.length > 0
    ? await supabase
        .from('trades')
        .select('trading_day_id, tags_json, pnl, direction, entry_price, high_during_position, low_during_position, quantity, symbol')
        .in('trading_day_id', dayIds)
    : { data: [] as TradeSlim[] }
  const tradesByDay = new Map<string, TradeSlim[]>()
  for (const t of (tradesRaw ?? []) as TradeSlim[]) {
    const arr = tradesByDay.get(t.trading_day_id) ?? []
    arr.push(t)
    tradesByDay.set(t.trading_day_id, arr)
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

    return {
      id: d.id,
      date: d.date,
      eod_pnl: displayedPnl,
      day_type: d.day_type,
      trade_count: trades.length,
      setups: setupsAll,
      process_score: d.ai_analysis_json?.score ?? null,
      overall_grade: d.eod_ai_analysis_json?.score ?? null,
      win_rate: winRate,
      avg_mfe_pts: avgMfePts,
      avg_mae_pts: avgMaePts,
      avg_mfe_dollars: avgMfeDollars,
      avg_mae_dollars: avgMaeDollars,
    }
  })

  // Global filter dropdown values — distinct setups and day types across the
  // 30-day window. Empty strings filtered out.
  const allSetups = Array.from(new Set(recentDays.flatMap(d => d.setups))).sort()
  const allDayTypes = Array.from(
    new Set(recentDays.map(d => (d.day_type ?? '').trim()).filter(Boolean)),
  ).sort()
  const windowStart = past180Start
  const windowEnd = today
  const defaultFilterStart = past30Start // list view defaults to "last 30 days"; calendar view defaults to current month

  // 30d stat cards: explicitly compute from the last-30-day subset of the
  // 180-day fetched data, so labels stay accurate as we widened the fetch.
  const last30Days = recentDays.filter(d => d.date >= past30Start)
  const totalPnl = last30Days.reduce((sum, d) => sum + (d.eod_pnl ?? 0), 0)
  const winDays = last30Days.filter(d => (d.eod_pnl ?? 0) > 0).length
  const lossDays = last30Days.filter(d => (d.eod_pnl ?? 0) < 0).length
  const tradedDays = last30Days.filter(d => d.eod_pnl !== null).length
  const winRate = tradedDays > 0 ? winDays / tradedDays : 0

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
            status={todayRecord?.id ? 'available' : 'locked'}
          />
          <TodayAction
            href={`/eod/${today}`}
            icon={<BarChart2 className="w-5 h-5" />}
            label="EOD Recap"
            status={todayRecord?.eod_notes ? 'done' : todayRecord?.id ? 'available' : 'locked'}
          />
        </div>
      </div>

      {/* 30-day stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="30d P&L" value={`$${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}`} positive={totalPnl >= 0} />
        <StatCard label="Win Rate" value={`${(winRate * 100).toFixed(0)}%`} positive={winRate >= 0.5} />
        <StatCard label="Win Days" value={winDays.toString()} positive={true} />
        <StatCard label="Loss Days" value={lossDays.toString()} positive={false} />
      </div>

      {/* Recent days */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <RecentDaysSection
          initialDays={recentDays}
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

function StatCard({ label, value, positive }: { label: string; value: string; positive: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-xl font-bold ${positive ? 'text-green-400' : 'text-red-400'}`}>{value}</p>
    </div>
  )
}
