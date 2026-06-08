'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * Period-selectable stat cards for the dashboard header.
 *
 * Receives the full server-fetched day stats (start-of-last-year → today) and
 * filters client-side on the chosen period. Period is persisted to
 * localStorage so refreshes don't reset to "30d".
 *
 * Stat cards:
 *   1. P&L                — sum of eod_pnl over period
 *   2. Day Win Rate       — % of days with eod_pnl > 0 (only counts days that
 *                            traded; zero-trade days are excluded)
 *   3. Trade Win Rate     — sum(trade_wins) / sum(trades_with_pnl_count)
 *   4. Avg MFE/MAE        — averaged across days that have those stats
 *   5. Median Process     — median of ai_analysis_json.score (process_score)
 */

/** Minimal day-stat shape needed for the cards. Avoids depending on the full
 *  DayRowData (which carries the unused setups list / bars-derived stuff). */
export interface DayStat {
  date: string                       // YYYY-MM-DD
  eod_pnl: number | null
  trade_wins: number
  trades_with_pnl_count: number
  avg_mfe_pts: number | null
  avg_mae_pts: number | null
  avg_mfe_dollars: number | null
  avg_mae_dollars: number | null
  /** Prep-time ATR (market_context.atr_1m) — fallback ATR ref when live bars
   *  are missing for the day. */
  atr_1m: number | null
  /** Per-trade live ATR-10 averaged across the day's trades. Preferred ATR
   *  ref over prep_atr when present. */
  avg_live_atr_1m: number | null
  /** Prep AI's 1-10 quality score (column is `process_score` for legacy
   *  storage-layer reasons; the user-facing label is "Prep"). */
  process_score: number | null
  /** v1.4 Process verdict-derived 0-10 score = Math.round(passCount/5*10).
   *  Null on days where the EOD AI hasn't run, or on legacy pre-v1.4 rows
   *  where the dashboard reader couldn't compute it. */
  process_v13_score: number | null
}

type MfeUnit = 'pts' | 'dollars' | 'atr'
const UNIT_KEY = 'dashboard-stat-mfe-unit-v1'

type Period = 'week' | 'month' | '30d' | 'ytd' | 'last_year'
const PERIOD_KEY = 'dashboard-stat-period-v1'

const PERIOD_LABELS: Record<Period, string> = {
  week: 'This Week',
  month: 'This Month',
  '30d': 'Last 30 Days',
  ytd: 'Year to Date',
  last_year: 'Last Year',
}

/** Inclusive date bounds (YYYY-MM-DD strings) for each period, computed
 *  relative to "today" on the client (cheap; no need for server input). */
