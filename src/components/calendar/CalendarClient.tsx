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
      {/* Header. The locked language: the sentence carries the meaning, not a
          screen-name h1 over a row of filled controls. Active states are inset
          underlines rather than solid accent fills. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1
            className="text-[clamp(22px,2.6vw,28px)] font-bold tracking-[-0.025em] text-gray-100 leading-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Your decisions over time.
          </h1>
          <p className="text-sm text-gray-400 mt-1.5">Coloured by TapeScore, not P&amp;L.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Color mode */}
          <div className="inline-flex border border-gray-700 rounded overflow-hidden text-xs">
            {(['tapescore', 'pnl'] as ColorMode[]).map(m => (
              <button
                key={m}
                onClick={() => setColorMode(m)}
                aria-pressed={colorMode === m}
                className={`px-3 py-1.5 border-r border-gray-700 last:border-r-0 transition-colors ${
                  colorMode === m
                    ? 'bg-gray-800 text-gray-100 shadow-[inset_0_-2px_0_var(--color-accent-deep)]'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
                title={m === 'tapescore' ? 'Color days by decision grade' : 'Color days by P&L'}
              >
                {m === 'tapescore' ? 'TapeScore' : 'P&L'}
              </button>
            ))}
          </div>

          {/* Range selector */}
          <div className="inline-flex border border-gray-700 rounded overflow-hidden text-xs">
            {RANGE_OPTIONS.map(o => (
              <button
                key={o.label}
                onClick={() => setRangeMonths(o.months)}
                aria-pressed={rangeMonths === o.months}
                className={`px-3 py-1.5 border-r border-gray-700 last:border-r-0 transition-colors ${
                  rangeMonths === o.months
                    ? 'bg-gray-800 text-gray-100 shadow-[inset_0_-2px_0_var(--color-accent-deep)]'
                    : 'text-gray-400 hover:text-gray-200'
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
              className="bg-gray-950 border border-gray-700 text-gray-300 text-xs rounded px-3 py-1.5 focus:outline-none focus:border-blue-600"
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

      {/* Compact reference strip — numerals on a rule, not a boxed row. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm border-t border-gray-800 pt-3">
        <Stat label="Total P&L" value={money(insights.totalPnl)} tone={insights.totalPnl >= 0 ? 'good' : 'bad'} />
        <Stat label="Trading days" value={String(insights.tradedDays)} />
        <Stat label="Day win rate" value={insights.dayWinRate == null ? '—' : `${insights.dayWinRate.toFixed(0)}%`} />
        <Stat label="Avg TapeScore" value={insights.avgTapeScore == null ? '—' : String(insights.avgTapeScore)} />
      </div>

      {/* Heatmap */}
      <CalendarHeatmap days={filtered} startDate={startDate} endDate={endDate} colorMode={colorMode} />

      {filtered.length === 0 && (
        <p className="text-sm text-gray-500 max-w-[62ch] leading-normal">
          No trading days in this range. Widen the range, clear the day-type filter, or log a
          session — the grid fills in from your own days.
        </p>
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
  // A flagged insight earns a coloured left rule, not a gradient-washed box —
  // gradients are one of the AI-default tells the locked identity rules out, and
  // colour here has to mean "this one needs your attention", nothing decorative.
  return (
    <div className={`border-l-2 pl-3.5 py-1 ${flag ? 'border-yellow-600' : 'border-gray-700'}`}>
      <div className={`text-[11px] mb-1 flex items-center gap-1.5 ${flag ? 'text-yellow-400' : 'text-gray-500'}`}>
        {flag && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-yellow-400" />}{label}
      </div>
      <div
        className={`text-[19px] font-bold tabular-nums ${TONE_TEXT[tone]}`}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5 leading-snug">{note}</div>
    </div>
  )
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'amber' | 'neutral' }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-gray-500">{label}</span>
      <span
        className={`font-bold tabular-nums ${TONE_TEXT[tone]}`}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </span>
    </div>
  )
}
