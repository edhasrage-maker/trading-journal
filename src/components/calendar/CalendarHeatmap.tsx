'use client'

import Link from 'next/link'
import { format, eachMonthOfInterval, eachDayOfInterval, startOfMonth, endOfMonth, getDay } from 'date-fns'
import type { DaySummary } from '@/lib/analytics'

interface Props {
  summaries: DaySummary[]
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
}

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Multi-month calendar heatmap. Each month gets its own grid (Mon..Sun columns).
 * Cells are colored by daily PnL intensity, clickable to navigate to /eod/{date}.
 */
export default function CalendarHeatmap({ summaries, startDate, endDate }: Props) {
  const byDate = new Map(summaries.map(s => [s.date, s]))

  // Compute color intensity scaling across the visible window
  const allPnls = summaries.map(s => s.pnl).filter(p => Number.isFinite(p))
  const maxAbs = allPnls.length > 0 ? Math.max(...allPnls.map(Math.abs), 1) : 1

  const start = new Date(`${startDate}T12:00:00`)
  const end = new Date(`${endDate}T12:00:00`)
  const months = eachMonthOfInterval({ start, end })

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {months.map(m => (
        <MonthGrid
          key={m.toISOString()}
          month={m}
          byDate={byDate}
          maxAbs={maxAbs}
        />
      ))}
    </div>
  )
}

function MonthGrid({
  month,
  byDate,
  maxAbs,
}: {
  month: Date
  byDate: Map<string, DaySummary>
  maxAbs: number
}) {
  const monthStart = startOfMonth(month)
  const monthEnd = endOfMonth(month)
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd })

  // Pad leading days so the first day lands in its correct DOW column (Mon=0..Sun=6)
  const firstDow = (getDay(monthStart) + 6) % 7 // shift so Mon=0
  const cells: (Date | null)[] = Array(firstDow).fill(null).concat(days)
  // Pad trailing to multiple of 7
  while (cells.length % 7 !== 0) cells.push(null)

  const monthLabel = format(month, 'MMMM yyyy')
  const monthSummaries = days
    .map(d => byDate.get(format(d, 'yyyy-MM-dd')))
    .filter((s): s is DaySummary => s != null)
  const monthPnl = monthSummaries.reduce((s, d) => s + d.pnl, 0)
  const tradeDays = monthSummaries.filter(d => d.trade_count > 0).length

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-semibold text-white text-sm">{monthLabel}</h3>
        <div className="text-xs">
          <span className={monthPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
            {monthPnl >= 0 ? '+' : ''}${monthPnl.toFixed(0)}
          </span>
          <span className="text-gray-600 ml-2">{tradeDays} day{tradeDays === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* DOW header */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DOW_LABELS.map(d => (
          <div key={d} className="text-[9px] text-gray-600 text-center font-medium uppercase tracking-wider">
            {d.slice(0, 1)}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="aspect-square" />
          const dateStr = format(d, 'yyyy-MM-dd')
          const summary = byDate.get(dateStr)
          const dom = format(d, 'd')

          if (!summary || summary.trade_count === 0) {
            // Empty day — no trades, but maybe has prep notes; render as muted clickable
            return (
              <Link
                key={i}
                href={`/eod/${dateStr}`}
                className="aspect-square rounded flex items-center justify-center text-[9px] text-gray-700 hover:bg-gray-800 transition-colors border border-gray-800/40"
                title={`${format(d, 'EEE, MMM d, yyyy')} — no trades`}
              >
                {dom}
              </Link>
            )
          }

          const intensity = Math.min(1, Math.abs(summary.pnl) / maxAbs)
          const positive = summary.pnl > 0
          const neutral = summary.pnl === 0
          const bg = neutral
            ? 'rgba(75, 85, 99, 0.4)'
            : positive
              ? `rgba(34, 197, 94, ${0.25 + 0.65 * intensity})`
              : `rgba(239, 68, 68, ${0.25 + 0.65 * intensity})`
          const textColor = neutral ? 'text-gray-400' : intensity > 0.5 ? 'text-white' : positive ? 'text-green-200' : 'text-red-200'

          return (
            <Link
              key={i}
              href={`/eod/${dateStr}`}
              className={`aspect-square rounded flex items-center justify-center text-[10px] font-mono font-semibold ${textColor} hover:ring-2 hover:ring-blue-400 transition-all`}
              style={{ backgroundColor: bg }}
              title={`${format(d, 'EEE, MMM d, yyyy')} · ${summary.trade_count} trade${summary.trade_count === 1 ? '' : 's'} · ${summary.pnl >= 0 ? '+' : ''}$${summary.pnl.toFixed(2)}${summary.day_type ? ` · ${summary.day_type}` : ''}`}
            >
              {dom}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