function periodBounds(period: Period): { start: string; end: string } {
  const now = new Date()
  const today = ymd(now)
  switch (period) {
    case 'week': {
      // Monday → today (matches ISO week start; most traders think Mon-Fri).
      const day = now.getDay() // 0=Sun .. 6=Sat
      const daysSinceMon = (day + 6) % 7
      const start = new Date(now)
      start.setDate(now.getDate() - daysSinceMon)
      return { start: ymd(start), end: today }
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { start: ymd(start), end: today }
    }
    case '30d': {
      const start = new Date(now)
      start.setDate(now.getDate() - 30)
      return { start: ymd(start), end: today }
    }
    case 'ytd': {
      const start = new Date(now.getFullYear(), 0, 1)
      return { start: ymd(start), end: today }
    }
    case 'last_year': {
      const year = now.getFullYear() - 1
      return { start: `${year}-01-01`, end: `${year}-12-31` }
    }
  }
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

interface Props {
  /** Server-fetched DayStat list spanning start-of-last-year → today. */
  days: DayStat[]
}

export default function DashboardStats({ days }: Props) {
  const [period, setPeriod] = useState<Period>('30d')
  // Default unit is ATR — it's the user's preferred ATR-normalized reading
  // for the MFE/MAE roll-up. localStorage hydration may overwrite below.
  const [mfeUnit, setMfeUnit] = useState<MfeUnit>('atr')
  // Hydrate from localStorage after mount so SSR matches initial render.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    try {
      const rawPeriod = localStorage.getItem(PERIOD_KEY) as Period | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (rawPeriod && rawPeriod in PERIOD_LABELS) setPeriod(rawPeriod)
      const rawUnit = localStorage.getItem(UNIT_KEY) as MfeUnit | null
      if (rawUnit === 'pts' || rawUnit === 'dollars' || rawUnit === 'atr') setMfeUnit(rawUnit)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* ignore */ }
  }, [period, hydrated])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(UNIT_KEY, mfeUnit) } catch { /* ignore */ }
  }, [mfeUnit, hydrated])

  const stats = useMemo(() => {
    const { start, end } = periodBounds(period)
    const inPeriod = days.filter(d => d.date >= start && d.date <= end)

    // P&L sum (skip null PnL days = no trades + no override)
    const pnl = inPeriod.reduce((s, d) => s + (d.eod_pnl ?? 0), 0)

    // Day win rate: % of TRADED days where pnl > 0. Days with no trades and no
    // explicit eod_pnl override are excluded so the denominator reflects
    // actual sessions.
    const tradedDays = inPeriod.filter(d => d.eod_pnl != null)
    const winDays = tradedDays.filter(d => (d.eod_pnl ?? 0) > 0).length
    const dayWinRate = tradedDays.length > 0 ? winDays / tradedDays.length : null

    // Trade win rate: pooled across the period.
    const totalTradeWins = inPeriod.reduce((s, d) => s + d.trade_wins, 0)
    const totalTradesWithPnl = inPeriod.reduce((s, d) => s + d.trades_with_pnl_count, 0)
    const tradeWinRate = totalTradesWithPnl > 0 ? totalTradeWins / totalTradesWithPnl : null

    // Avg MFE/MAE: averaged across days that have stats. Each day's value is
    // already a per-day average across that day's trades — averaging across
    // days gives equal weight per day (matches "what's a typical day look
    // like for me" framing).
    //
    // Per-unit computation:
    //   - pts: average of avg_mfe_pts / avg_mae_pts directly
    //   - dollars: average of avg_mfe_dollars / avg_mae_dollars (computed
    //     server-side with the contract multiplier × qty applied per trade)
    //   - atr: divide each day's pts MFE/MAE by that day's ATR ref
    //     (avg_live_atr_1m ?? atr_1m) then average — matches the Recent Days
    //     table's MfeMaeCell behavior so the dashboard rollup is consistent.
    let avgMfe: number | null = null
    let avgMae: number | null = null
    if (mfeUnit === 'pts') {
      const mfeVals = inPeriod.map(d => d.avg_mfe_pts).filter((v): v is number => v != null)
      const maeVals = inPeriod.map(d => d.avg_mae_pts).filter((v): v is number => v != null)
      avgMfe = mfeVals.length > 0 ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : null
      avgMae = maeVals.length > 0 ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : null
    } else if (mfeUnit === 'dollars') {
      const mfeVals = inPeriod.map(d => d.avg_mfe_dollars).filter((v): v is number => v != null)
      const maeVals = inPeriod.map(d => d.avg_mae_dollars).filter((v): v is number => v != null)
      avgMfe = mfeVals.length > 0 ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : null
      avgMae = maeVals.length > 0 ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : null
    } else {
      // atr
      const mfeAtr: number[] = []
      const maeAtr: number[] = []
      for (const d of inPeriod) {
        const atrRef = d.avg_live_atr_1m ?? d.atr_1m
        if (!atrRef || atrRef <= 0) continue
        if (d.avg_mfe_pts != null) mfeAtr.push(d.avg_mfe_pts / atrRef)
        if (d.avg_mae_pts != null) maeAtr.push(d.avg_mae_pts / atrRef)
      }
      avgMfe = mfeAtr.length > 0 ? mfeAtr.reduce((a, b) => a + b, 0) / mfeAtr.length : null
      avgMae = maeAtr.length > 0 ? maeAtr.reduce((a, b) => a + b, 0) / maeAtr.length : null
    }

    // Median Prep (prep AI 1-10) and Median Process (v1.4 verdict-derived
    // 0-10). Two separate medians on the same stat card — see render block.
    // Median preferred over mean to suppress outliers.
    const prepScores = inPeriod.map(d => d.process_score).filter((v): v is number => v != null)
    const medianPrep = median(prepScores)
    const v13Scores = inPeriod.map(d => d.process_v13_score).filter((v): v is number => v != null)
    const medianProcessV13 = median(v13Scores)

    return {
      pnl,
      dayWinRate,
      tradeWinRate,
      avgMfe,
      avgMae,
      medianProcess: medianPrep,    // legacy field name preserved for callers
      medianProcessV13,
      tradedDaysCount: tradedDays.length,
      totalTradesWithPnl,
      procCount: prepScores.length,
      v13Count: v13Scores.length,
    }
  }, [days, period, mfeUnit])

  return (
    <div className="mb-6">
      {/* Period selector */}
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-gray-500">Period:</label>
        <div className="relative">
          <select
            value={period}
            onChange={e => setPeriod(e.target.value as Period)}
            className="appearance-none bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-md pl-2 pr-7 py-1 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            {Object.entries(PERIOD_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
        </div>
      </div>

      {/* Stat cards. Order: P&L → Day Win % → Trade Win % → Avg MFE/MAE →
          Median Process. 5 columns fit fine on the standard >1100px dashboard
          width. */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard
          label={`${PERIOD_LABELS[period]} P&L`}
          value={(() => {
            // Sign before the dollar: "+$1,395" / "-$1,395" / "$0".
            // Previously was "$+1,395" — the sign-after-currency reads as
            // a typo on first scan.
            const abs = Math.abs(stats.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })
            if (stats.pnl > 0) return `+$${abs}`
            if (stats.pnl < 0) return `-$${abs}`
            return '$0'
          })()}
          tone={stats.pnl > 0 ? 'positive' : stats.pnl < 0 ? 'negative' : 'neutral'}
          sub={`${stats.tradedDaysCount} trading day${stats.tradedDaysCount === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Day Win %"
          value={stats.dayWinRate == null ? '—' : `${(stats.dayWinRate * 100).toFixed(0)}%`}
          tone={stats.dayWinRate == null ? 'neutral' : stats.dayWinRate >= 0.5 ? 'positive' : 'negative'}
          sub="% of days green"
        />
        <StatCard
          label="Trade Win %"
          value={stats.tradeWinRate == null ? '—' : `${(stats.tradeWinRate * 100).toFixed(0)}%`}
          tone={stats.tradeWinRate == null ? 'neutral' : stats.tradeWinRate >= 0.5 ? 'positive' : 'negative'}
          sub={`${stats.totalTradesWithPnl} trade${stats.totalTradesWithPnl === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Avg MFE / MAE"
          value={
            stats.avgMfe == null || stats.avgMae == null
              ? '—'
              : mfeUnit === 'dollars'
                ? `+$${Math.round(stats.avgMfe)} / -$${Math.round(stats.avgMae)}`
                : mfeUnit === 'atr'
                  ? `+${stats.avgMfe.toFixed(2)}× / -${stats.avgMae.toFixed(2)}×`
                  : `+${stats.avgMfe.toFixed(1)} / -${stats.avgMae.toFixed(1)}`
          }
          tone="neutral"
          // Sub becomes the unit selector itself. Compact inline dropdown
          // replaces the static "pts per trade" string so the card surfaces
          // the choice in the same visual slot.
          subNode={
            <select
              value={mfeUnit}
              onChange={e => setMfeUnit(e.target.value as MfeUnit)}
              className="bg-gray-800 border border-gray-700 text-gray-400 text-[10px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight"
              title="Display unit for Avg MFE / MAE"
            >
              <option value="pts">pts per trade</option>
              <option value="dollars">$ per trade</option>
              <option value="atr">× ATR per trade</option>
            </select>
          }
          valueClass="text-base"
        />
        {/* Stat card showing TWO medians: Prep (AI prep-quality 1-10) +
            Process (v1.4 verdict-derived 0-10 from passCount/5*10). Stacked
            vertically since they're related but measuring different things —
            single card avoids growing the row to 6 cards. */}
        <PrepAndProcessCard
          medianPrep={stats.medianProcess}
          prepCount={stats.procCount}
          medianProcess={stats.medianProcessV13}
          processCount={stats.v13Count}
        />
      </div>
    </div>
  )
}

function StatCard({
  label, value, tone, sub, subNode, valueClass,
}: {
  label: string
  value: string
  tone: 'positive' | 'negative' | 'neutral'
  sub?: string
  /** Rich subline (e.g. an inline <select>). Wins over `sub` when both set. */
  subNode?: React.ReactNode
  valueClass?: string
}) {
  const valueColor =
    tone === 'positive' ? 'text-green-400'
    : tone === 'negative' ? 'text-red-400'
    : 'text-gray-300'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1 whitespace-nowrap">{label}</p>
      <p className={`font-bold ${valueColor} ${valueClass ?? 'text-xl'} whitespace-nowrap`}>{value}</p>
      {subNode ? <div className="mt-1">{subNode}</div> : sub ? <p className="text-[10px] text-gray-600 mt-1 whitespace-nowrap">{sub}</p> : null}
    </div>
  )
}

