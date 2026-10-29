'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, addMonths, subMonths, isSameMonth, isToday as fnsIsToday,
} from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DayRowData } from './RecentDaysList'
import type { TapeScoreResult } from '@/lib/tapescore'

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
 * rate %, and the day's TapeScore (color-banded). Cells are clickable
 * shortcuts to `/review/today/{date}`.
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
    // Round the signed value, as the Days table does: rounding the absolute
    // value turned -$287.50 into -$288 here and -$287 there.
    return `${sign}$${Math.abs(Math.round(n))}`
  }

  return (
    <div className="space-y-3 max-w-3xl">
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
          {/* The month label IS the picker. Stepping one month per click is fine
              for "last month" and useless for "June" — from here that was
              fifteen clicks, with no way to see how far you had come. The
              navigable range is the whole account (windowStart is 2000-01-01),
              so the arrows were never the constraint; the absence of a way to
              jump was. Native month input: a real month+year picker, keyboard
              operable, and it still reads as the heading it replaced. */}
          <label className="relative w-44 text-center">
            <span className="font-semibold text-white text-base pointer-events-none">
              {format(cursor, 'MMMM yyyy')}
            </span>
            <input
              type="month"
              aria-label="Jump to month"
              title="Jump to any month"
              value={format(cursor, 'yyyy-MM')}
              min={windowStart.slice(0, 7)}
              max={windowEnd.slice(0, 7)}
              onChange={e => {
                const v = e.target.value
                if (/^\d{4}-\d{2}$/.test(v)) setCursor(startOfMonth(new Date(`${v}-01T12:00:00`)))
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </label>
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

      {/* Grid + week sidebar (sidebar drops below the grid on mobile so each
          day cell gets full width instead of being squeezed to ~a third) */}
      <div className="flex flex-col md:flex-row gap-3">
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

        {/* Week sidebar — vertical column beside the grid on desktop; tiles
            into a compact grid below the calendar on mobile. */}
        <div className="grid grid-cols-3 gap-1 md:flex md:flex-col md:w-28 md:flex-shrink-0">
          {/* Spacer to align with DOW header (desktop only) */}
          <div className="hidden md:block h-[26px]" />
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

/**
 * The day's TapeScore as a small dial — a ring filled to score/100 with the
 * number inside.
 *
 * It replaced a bare digit in this corner, which sat opposite the date and read
 * as a second date: two 1–2 digit numbers in one row with nothing saying which
 * was which. A ring can't be mistaken for a calendar number.
 *
 * The arc is the point, not decoration. Every other signal in the cell already
 * has a second channel — P&L has the green/red cell tint behind it — leaving
 * the score as the only one carried by a digit alone. Filling the ring gives a
 * bad run a shape: thin arcs down a column read before any number does.
 *
 * It reads the same 0-100 TapeScore, in the same three bands, as the Days
 * table's pill (2026-10-28). It used to read the retired 0-10 AI execution
 * grade, so the same day read 85 in the table and 7 here.
 *
 * 21px, so two digits fit inside the ring; a perfect 100 sets smaller.
 */
function ScoreDial({ result }: { result: TapeScoreResult }) {
  const { score, band } = result
  const stroke = band === 'high' ? 'stroke-green-400' : band === 'mid' ? 'stroke-amber-400' : 'stroke-red-400'
  const text = band === 'high' ? 'fill-green-300' : band === 'mid' ? 'fill-amber-300' : 'fill-red-300'

  const R = 8.4
  const C = 2 * Math.PI * R
  // Clamped so an out-of-range score can't wrap the ring past full.
  const filled = C * Math.max(0, Math.min(1, score / 100))

  return (
    <svg
      viewBox="0 0 21 21"
      className="w-[21px] h-[21px] shrink-0"
      role="img"
      aria-label={`TapeScore ${score} out of 100`}
    >
      <circle cx="10.5" cy="10.5" r={R} fill="none" strokeWidth="2.2" className="stroke-gray-700" />
      <circle
        cx="10.5" cy="10.5" r={R} fill="none" strokeWidth="2.2" strokeLinecap="round"
        strokeDasharray={`${filled} ${C - filled}`}
        transform="rotate(-90 10.5 10.5)"
        className={stroke}
      />
      {/* Size set inline rather than via a text-[…] utility: this is an SVG
          <text>, where the px value is a user-space unit inside the 21×21
          viewBox, not a page font size. */}
      <text
        x="10.5" y="10.5" textAnchor="middle" dominantBaseline="central"
        className={`${text} font-mono font-bold`}
        style={{ fontSize: score >= 100 ? 6 : 8 }}
      >
        {score}
      </text>
    </svg>
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
    return `${sign}$${Math.abs(Math.round(n))}`
  }

  const tapescore = inMonth ? data?.tapescore ?? null : null

  const content = (
    // A flex COLUMN with a reserved header row, not a box with the date
    // absolutely positioned over a centred stack. Previously the two shared
    // space and only avoided each other when the numbers happened to be short;
    // a five-character loss ran into the date. Now the body starts below the
    // header by construction.
    <div className={`aspect-square overflow-hidden px-1.5 pt-1 pb-1.5 rounded-md border transition-colors flex flex-col ${cellStyle} ${todayRing}`}>
      {/* Header — grade dial (left) opposite the date (right). */}
      <div className="flex items-center gap-1 min-h-[17px]">
        {inMonth && hasTrades && tapescore != null && <ScoreDial result={tapescore} />}
        <span className={`ml-auto text-[11px] leading-none font-semibold ${
          !inMonth ? 'text-gray-700 font-medium'
          : isToday ? 'text-blue-300'
          : 'text-gray-400'
        }`}>
          {dom}
        </span>
      </div>

      {/* Body — P&L leads, trades · win rate supports.
          Mobile keeps P&L and the dial and drops the supporting line: at that
          width it's the first thing to become unreadable, and the dial already
          carries the grade without needing to be read. */}
      {inMonth && hasTrades && (
        <div className="flex-1 flex flex-col items-center justify-center gap-1">
          {pnl != null && (
            <span className={`text-[13px] sm:text-[15px] font-mono font-bold leading-none tabular-nums tracking-tight whitespace-nowrap ${
              pnl > 0 ? 'text-green-300' : pnl < 0 ? 'text-red-300' : 'text-gray-300'
            }`}>
              {fmtPnlShort(pnl)}
            </span>
          )}
          <span className="hidden sm:block text-[9px] font-mono text-gray-500 leading-none tabular-nums">
            {data.trade_count}t{data.win_rate != null ? ` · ${data.win_rate.toFixed(0)}%` : ''}
          </span>
        </div>
      )}
    </div>
  )

  // Days with data OR within month → navigable. Out-of-month padding cells
  // are not clickable (cleaner UX, avoids accidental nav to neighboring month).
  if (inMonth) {
    return (
      <Link href={`/review/today/${dateStr}`} className="block">
        {content}
      </Link>
    )
  }
  return content
}
