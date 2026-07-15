'use client'

import { useMemo, useState } from 'react'
import { format, subMonths } from 'date-fns'
import CalendarHeatmap, { type ColorMode } from './CalendarHeatmap'
import { computeCalendarInsights, type CalendarDay } from '@/lib/calendar-insights'
import { displayDayType } from '@/lib/day-type-display'

interface Props {
  days: CalendarDay[]
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

function money(n: number): string {
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`
}

/**
 * Discipline Calendar (Pt 11 revamp). Colored by the decision grade (TapeScore),
 * not P&L — P&L is demoted to a chip and a color-mode toggle keeps the classic
 * money heatmap one click away. Insight cards surface what only a calendar can:
 * weekday rhythm, rule-compliance streaks, and profitable-but-poorly-graded days.
 */
export default function CalendarClient({ days, defaultStartDate, defaultEndDate, dayTypes }: Props) {
  const [rangeMonths, setRangeMonths] = useState(6)
  const [dayType, setDayType] = useState<string>('all')
  const [colorMode, setColorMode] = useState<ColorMode>('tapescore')

  const today = format(new Date(), 'yyyy-MM-dd')
  const startDate = useMemo(() => {
    if (rangeMonths === 0) return defaultStartDate
    return format(subMonths(new Date(), rangeMonths), 'yyyy-MM-01')
  }, [rangeMonths, defaultStartDate])
  const endDate = today > defaultEndDate ? today : defaultEndDate

  const filtered = useMemo(() => {
    return days.filter(d => {
      if (d.date < startDate || d.date > endDate) return false
      if (dayType !== 'all' && !d.day_types.some(t => t.trim() === dayType)) return false
      return true
    })
  }, [days, startDate, endDate, dayType])

  const insights = useMemo(() => computeCalendarInsights(filtered), [filtered])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Calendar</h1>
          <p className="text-sm text-gray-400 mt-1">Your decisions over time — colored by TapeScore, not P&amp;L.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Color mode */}
          <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {(['tapescore', 'pnl'] as ColorMode[]).map(m => (
              <button
                key={m}
                onClick={() => setColorMode(m)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  colorMode === m ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
                title={m === 'tapescore' ? 'Color days by decision grade' : 'Color days by P&L'}
              >
                {m === 'tapescore' ? 'TapeScore' : 'P&L'}
              </button>
            ))}
          </div>

          {/* Range selector */}
          <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {RANGE_OPTIONS.map(o => (
              <button
                key={o.label}
                onClick={() => setRangeMonths(o.months)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  rangeMonths === o.months ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
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
              {dayTypes.map(d => <option key={d} value={d}>{displayDayType(d)}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Insight cards — what only a calendar reveals. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <InsightCard
          label="Strongest weekday"
          value={insights.strongestWeekday ? `${insights.strongestWeekday.weekday} · ${insights.strongestWeekday.avg}` : '—'}
          tone="good"
          note={insights.strongestWeekday ? 'Highest average TapeScore.' : 'Grade a few sessions to unlock.'}
        />
        <InsightCard
          label="Weakest weekday"
          value={insights.weakestWeekday ? `${insights.weakestWeekday.weekday} · ${insights.weakestWeekday.avg}` : '—'}
          tone="bad"
          note={insights.weakestWeekday ? 'Lowest average TapeScore — watch it.' : 'Needs more graded days.'}
        />
        <InsightCard
          label="Clean streak"
          value={insights.scoredDays ? `${insights.cleanStreak.current} day${insights.cleanStreak.current === 1 ? '' : 's'}` : '—'}
          tone="amber"
          note={insights.scoredDays ? `Risk rails intact now. Best: ${insights.cleanStreak.best}.` : 'No graded sessions yet.'}
        />
        <InsightCard
          label="Green but sloppy"
          value={insights.greenButSloppy.count > 0
            ? (insights.greenButSloppy.lastDate ? format(new Date(`${insights.greenButSloppy.lastDate}T12:00:00`), 'MMM d') : String(insights.greenButSloppy.count))
            : '0'}
          tone="amber"
          flag={insights.greenButSloppy.count > 0}
          note={insights.greenButSloppy.count > 0
            ? `${insights.greenButSloppy.count} profitable day${insights.greenButSloppy.count === 1 ? '' : 's'} graded under 50 — lucky, not good.`
            : 'No lucky-but-sloppy green days. Nice.'}
        />
      </div>

      {/* Compact reference strip — the P&L numbers, without the old 5-card wall. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
        <Stat label="Total P&L" value={money(insights.totalPnl)} tone={insights.totalPnl >= 0 ? 'good' : 'bad'} />
        <Stat label="Trading days" value={String(insights.tradedDays)} />
        <Stat label="Day win rate" value={insights.dayWinRate == null ? '—' : `${insights.dayWinRate.toFixed(0)}%`} />
        <Stat label="Avg TapeScore" value={insights.avgTapeScore == null ? '—' : String(insights.avgTapeScore)} tone="amber" />
      </div>

      {/* Heatmap */}
      <CalendarHeatmap days={filtered} startDate={startDate} endDate={endDate} colorMode={colorMode} />

      {filtered.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
          No trading days in this range. Adjust the filters or start logging trades.
        </div>
      )}
    </div>
  )
}

const TONE_TEXT: Record<'good' | 'bad' | 'amber' | 'neutral', string> = {
  good: 'text-green-400', bad: 'text-red-400', amber: 'text-amber-400', neutral: 'text-white',
}

function InsightCard({ label, value, note, tone = 'neutral', flag }: {
  label: string
  value: string
  note: string
  tone?: 'good' | 'bad' | 'amber' | 'neutral'
  flag?: boolean
}) {
  return (
    <div
      className="rounded-xl border p-3"
      style={flag
        ? { background: 'linear-gradient(180deg, rgba(224,163,60,0.10), rgba(25,28,33,1))', borderColor: 'rgba(224,163,60,0.35)' }
        : undefined}
    >
      <div className={`text-[10px] uppercase tracking-wider mb-1 ${flag ? 'text-amber-400' : 'text-gray-500'} ${!flag ? '' : 'flex items-center gap-1'}`}>
        {flag && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}{label}
      </div>
      <div className={`text-lg font-bold ${TONE_TEXT[tone]}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div className="text-[11px] text-gray-500 mt-0.5 leading-snug">{note}</div>
    </div>
  )
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'amber' | 'neutral' }) {
  return (
    <div>
      <span className="text-xs text-gray-500 mr-2">{label}</span>
      <span className={`font-semibold ${TONE_TEXT[tone]}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
