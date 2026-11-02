'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  startOfWeek, endOfWeek, addMonths, subMonths, isSameMonth, isToday as fnsIsToday,
} from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DayRowData } from './RecentDaysList'
import ScoreChip from './ScoreChip'

interface Props {
  days: DayRowData[]
  windowStart: string // YYYY-MM-DD — earliest data point we have
  windowEnd: string   // YYYY-MM-DD — latest data point (typically today)
  /** The month to open on ("2026-09") — the dashboard passes the month its
   *  period ends in. Defaults to this month. */
  initialMonth?: string
  /** Rendered at the right end of the header (the List / Calendar switch). */
  toggle?: ReactNode
}

/**
 * Monthly review calendar (founder, 2026-10-31 — "Dashboard clean-up" mockup).
 *
 * Trading days only: Mon–Fri, then a Week column with each week's result.
 * Saturday and Sunday come back only in a month that has a session on one.
 * Each day shows its result in whole dollars, "N trades · X% won", and its
 * TapeScore on the score chip; a bar along the bottom runs to the day's high
 * and fills to where it closed (founder, 2026-11-02; was the day's size against
 * the month's biggest day). (2026-11-01 — the scoreboard
 * look: white cells, green and red for money only). Cells open
 * `/session/{date}`.
 */
export default function MonthlyCalendarView({ days, windowStart, windowEnd, initialMonth, toggle }: Props) {
  const today = useMemo(() => new Date(), [])
  const [cursor, setCursor] = useState<Date>(() =>
    initialMonth && /^\d{4}-\d{2}$/.test(initialMonth) ? new Date(`${initialMonth}-01T12:00:00`) : today,
  )

  const byDate = useMemo(() => new Map(days.map(d => [d.date, d])), [days])

  const monthStart = startOfMonth(cursor)
  const monthEnd = endOfMonth(cursor)
  const monthFrom = format(monthStart, 'yyyy-MM-dd')
  const monthTo = format(monthEnd, 'yyyy-MM-dd')
  const monthDays = days.filter(d => d.date >= monthFrom && d.date <= monthTo)

  // Weekends only when this month traded on one.
  const weekendTraded = monthDays.some(d => {
    const dow = new Date(`${d.date}T12:00:00`).getDay()
    return (dow === 0 || dow === 6) && d.trade_count > 0
  })
  const allCells = eachDayOfInterval({
    start: startOfWeek(monthStart, { weekStartsOn: 1 }),
    end: endOfWeek(monthEnd, { weekStartsOn: 1 }),
  })
  const weeks: Date[][] = []
  for (let i = 0; i < allCells.length; i += 7) {
    const week = allCells.slice(i, i + 7)
    const shown = weekendTraded ? week : week.slice(0, 5)
    // A month that starts on a weekend (or ends on one) would leave a row of
    // blank weekdays — skip it.
    if (shown.some(d => isSameMonth(d, cursor))) weeks.push(shown)
  }
  const dow = weekendTraded ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

  const traded = monthDays.filter(d => d.trade_count > 0)
  const monthPnl = monthDays.reduce((s, d) => s + (d.eod_pnl ?? 0), 0)
  const monthTrades = traded.reduce((s, d) => s + d.trade_count, 0)

  const weekStats = weeks.map(week => {
    const dates = new Set(week.filter(d => isSameMonth(d, cursor)).map(d => format(d, 'yyyy-MM-dd')))
    const wkDays = traded.filter(d => dates.has(d.date))
    return { pnl: wkDays.reduce((s, d) => s + (d.eod_pnl ?? 0), 0), traded: wkDays.length }
  })

  const prevMonth = subMonths(cursor, 1)
  const nextMonth = addMonths(cursor, 1)
  const prevDisabled = format(endOfMonth(prevMonth), 'yyyy-MM-dd') < windowStart
  const nextDisabled = format(startOfMonth(nextMonth), 'yyyy-MM-dd') > windowEnd
  const isViewingCurrentMonth = format(cursor, 'yyyy-MM') === format(today, 'yyyy-MM')

  const cols = weekendTraded ? 'grid-cols-[repeat(7,minmax(0,1fr))_minmax(0,0.9fr)]' : 'grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,0.9fr)]'

  return (
    <div className="space-y-3">
      {/* Header: month + arrows, the month's numbers, the view switch. */}
      <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
        <div className="flex items-center gap-1">
          {/* The month label IS the picker — a native month input, so any
              month is one jump away instead of one click per month. */}
          <label className="relative">
            <span className="font-bold text-gray-100 text-[20px] sm:text-[22px] pointer-events-none" style={{ fontFamily: 'var(--font-display)' }}>
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
            onClick={() => setCursor(prevMonth)}
            disabled={prevDisabled}
            className="ml-1 text-gray-400 hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed p-1 rounded hover:bg-gray-800"
            title="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(nextMonth)}
            disabled={nextDisabled}
            className="text-gray-400 hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed p-1 rounded hover:bg-gray-800"
            title="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isViewingCurrentMonth && (
            <button
              type="button"
              onClick={() => setCursor(today)}
              className="ml-1 text-xs text-gray-400 hover:text-gray-100 border border-gray-700 rounded px-2 py-0.5"
            >
              This month
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-x-4 gap-y-1 flex-wrap text-[13px] text-gray-400">
          <span>
            Net{' '}
            <b className={monthPnl > 0 ? 'text-green-400' : monthPnl < 0 ? 'text-red-400' : 'text-gray-300'}>{fmtUsd(monthPnl)}</b>
          </span>
          <span>{traded.length} day{traded.length === 1 ? '' : 's'}</span>
          <span>{monthTrades} trade{monthTrades === 1 ? '' : 's'}</span>
          {toggle}
        </div>
      </div>

      <div className={`grid ${cols} gap-1 sm:gap-1.5`}>
        {[...dow, 'Week'].map(d => (
          <div key={d} className="text-[12px] sm:text-[13px] text-gray-500 px-1 pb-0.5">{d}</div>
        ))}
        {weeks.map((week, wi) => [
          ...week.map(date => (
            <DayCell
              key={format(date, 'yyyy-MM-dd')}
              date={date}
              cursor={cursor}
              data={byDate.get(format(date, 'yyyy-MM-dd'))}
            />
          )),
          <WeekCell key={`w${wi}`} n={wi + 1} pnl={weekStats[wi].pnl} traded={weekStats[wi].traded} />,
        ])}
      </div>

      <p className="text-[12.5px] text-gray-400">
        The bar under each day runs to the day&apos;s high (its best point, counting closed trades) and fills to where it closed, so a short fill means you gave some back. A pale red bar: it was up, then closed red.
        The chip is the day&apos;s TapeScore: green 70+, amber 50–69, red under 50.
        <span className="sm:hidden"> Amounts are rounded here (1.3k = $1,300) — tap a day for the full session.</span>
      </p>
    </div>
  )
}