/** Stat card that shows Median Prep AND Median Process side-by-side. Both
 *  are 0-10 but measure different things — Prep = AI prep-quality score
 *  (1-10 from /api/analyze-prep), Process = v1.4 verdict-derived score
 *  (passCount/5*10 from /api/analyze-eod). Stacked vertically to avoid
 *  blowing out the stat-card row to 6 cards. */
function PrepAndProcessCard({
  medianPrep, prepCount, medianProcess, processCount,
}: {
  medianPrep: number | null
  prepCount: number
  medianProcess: number | null
  processCount: number
}) {
  const toneColor = (v: number | null, goodThreshold: number, midThreshold: number): string => {
    if (v == null) return 'text-gray-500'
    if (v >= goodThreshold) return 'text-green-400'
    if (v >= midThreshold) return 'text-yellow-300'
    return 'text-red-400'
  }
  // Prep tones use the original 7/5 cutoffs the card had pre-change. Process
  // tones map to the v1.4 thresholds — ≥8 (4/5 pass = at-threshold Compliant)
  // is positive, anything lower trends toward red.
  const prepColor = toneColor(medianPrep, 7, 5)
  const procColor = toneColor(medianProcess, 8, 6)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1 whitespace-nowrap">Median Prep / Process</p>
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        <span className={`font-bold text-base ${prepColor}`}>
          {medianPrep == null ? '—' : `${medianPrep.toFixed(1)}`}
        </span>
        <span className="text-gray-600 text-xs">/</span>
        <span className={`font-bold text-base ${procColor}`}>
          {medianProcess == null ? '—' : `${medianProcess.toFixed(1)}`}
        </span>
        <span className="text-gray-600 text-xs">/10</span>
      </div>
      <p className="text-[10px] text-gray-600 mt-1 whitespace-nowrap">
        {prepCount} prep · {processCount} process
      </p>
    </div>
  )
}
