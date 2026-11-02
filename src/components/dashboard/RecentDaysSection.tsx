'use client'

import { useEffect, useMemo, useState } from 'react'
import { LayoutGrid, List as ListIcon, X } from 'lucide-react'
import RecentDaysList, { type DayRowData } from './RecentDaysList'
import MonthlyCalendarView from './MonthlyCalendarView'

interface Props {
  initialDays: DayRowData[]
  windowStart: string // YYYY-MM-DD — earliest fetched day (outer bound)
  windowEnd: string   // YYYY-MM-DD — today
  defaultFilterStart: string // YYYY-MM-DD — list-view date filter default start
  /** List-view default end, and the month the calendar opens on. The
   *  dashboard passes its period's end; defaults to windowEnd. */
  defaultFilterEnd?: string
}

type ViewMode = 'list' | 'calendar'
// The trader's List / Calendar pick sticks across visits.
const VIEW_KEY = 'dashboard-days-view-v1'

/**
 * The dashboard's days, as a calendar (default) or a list, in one card.
 *
 * Setup filtering lives in the dashboard Filter (DashboardFilterScope), which
 * recomputes every figure from the matching trades and hands this section
 * already-filtered days. The list narrows to a date range that starts on the
 * page's period; the calendar opens on the month that period ends in and
 * navigates month by month from there.
 */
export default function RecentDaysSection({
  initialDays,
  windowStart,
  windowEnd,
  defaultFilterStart,
  defaultFilterEnd,
}: Props) {
  const rangeEnd = defaultFilterEnd ?? windowEnd
  const [view, setView] = useState<ViewMode>('calendar')
  const [startDate, setStartDate] = useState(defaultFilterStart)
  const [endDate, setEndDate] = useState(rangeEnd)
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (v === 'list' || v === 'calendar') setView(v)
    } catch { /* ignore */ }
  }, [])
  const pick = (v: ViewMode) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ }
  }

  const filteredDays = useMemo(
    () => initialDays.filter(d => d.date >= startDate && d.date <= endDate),
    [initialDays, startDate, endDate],
  )

  const filtersActive = startDate !== defaultFilterStart || endDate !== rangeEnd

  // The calendar opens on the period's last traded month, so "Last 30 days"
  // on the 1st shows last month's days instead of an empty new month.
  const openMonth = useMemo(() => {
    let last: string | null = null
    for (const d of initialDays) {
      if (d.trade_count > 0 && d.date >= defaultFilterStart && d.date <= rangeEnd && (!last || d.date > last)) last = d.date
    }
    return (last ?? rangeEnd).slice(0, 7)
  }, [initialDays, defaultFilterStart, rangeEnd])
  const clearFilters = () => {
    setStartDate(defaultFilterStart)
    setEndDate(rangeEnd)
  }

  const toggle = (
    <div className="inline-flex border border-gray-700 rounded-lg overflow-hidden text-xs" role="group" aria-label="View">
      {([['list', ListIcon, 'List'], ['calendar', LayoutGrid, 'Calendar']] as const).map(([v, Icon, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => pick(v)}
          aria-pressed={view === v}
          className={`flex items-center gap-1.5 px-2.5 py-1 transition-colors ${
            view === v ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
          }`}
        >
          <Icon className="w-3.5 h-3.5" /> {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="ts-card p-4 sm:p-5">
      {view === 'calendar' ? (
        <MonthlyCalendarView
          days={initialDays}
          windowStart={windowStart}
          windowEnd={windowEnd}
          initialMonth={openMonth}
          toggle={toggle}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <h2 className="mr-2 text-[20px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Your days</h2>
            <input
              type="date"
              value={startDate}
              min={windowStart}
              max={endDate}
              onChange={e => setStartDate(e.target.value || defaultFilterStart)}
              className="bg-gray-800 border border-gray-700 text-gray-200 font-mono rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
              title="Filter start date"
            />
            <span className="text-gray-600">to</span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              max={windowEnd}
              onChange={e => setEndDate(e.target.value || rangeEnd)}
              className="bg-gray-800 border border-gray-700 text-gray-200 font-mono rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
              title="Filter end date"
            />
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 text-gray-400 hover:text-gray-100 px-2 py-1"
              >
                <X className="w-3 h-3" /> Reset dates
              </button>
            )}
            <span className="ml-auto text-gray-500">
              {filteredDays.length} day{filteredDays.length === 1 ? '' : 's'}
            </span>
            {toggle}
          </div>
          {filteredDays.length === 0 ? (
            <p className="text-gray-500 text-sm py-6 text-center">No days in these dates.</p>
          ) : (
            <RecentDaysList initialDays={filteredDays} />
          )}
        </div>
      )}
    </div>
  )
}