/** "+$1,293" / "-$413" / "$0" — whole dollars. */
function fmtUsd(n: number): string {
  const abs = Math.abs(Math.round(n)).toLocaleString('en-US')
  return n > 0.5 ? `+$${abs}` : n < -0.5 ? `-$${abs}` : '$0'
}

/** Whole dollars on wide screens; on a phone the cell is ~45px, so it reads
 *  "+852" / "+1.3k" / "-413" instead. */
function Amount({ n }: { n: number }) {
  return (
    <>
      <span className="sm:hidden">{fmtShort(n)}</span>
      <span className="hidden sm:inline">{fmtUsd(n)}</span>
    </>
  )
}

function fmtShort(n: number): string {
  const a = Math.abs(n)
  const body = a >= 999.5 ? `${(a / 1000).toFixed(a >= 9950 ? 0 : 1)}k` : String(Math.round(a))
  return n > 0.5 ? `+${body}` : n < -0.5 ? `-${body}` : '0'
}

/** "11 trades · 36% won", with the small cases said in words. */
function tradesLine(count: number, winRate: number | null): string {
  const t = `${count} trade${count === 1 ? '' : 's'}`
  if (winRate == null) return t
  const pct = Math.round(winRate)
  if (count === 1) return `${t} · ${pct >= 50 ? 'won' : 'lost'}`
  if (pct >= 100) return `${t} · ${count === 2 ? 'both' : 'all'} won`
  if (pct <= 0) return `${t} · none won`
  return `${t} · ${pct}% won`
}

function WeekCell({ n, pnl, traded }: { n: number; pnl: number; traded: number }) {
  return (
    <div className="min-h-[64px] sm:min-h-[84px] border-l border-gray-800 pl-1.5 sm:pl-3 py-1 sm:py-2 flex flex-col gap-0.5 text-[11px] sm:text-[13px] text-gray-500 min-w-0">
      <span><span className="hidden sm:inline">Week </span><span className="sm:hidden">W</span>{n}</span>
      {traded === 0 ? (
        <span className="hidden sm:inline">No trades</span>
      ) : (
        <>
          <b
            className={`text-[12px] sm:text-[16px] tabular-nums whitespace-nowrap ${pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-300'}`}
            style={{ fontFamily: 'var(--font-display)' }}
          >
            <Amount n={pnl} />
          </b>
          <span>{traded}<span className="hidden sm:inline"> day{traded === 1 ? '' : 's'}</span><span className="sm:hidden">d</span></span>
        </>
      )}
    </div>
  )
}

