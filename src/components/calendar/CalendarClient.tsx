'use client'

import { useMemo, useState } from 'react'
import { format, subMonths } from 'date-fns'
import CalendarHeatmap from './CalendarHeatmap'
import type { DaySummary } from '@/lib/analytics'

interface Props {
  summaries: DaySummary[]
  defaultStartDate: string
  defaultEndDate: string
  dayTypes: string[]
}

const RANGE_OPTIONS: { label: string; months: number }[] = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: 'All', months: 0 },
]

export default function CalendarClient({ summaries, defaultStartDate, defaultEndDate, dayTypes }: Props) {
  const [rangeMonths, setRangeMonths] = useState(6)
  const [dayType, setDayType] = useState<string>('all')

  const today = format(new Date(), 'yyyy-MM-dd')
  const startDate = useMemo(() => {
    if (rangeMonths === 0) return defaultStartDate
    return format(subMonths(new Date(), rangeMonths), 'yyyy-MM-01')
  }, [rangeMonths, defaultStartDate])
  const endDate = today > defaultEndDate ? today : defaultEndDate

  const filtered = useMemo(() => {
    return summaries.filter(s => {
      if (s.date < startDate || s.date > endDate) return false
      if (dayType !== 'all' && (s.day_type ?? '').trim() !== dayType) return false
      return true
    })
  }, [summaries, startDate, endDate, dayType])

  // Stats over the filtered window
  const tradedDays = filtered.filter(d => d.trade_count > 0)
  const totalPnl = tradedDays.reduce((s, d) => s + d.pnl, 0)
  const winDays = tradedDays.filter(d => d.pnl > 0).length
  const lossDays = tradedDays.filter(d => d.pnl < 0).length
  const winRate = winDays + lossDays > 0 ? (winDays / (winDays + lossDays)) * 100 : 0
  const bestDay = tradedDays.reduce((best, d) => (d.pnl > (best?.pnl ?? -Infinity) ? d : best), null as DaySummary | null)
  const worstDay = tradedDays.reduce((worst, d) => (d.pnl < (worst?.pnl ?? Infinity) ? d : worst), null as DaySummary | null)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">Calendar</h1>

        <div className="flex items-center gap-3">
          {/* Range selector */}
          <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {RANGE_OPTIONS.map(o => (
              <button
                key={o.label}
                onClick={() => setRangeMonths(o.months)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  rangeMonths === o.months
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {/* Day type filter */}
          {dayTypes.length > 0 && (
            <select
              value={dayType}
              onChange={e => setDayType(e.target.value)}
              className="bg-gray-900 border border-gray-800 text-gray-300 text-xs font-medium rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All day types</option>
              {dayTypes.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Total PnL" value={`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`} positive={totalPnl >= 0} />
        <StatCard label="Trading Days" value={tradedDays.length.toString()} positive={null} />
        <StatCard label="Day Win Rate" value={`${winRate.toFixed(0)}%`} positive={winRate >= 50} />
        <StatCard
          label="Best Day"
          value={bestDay ? `+$${bestDay.pnl.toFixed(0)}` : '—'}
          hint={bestDay?.date ? format(new Date(bestDay.date + 'T12:00:00'), 'MMM d') : ''}
          positive={true}
        />
        <StatCard
          label="Worst Day"
          value={worstDay ? `-$${Math.abs(worstDay.pnl).toFixed(0)}` : '—'}
          hint={worstDay?.date ? format(new Date(worstDay.date + 'T12:00:00'), 'MMM d') : ''}
          positive={false}
        />
      </div>

      {/* Heatmap */}
      <CalendarHeatmap
        summaries={filtered}
        startDate={startDate}
        endDate={endDate}
      />

      {filtered.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
          No trading days in this range. Adjust the filters or start logging trades.
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, hint, positive }: { label: string; value: string; hint?: string; positive: boolean | null }) {
  const color = positive == null
    ? 'text-white'
    : positive
      ? 'text-green-400'
      : 'text-red-400'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      {hint && <p className="text-xs text-gray-600 mt-0.5">{hint}</p>}
    </div>
  )
}
