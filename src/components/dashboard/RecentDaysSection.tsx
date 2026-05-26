'use client'

import { useMemo, useState } from 'react'
import { LayoutGrid, List as ListIcon, X } from 'lucide-react'
import RecentDaysList, { type DayRowData } from './RecentDaysList'
import CalendarHeatmap from '@/components/calendar/CalendarHeatmap'

interface Props {
  initialDays: DayRowData[]
  allSetups: string[]
  allDayTypes: string[]
  windowStart: string // YYYY-MM-DD — earliest fetched day
  windowEnd: string   // YYYY-MM-DD — today
}

type ViewMode = 'list' | 'calendar'

/**
 * Recent Days section wrapper.
 *
 * Holds view-mode (list vs calendar) and filter state (date range, setup,
 * day type). Filters cascade to BOTH views so the list and calendar always
 * agree on what's being shown. Filter state is local — not persisted across
 * page reloads. The 30-day server-fetched window is the outer bound; the
 * date range filter narrows within it.
 *
 * For wider history views, the Calendar tab in the sidebar is the home (it
 * has 1M / 3M / 6M / 1Y / All range options).
 */
export default function RecentDaysSection({
  initialDays,
  allSetups,
  allDayTypes,
  windowStart,
  windowEnd,
}: Props) {
  const [view, setView] = useState<ViewMode>('list')
  const [startDate, setStartDate] = useState(windowStart)
  const [endDate, setEndDate] = useState(windowEnd)
  const [setupFilter, setSetupFilter] = useState<string>('')
  const [dayTypeFilter, setDayTypeFilter] = useState<string>('')

  const filteredDays = useMemo(() => {
    return initialDays.filter(d => {
      if (d.date < startDate || d.date > endDate) return false
      if (dayTypeFilter && (d.day_type ?? '').trim() !== dayTypeFilter) return false
      if (setupFilter && !d.setups.includes(setupFilter)) return false
      return true
    })
  }, [initialDays, startDate, endDate, setupFilter, dayTypeFilter])

  const filtersActive =
    startDate !== windowStart ||
    endDate !== windowEnd ||
    setupFilter !== '' ||
    dayTypeFilter !== ''

  const clearFilters = () => {
    setStartDate(windowStart)
    setEndDate(windowEnd)
    setSetupFilter('')
    setDayTypeFilter('')
  }

  // Map filtered DayRowData -> DaySummary shape the heatmap expects. Wins /
  // losses are derived from win_rate * trade_count; the heatmap only renders
  // pnl + trade_count, so the approximation is harmless.
  const summaries = useMemo(() => filteredDays.map(d => {
    const wins = d.win_rate != null ? Math.round((d.win_rate / 100) * d.trade_count) : 0
    return {
      date: d.date,
      pnl: d.eod_pnl ?? 0,
      trade_count: d.trade_count,
      wins,
      losses: d.trade_count - wins,
      day_type: d.day_type,
    }
  }), [filteredDays])

  return (
    <div className="space-y-3">
      {/* Header row: title + view toggle */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Recent Days</h2>
        <div className="inline-flex bg-gray-800 border border-gray-700 rounded-lg overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setView('list')}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              view === 'list' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <ListIcon className="w-3.5 h-3.5" /> List
          </button>
          <button
            type="button"
            onClick={() => setView('calendar')}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              view === 'calendar' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Calendar
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input
          type="date"
          value={startDate}
          min={windowStart}
          max={endDate}
          onChange={e => setStartDate(e.target.value || windowStart)}
          className="bg-gray-800 border border-gray-700 text-gray-200 font-mono rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
          title="Filter start date"
        />
        <span className="text-gray-600">to</span>
        <input
          type="date"
          value={endDate}
          min={startDate}
          max={windowEnd}
          onChange={e => setEndDate(e.target.value || windowEnd)}
          className="bg-gray-800 border border-gray-700 text-gray-200 font-mono rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
          title="Filter end date"
        />

        <select
          value={setupFilter}
          onChange={e => setSetupFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
          title="Filter by setup tag"
        >
          <option value="">All setups</option>
          {allSetups.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={dayTypeFilter}
          onChange={e => setDayTypeFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-200 rounded-md px-2 py-1 focus:outline-none focus:border-blue-500"
          title="Filter by day type"
        >
          <option value="">All day types</option>
          {allDayTypes.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        {filtersActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 text-gray-400 hover:text-white px-2 py-1"
          >
            <X className="w-3 h-3" /> Clear filters
          </button>
        )}

        <span className="ml-auto text-gray-500">
          {filteredDays.length} day{filteredDays.length === 1 ? '' : 's'}
          {filtersActive && initialDays.length !== filteredDays.length && (
            <span className="text-gray-700"> / {initialDays.length}</span>
          )}
        </span>
      </div>

      {/* View */}
      {view === 'list' ? (
        filteredDays.length === 0 ? (
          <p className="text-gray-500 text-sm py-6 text-center">No days match the current filters.</p>
        ) : (
          <RecentDaysList initialDays={filteredDays} />
        )
      ) : (
        filteredDays.length === 0 ? (
          <p className="text-gray-500 text-sm py-6 text-center">No days match the current filters.</p>
        ) : (
          <CalendarHeatmap
            summaries={summaries}
            startDate={startDate}
            endDate={endDate}
          />
        )
      )}
    </div>
  )
}
