'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  format, parse, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, addMonths, subMonths, isSameMonth, isToday as fnsIsToday,
} from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DayRowData } from './RecentDaysList'

interface Props {
  days: DayRowData[]
  windowStart: string // YYYY-MM-DD — earliest data point we have
  windowEnd: string   // YYYY-MM-DD — latest data point (typically today)
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Monthly review calendar.
 *
 * Renders one month at a time as a 7-column grid (Sunday-first), with a
 * sidebar of weekly rollups. Each day cell shows PnL, trade count, win
 * rate %, and the AI overall grade (color-banded). Cells are clickable
 * shortcuts to `/eod/{date}`.
 *
 * Month navigation is bounded by the data window passed in from the
 * dashboard server query (currently 180 days). For long-range views
 * beyond that, the Calendar tab in the sidebar is the home — different
 * tool, larger window, no per-day richness.
 */
export default function MonthlyCalendarView({ days, windowStart, windowEnd }: Props) {
  const today = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState<Date>(today)

  const byDate = useMemo(() => new Map(days.map(d => [d.date, d])), [days])

  const monthStart = startOfMonth(cursor)
  const monthEnd = endOfMonth(cursor)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
  const allCells = eachDayOfInterval({ start: gridStart, end: gridEnd })

  // Group into rows of 7
  const weeks: Date[][] = []
  for (let i = 0; i < allCells.length; i += 7) weeks.push(allCells.slice(i, i + 7))

  // Monthly rollup (across actual month days only)
  const monthDays = days.filter(d => {
    const dStr = d.date
    return dStr >= format(monthStart, 'yyyy-MM-dd') && dStr <= format(monthEnd, 'yyyy-MM-dd')
  })
  const monthPnl = monthDays.reduce((s, d) => s + (d.eod_pnl ?? 0), 0)
  const monthTraded = monthDays.filter(d => d.trade_count > 0).length

  // Weekly rollups (across each grid row, in-month days only)
  const weekStats = weeks.map(week => {
    const dates = new Set(week.filter(d => isSameMonth(d, cursor)).map(d => format(d, 'yyyy-MM-dd')))
    const wkDays = monthDays.filter(d => dates.has(d.date))
    const pnl = wkDays.reduce((s, d) => s + (d.eod_pnl ?? 0), 0)
    const traded = wkDays.filter(d => d.trade_count > 0).length
    return { pnl, traded }
  })

  // Navigation bounds — only allow nav into months we have data for
  const prevMonth = subMonths(cursor, 1)
  const nextMonth = addMonths(cursor, 1)
  const prevDisabled = format(endOfMonth(prevMonth), 'yyyy-MM-dd') < windowStart
  const nextDisabled = format(startOfMonth(nextMonth), 'yyyy-MM-dd') > windowEnd
  const isViewingCurrentMonth = format(cursor, 'yyyy-MM') === format(today, 'yyyy-MM')

  const fmtPnl = (n: number): string => {
    const sign = n > 0 ? '+' : n < 0 ? '-' : ''
    const abs = Math.abs(n)
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`
    return `${sign}$${abs.toFixed(0)}`
  }

  return (
    <div className="space-y-3">
      {/* Header: month nav (left) + monthly stats (right) */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor(prevMonth)}
            disabled={prevDisabled}
            className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed p-1.5 rounded hover:bg-gray-800"
            title="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-semibold text-white text-base w-44 text-center">
            {format(cursor, 'MMMM yyyy')}
          </span>
          <button
            type="button"
            onClick={() => setCursor(nextMonth)}
            disabled={nextDisabled}
            className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed p-1.5 rounded hover:bg-gray-800"
            title="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isViewingCurrentMonth && (
            <button
              type="button"
              onClick={() => setCursor(today)}
              className="ml-2 text-xs text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2.5 py-1"
            >
              This month
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">Monthly:</span>
          <span className={`font-mono font-semibold px-2 py-0.5 rounded ${
            monthPnl > 0 ? 'bg-green-950/60 text-green-300'
            : monthPnl < 0 ? 'bg-red-950/60 text-red-300'
            : 'bg-gray-800 text-gray-400'
          }`}>
            {fmtPnl(monthPnl)}
          </span>
          <span className="text-xs text-gray-400 font-mono bg-gray-800 px-2 py-0.5 rounded">
            {monthTraded} day{monthTraded === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Grid + week sidebar */}
      <div className="flex gap-3">
        <div className="flex-1 min-w-0">
          {/* DOW header */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW.map(d => (
              <div key={d} className="text-center text-[10px] text-gray-500 font-medium uppercase tracking-wider py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Week rows */}
          <div className="space-y-1">
            {weeks.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7 gap-1">
                {week.map(date => (
                  <DayCell
                    key={format(date, 'yyyy-MM-dd')}
                    date={date}
                    cursor={cursor}
                    data={byDate.get(format(date, 'yyyy-MM-dd'))}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Week sidebar */}
        <div className="w-28 flex flex-col gap-1 flex-shrink-0">
          {/* Spacer to align with DOW header */}
          <div className="h-[26px]" />
          {weekStats.map((s, i) => (
            <div
              key={i}
              className="bg-gray-800 border border-gray-700 rounded-lg p-2 flex-1 flex flex-col justify-center"
            >
              <div className="text-[10px] text-gray-500">Week {i + 1}</div>
              <div className={`text-xs font-mono font-semibold mt-0.5 ${
                s.pnl > 0 ? 'text-green-400'
                : s.pnl < 0 ? 'text-red-400'
                : 'text-gray-500'
              }`}>
                {s.traded === 0 ? '—' : fmtPnl(s.pnl)}
              </div>
              {s.traded > 0 && (
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {s.traded} day{s.traded === 1 ? '' : 's'}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DayCell({
  date,
  cursor,
  data,
}: {
  date: Date
  cursor: Date
  data: DayRowData | undefined
}) {
  const inMonth = isSameMonth(date, cursor)
  const isToday = fnsIsToday(date)
  const dateStr = format(date, 'yyyy-MM-dd')
  const dom = format(date, 'd')
  const pnl = data?.eod_pnl
  const hasTrades = data && data.trade_count > 0

  // Color by PnL when there are trades; muted otherwise
  let cellStyle = 'bg-gray-900/40 border-gray-800/60'
  if (!inMonth) {
    cellStyle = 'bg-gray-900/20 border-gray-800/40'
  } else if (hasTrades && pnl != null) {
    if (pnl > 0) cellStyle = 'bg-green-900/30 border-green-800/60 hover:border-green-600'
    else if (pnl < 0) cellStyle = 'bg-red-900/30 border-red-800/60 hover:border-red-600'
    else cellStyle = 'bg-gray-800/60 border-gray-700 hover:border-gray-500'
  } else if (data) {
    cellStyle = 'bg-gray-900/60 border-gray-800 hover:border-gray-600'
  }

  const todayRing = isToday ? 'ring-2 ring-blue-500/70' : ''

  const fmtPnlShort = (n: number): string => {
    const sign = n > 0 ? '+' : n < 0 ? '-' : ''
    const abs = Math.abs(n)
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`
    return `${sign}$${abs.toFixed(0)}`
  }

  const gradeStyle = (g: number) =>
    g >= 9 ? 'border-green-700/60 text-green-300 bg-green-950/60'
    : g >= 7 ? 'border-blue-700/60 text-blue-300 bg-blue-950/60'
    : g >= 5 ? 'border-yellow-700/60 text-yellow-300 bg-yellow-950/60'
    : 'border-red-700/60 text-red-300 bg-red-950/60'

  const content = (
    <div className={`relative aspect-square p-1.5 rounded-md border transition-colors ${cellStyle} ${todayRing}`}>
      {/* Grade pill — top-left */}
      {inMonth && data?.overall_grade != null && (
        <div className={`absolute top-1 left-1 text-[9px] font-mono font-bold border rounded px-1 leading-tight ${gradeStyle(data.overall_grade)}`}>
          Gr {data.overall_grade}
        </div>
      )}

      {/* Day number — top-right */}
      <div className={`absolute top-1 right-1.5 text-[11px] font-medium ${
        !inMonth ? 'text-gray-700'
        : isToday ? 'text-blue-300 font-semibold'
        : 'text-gray-400'
      }`}>
        {dom}
      </div>

      {/* Center stack: PnL + trades + winrate */}
      {inMonth && hasTrades && pnl != null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-3 px-1">
          <div className={`text-sm font-bold font-mono leading-tight ${
            pnl > 0 ? 'text-green-300' : pnl < 0 ? 'text-red-300' : 'text-gray-300'
          }`}>
            {fmtPnlShort(pnl)}
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {data.trade_count} trade{data.trade_count === 1 ? '' : 's'}
          </div>
          {data.win_rate != null && (
            <div className="text-[10px] text-gray-500">
              {data.win_rate.toFixed(1)}%
            </div>
          )}
        </div>
      )}
    </div>
  )

  // Days with data OR within month → navigable. Out-of-month padding cells
  // are not clickable (cleaner UX, avoids accidental nav to neighboring month).
  if (inMonth) {
    return (
      <Link href={`/eod/${dateStr}`} className="block">
        {content}
      </Link>
    )
  }
  return content
}