/** How much of the day's high it kept: full width = the high (realized),
 *  the fill = the close. Null when the day never got above zero. */
function keptOfHigh(data: DayRowData | undefined): { fill: number; high: number; pnl: number; gaveBack: number } | null {
  const high = data?.glance_read?.high?.peak ?? null
  const pnl = data?.eod_pnl ?? null
  if (high == null || pnl == null || high <= 0) return null
  const top = Math.max(high, pnl)
  return { fill: pnl > 0 ? Math.min(100, (pnl / top) * 100) : 0, high: top, pnl, gaveBack: Math.max(0, top - pnl) }
}

function DayCell({ date, cursor, data }: {
  date: Date
  cursor: Date
  data: DayRowData | undefined
}) {
  const inMonth = isSameMonth(date, cursor)
  // Days outside the month are blank, not greyed numbers.
  if (!inMonth) return <div className="min-h-[64px] sm:min-h-[84px]" aria-hidden="true" />

  const isToday = fnsIsToday(date)
  const dateStr = format(date, 'yyyy-MM-dd')
  const dom = format(date, 'd')
  const pnl = data?.eod_pnl ?? null
  const hasTrades = !!data && data.trade_count > 0

  // Traded days are outlined; days without trades are a quiet fill.
  const shade = hasTrades ? 'border border-gray-800 hover:border-gray-600' : 'bg-gray-950/60 border border-transparent hover:border-gray-800'
  const pnlTone = pnl != null && pnl > 0 ? 'text-green-400' : pnl != null && pnl < 0 ? 'text-red-400' : 'text-gray-300'
  const kept = hasTrades ? keptOfHigh(data) : null
  // Worth a word when the day gave back a real slice of its high.
  const gaveBackNote = kept && kept.gaveBack >= 20 && kept.gaveBack >= kept.high * 0.1
    ? (kept.pnl > 0 ? `kept ${Math.round(kept.fill)}% of ${fmtUsd(kept.high).slice(1)}` : `was up ${fmtUsd(kept.high).slice(1)}`)
    : null

  return (
    <Link
      href={`/session/${dateStr}`}
      title={kept ? `High ${fmtUsd(kept.high)}, closed ${fmtUsd(kept.pnl)}` : undefined}
      className={`relative overflow-hidden min-h-[64px] sm:min-h-[84px] rounded-lg p-1 sm:p-2 pb-2 sm:pb-3 flex flex-col gap-0.5 min-w-0 transition-colors ${shade} ${isToday ? 'ring-2 ring-blue-500/70' : ''}`}
    >
      <div className="flex items-center justify-between gap-0.5">
        <span className={`text-[11px] sm:text-[12px] ${isToday ? 'text-blue-300 font-semibold' : hasTrades ? 'text-gray-300' : 'text-gray-500'}`}>{dom}</span>
        {hasTrades && (data.tapescore
          ? <ScoreChip score={data.tapescore.score} className="text-[10px] sm:text-[12px] px-1 sm:px-1.5" />
          : <span className="hidden md:inline text-[11px] text-gray-500 whitespace-nowrap">no score yet</span>)}
      </div>
      {hasTrades && (
        <>
          {pnl != null && (
            <b className={`text-[12px] sm:text-[16px] tabular-nums whitespace-nowrap ${pnlTone}`} style={{ fontFamily: 'var(--font-display)' }}>
              <Amount n={pnl} />
            </b>
          )}
          <span className="hidden sm:block text-[12px] text-gray-400 leading-snug">{tradesLine(data.trade_count, data.win_rate)}</span>
          {gaveBackNote && <span className="hidden sm:block text-[12px] text-gray-500 leading-snug">{gaveBackNote}</span>}
        </>
      )}
      {kept && (
        <span className={`absolute left-0 right-0 bottom-0 h-1 ${kept.pnl > 0 ? 'bg-green-400/25' : 'bg-red-400/30'}`} aria-hidden="true">
          <span className="block h-full bg-green-400" style={{ width: `${kept.fill}%` }} />
        </span>
      )}
    </Link>
  )
}
