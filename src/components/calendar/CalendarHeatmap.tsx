'use client'

import Link from 'next/link'
import { format, eachMonthOfInterval, eachDayOfInterval, startOfMonth, endOfMonth, getDay } from 'date-fns'
import type { CalendarDay } from '@/lib/calendar-insights'

export type ColorMode = 'tapescore' | 'pnl'

interface Props {
  days: CalendarDay[]
  startDate: string  // YYYY-MM-DD
  endDate: string    // YYYY-MM-DD
  colorMode: ColorMode
}

const DOW_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * Multi-month calendar. In 'tapescore' mode each traded day is colored by its
 * decision-grade band (green ≥70 / amber 50–69 / red <50; neutral = ungraded)
 * with the score + P&L centered and a breach dot on rule-break days. In 'pnl'
 * mode it falls back to the classic money heatmap. Cells link to /eod/{date}.
 */
export default function CalendarHeatmap({ days, startDate, endDate, colorMode }: Props) {
  const byDate = new Map(days.map(s => [s.date, s]))
  const allPnls = days.map(s => s.pnl).filter(p => Number.isFinite(p))
  const maxAbs = allPnls.length > 0 ? Math.max(...allPnls.map(Math.abs), 1) : 1

  const start = new Date(`${startDate}T12:00:00`)
  const end = new Date(`${endDate}T12:00:00`)
  const months = eachMonthOfInterval({ start, end })

  return (
    <div className="grid gap-5 md:grid-cols-2">
      {months.map(m => (
        <MonthGrid key={m.toISOString()} month={m} byDate={byDate} maxAbs={maxAbs} colorMode={colorMode} />
      ))}
    </div>
  )
}

/** Band → cell background + score text color (tapescore mode). */
function bandStyle(day: CalendarDay): { bg: string; text: string } {
  if (day.tapescore == null) return { bg: 'rgba(75,85,99,0.22)', text: 'text-gray-400' }
  if (day.band === 'high') return { bg: 'rgba(78,166,114,0.16)', text: 'text-green-400' }
  if (day.band === 'mid') return { bg: 'rgba(224,163,60,0.15)', text: 'text-amber-400' }
  return { bg: 'rgba(217,105,90,0.15)', text: 'text-red-400' }
}

function pnlStyle(day: CalendarDay, maxAbs: number): { bg: string; text: string } {
  const intensity = Math.min(1, Math.abs(day.pnl) / maxAbs)
  if (day.pnl === 0) return { bg: 'rgba(75,85,99,0.4)', text: 'text-gray-400' }
  const positive = day.pnl > 0
  return {
    bg: positive ? `rgba(34,197,94,${0.22 + 0.6 * intensity})` : `rgba(239,68,68,${0.22 + 0.6 * intensity})`,
    text: intensity > 0.5 ? 'text-white' : positive ? 'text-green-200' : 'text-red-200',
  }
}

function shortMoney(n: number): string {
  const a = Math.abs(n)
  const s = a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : String(Math.round(a))
  return `${n < 0 ? '-' : '+'}$${s}`
}

function MonthGrid({ month, byDate, maxAbs, colorMode }: {
  month: Date
  byDate: Map<string, CalendarDay>
  maxAbs: number
  colorMode: ColorMode
}) {
  const monthStart = startOfMonth(month)
  const monthEnd = endOfMonth(month)
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd })

  const firstDow = (getDay(monthStart) + 6) % 7 // Mon=0
  const cells: (Date | null)[] = Array(firstDow).fill(null).concat(days)
  while (cells.length % 7 !== 0) cells.push(null)

  const monthDays = days.map(d => byDate.get(format(d, 'yyyy-MM-dd'))).filter((s): s is CalendarDay => s != null)
  const monthPnl = monthDays.reduce((s, d) => s + d.pnl, 0)
  const scored = monthDays.filter(d => d.tapescore != null)
  const avgScore = scored.length ? Math.round(scored.reduce((s, d) => s + (d.tapescore as number), 0) / scored.length) : null

  const todayStr = format(new Date(), 'yyyy-MM-dd')

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="font-semibold text-white text-sm">{format(month, 'MMMM yyyy')}</h3>
        <div className="text-xs">
          {avgScore != null && <span className="text-amber-400">TS {avgScore}</span>}
          <span className={`ml-2 ${monthPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {monthPnl >= 0 ? '+' : ''}${Math.round(monthPnl).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {DOW_LABELS.map((d, i) => (
          <div key={i} className="text-[9px] text-gray-600 text-center font-medium uppercase tracking-wider">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="min-h-[46px]" />
          const dateStr = format(d, 'yyyy-MM-dd')
          const day = byDate.get(dateStr)
          const dom = format(d, 'd')
          const isToday = dateStr === todayStr

          if (!day || day.trade_count === 0) {
            return (
              <Link
                key={i}
                href={`/eod/${dateStr}`}
                className={`min-h-[46px] rounded flex items-start justify-start p-1 text-[9px] text-gray-700 hover:bg-gray-800 transition-colors border ${isToday ? 'border-amber-500/60' : 'border-gray-800/40'}`}
                title={`${format(d, 'EEE, MMM d, yyyy')} — no trades`}
              >
                {dom}
              </Link>
            )
          }

          const { bg, text } = colorMode === 'tapescore' ? bandStyle(day) : pnlStyle(day, maxAbs)
          const center = colorMode === 'tapescore'
            ? (day.tapescore == null ? '—' : String(day.tapescore))
            : shortMoney(day.pnl)

          const tip = `${format(d, 'EEE, MMM d, yyyy')} · ${day.trade_count} trade${day.trade_count === 1 ? '' : 's'} · TapeScore ${day.tapescore ?? '—'} · ${day.pnl >= 0 ? '+' : ''}$${day.pnl.toFixed(2)}${day.breach ? ' · rule breach' : ''}${day.day_type ? ` · ${day.day_type}` : ''}`

          return (
            <Link
              key={i}
              href={`/eod/${dateStr}`}
              className={`relative min-h-[46px] rounded flex flex-col items-center justify-center hover:ring-2 hover:ring-blue-400 transition-all ${isToday ? 'ring-2 ring-amber-500/70' : ''}`}
              style={{ backgroundColor: bg }}
              title={tip}
            >
              <span className="absolute top-0.5 left-1 text-[8px] text-gray-500 leading-none">{dom}</span>
              {day.breach && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-red-400" title="rule breach" />}
              <span className={`text-sm font-bold leading-none ${text}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{center}</span>
              {colorMode === 'tapescore' && (
                <span className={`text-[8.5px] font-semibold leading-none mt-0.5 ${day.pnl >= 0 ? 'text-green-300/80' : 'text-red-300/80'}`}>
                  {shortMoney(day.pnl)}
                </span>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
