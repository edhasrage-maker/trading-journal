'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Target, ChevronRight } from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'
import DashboardStats, { periodBounds, PERIOD_LABELS, type DayStat, type Period } from './DashboardStats'
import DashboardCharts from './DashboardCharts'
import HighlightsSessions from './HighlightsSessions'
import type { DayRowData } from './RecentDaysList'
import type { LiftDragView } from '@/lib/lift-drag'

/**
 * Highlights dashboard (r2, founder 2026-10-28 — docs/tapescore-highlights-mockup-r2.html).
 *
 * The KPI cards are the Detailed ones, unchanged. Highlights gets simpler by
 * taking things away around them: ONE time switch drives the cards, the equity
 * curve and the session list, so no two numbers on the page cover different
 * days; one chart (Daily Results stays in Detailed); and Recent sessions say
 * what happened each day. Then the badge collection and the seam into
 * Detailed Tape.
 *
 * The one exception to the switch is the profit-factor lifter / drag inside
 * Trade management, which needs 60 sessions and says so on the card.
 */

const PERIODS: Period[] = ['week', 'month', '30d', 'ytd']
// Highlights' own saved choice — separate from Detailed's Period menu, which
// also offers All time / Last Year.
const PERIOD_KEY = 'highlights-period-v1'

type Props = {
  /** Every day's stat projection (same as Detailed). */
  statsDays: DayStat[]
  /** Every non-blank day, newest first (same as Detailed's Days table). */
  days: DayRowData[]
  /** Recap headline per trading_days id. */
  headlines: Record<string, string>
  /** Profit factor lifter / drag per scope — see DashboardStats. */
  liftDrag?: Record<string, LiftDragView | null>
  /** The lifetime badge collection (rendered by the page). */
  achievements: ReactNode
  /** How many sessions in the whole journal carry a TapeScore. Zero with days
   *  on the books is the freshly-imported case — see "Start here". */
  gradedDaysAllTime: number
}

/** "2026-07-24" → "Fri, Jul 24". Noon so the timezone can't roll it back. */
function dayLabel(date: string): string {
  try { return format(new Date(`${date}T12:00:00`), 'EEE, MMM d') } catch { return date }
}

/** "Sep 28 – Oct 28". */
function spanLabel(from: string, to: string): string {
  const f = (d: string) => { try { return format(new Date(`${d}T12:00:00`), 'MMM d') } catch { return d } }
  return `${f(from)} – ${f(to)}`
}

export default function BeginnerDashboard({ statsDays, days, headlines, liftDrag, achievements, gradedDaysAllTime }: Props) {
  const { setMode } = useUiMode()
  const [period, setPeriod] = useState<Period>('30d')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERIOD_KEY) as Period | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (raw && PERIODS.includes(raw)) setPeriod(raw)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* ignore */ }
  }, [period, hydrated])

  const { start, end } = periodBounds(period)
  const label = PERIOD_LABELS[period]
  const inPeriodStats = useMemo(() => statsDays.filter(d => d.date >= start && d.date <= end), [statsDays, start, end])
  const inPeriodDays = useMemo(() => days.filter(d => d.date >= start && d.date <= end), [days, start, end])
  const sessions = inPeriodDays.length

  // A freshly-imported journal has sessions but no TapeScore anywhere: the
  // score comes from the end-of-day read, run per session. Hand them the one
  // step that produces it. `days` is newest first, so the first is the one.
  const ungraded = gradedDaysAllTime === 0 && days.length > 0
  const gradeDate = days[0]?.date ?? null

  return (
    <div className="space-y-4">
      {ungraded && gradeDate && (
        <div className="rounded-xl border p-4" style={{ background: 'rgba(224,163,60,0.08)', borderColor: 'rgba(224,163,60,0.35)' }}>
          <div className="flex items-center gap-2 mb-1.5">
            <Target className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wide text-amber-400">Start here</span>
          </div>
          <p className="text-sm text-gray-200 leading-relaxed">
            Your trades are in — none of your sessions are graded yet. Grade a session and you get its
            TapeScore, how much of the move you kept, the heat you took, and the one thing to work on. Do
            your most recent one first.
          </p>
          <Link
            href={`/review/today/${gradeDate}`}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-400 px-3.5 py-2 text-sm font-semibold text-gray-950 transition-colors"
          >
            Grade {dayLabel(gradeDate)} <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {/* The one time switch — everything below answers for these days. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-gray-500">Showing</span>
        <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden" role="group" aria-label="Time range">
          {PERIODS.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className={`text-xs px-3 py-1.5 border-r border-gray-700 last:border-r-0 transition-colors ${
                period === p ? 'bg-blue-950 text-blue-300 font-semibold' : 'bg-gray-900 text-gray-400 hover:text-gray-200'
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        {/* Client clock decides "today", so print the span only after mount —
            the server renders in UTC and would disagree in the evening. */}
        {hydrated && (
          <span className="text-xs text-gray-500">
            {spanLabel(start, end)} · {sessions} session{sessions === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* The Detailed KPI cards, as they are, on the switch's period. */}
      <DashboardStats days={statsDays} hideScoreHero scoreInRow period={period} liftDrag={liftDrag} />

      {/* One chart: the equity curve, with its TapeScore band explained. */}
      <DashboardCharts days={inPeriodStats} rangeLabel={label} equityOnly />

      <HighlightsSessions days={inPeriodDays} headlines={headlines} periodLabel={label} />

      <div className="pt-2">{achievements}</div>

      {/* Graduation seam — one tap into the full Detailed Tape view. */}
      <button
        type="button"
        onClick={() => setMode('pro')}
        className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 border border-gray-800 hover:border-gray-600 rounded-xl py-2.5 transition-colors"
      >
        See your full breakdown <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}
