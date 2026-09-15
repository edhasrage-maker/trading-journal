'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { format, parseISO, subMonths } from 'date-fns'
import { SlidersHorizontal, X, Loader2, Check } from 'lucide-react'
import DashboardStats, { type DayStat } from './DashboardStats'
import DashboardCharts from './DashboardCharts'
import RecentDaysSection from './RecentDaysSection'
import type { DayRowData } from './RecentDaysList'
import type { DayStatsRollup } from '@/lib/day-stats'

type RangeKey = '1m' | '3m' | '6m' | 'ytd' | '1y' | 'all'

const RANGES: { key: RangeKey; label: string; short: string }[] = [
  { key: '1m', label: 'Last month', short: '1M' },
  { key: '3m', label: 'Last 3 months', short: '3M' },
  { key: '6m', label: 'Last 6 months', short: '6M' },
  { key: 'ytd', label: 'Year to date', short: 'YTD' },
  { key: '1y', label: 'Last 12 months', short: '1Y' },
  { key: 'all', label: 'All time', short: 'All' },
]
const rangeLabel = (k: RangeKey) => RANGES.find(r => r.key === k)!.label

function rangeStart(k: RangeKey, today: string): string {
  const t = parseISO(today)
  switch (k) {
    case '1m': return format(subMonths(t, 1), 'yyyy-MM-dd')
    case '3m': return format(subMonths(t, 3), 'yyyy-MM-dd')
    case '6m': return format(subMonths(t, 6), 'yyyy-MM-dd')
    case 'ytd': return `${today.slice(0, 4)}-01-01`
    case '1y': return format(subMonths(t, 12), 'yyyy-MM-dd')
    case 'all': return '2000-01-01'
  }
}

interface Applied { setups: string[]; range: RangeKey }

interface Props {
  statsDays: DayStat[]
  tableDays: DayRowData[]
  /** Distinct setups actually traded, so the panel never offers a setup that
   *  would come back empty. */
  allSetups: string[]
  today: string
  windowStart: string
  windowEnd: string
  defaultFilterStart: string
  /** Rendered between the charts and the session list, unfiltered (it's a
   *  lifetime collection). A slot so the page keeps its section order. */
  achievements: ReactNode
}

/**
 * The dashboard Filter: scope the stat cards, charts and session list to a set
 * of setups over a time range — "every Supply & Demand trade in the last 3
 * months".
 *
 * Everything below the filter bar answers from the SAME data, so the cards, the
 * equity curve and the list can't disagree about what's being shown. The
 * TapeScore hero sits above the bar on purpose: it grades whole sessions, and a
 * session can't be split by setup.
 *
 * Two modes, because they need different data:
 *   - Range only: whole sessions are the right answer, so the page's own cached
 *     rollups are narrowed by date. No request.
 *   - With setups: each session's numbers must be rebuilt from the matching
 *     trades alone, which only the server can do (the page never loads trades
 *     in steady state) — see /api/dashboard/filter.
 *
 * Not persisted. A dashboard that silently reopened filtered would show numbers
 * the trader didn't ask for, under a banner they'd have to notice to trust.
 */
export default function DashboardFilterScope({
  statsDays, tableDays, allSetups, today, windowStart, windowEnd, defaultFilterStart, achievements,
}: Props) {
  const [open, setOpen] = useState(false)
  const [draftSetups, setDraftSetups] = useState<string[]>([])
  const [draftRange, setDraftRange] = useState<RangeKey>('3m')
  const [applied, setApplied] = useState<Applied | null>(null)
  const [fetched, setFetched] = useState<{ key: string; days: DayStatsRollup[]; tradeCount: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const keyOf = (a: Applied) => `${a.range}|${[...a.setups].sort().join('|')}`
  const appliedKey = applied ? keyOf(applied) : ''
  const start = applied ? rangeStart(applied.range, today) : null

  // Close the panel on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openPanel = () => {
    setDraftSetups(applied?.setups ?? [])
    setDraftRange(applied?.range ?? '3m')
    setOpen(true)
  }

  const apply = async () => {
    const next: Applied = { setups: draftSetups, range: draftRange }
    setOpen(false)
    setError(null)
    setApplied(next)
    if (next.setups.length === 0) { setFetched(null); return }
    const qs = new URLSearchParams({ from: rangeStart(next.range, today), to: today })
    for (const s of next.setups) qs.append('setup', s)
    setLoading(true)
    try {
      const res = await fetch(`/api/dashboard/filter?${qs.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not apply the filter.')
      setFetched({ key: keyOf(next), days: data.days as DayStatsRollup[], tradeCount: data.tradeCount as number })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply the filter.')
      setApplied(null)
      setFetched(null)
    } finally {
      setLoading(false)
    }
  }

  const clear = () => { setApplied(null); setFetched(null); setError(null) }

  // What every section below renders from. Null = unfiltered, or still loading.
  const scoped = useMemo(() => {
    if (!applied || !start) return null
    if (applied.setups.length === 0) {
      const table = tableDays.filter(d => d.date >= start && d.date <= today)
      return {
        stats: statsDays.filter(d => d.date >= start && d.date <= today),
        table,
        tradeCount: table.reduce((a, d) => a + d.trade_count, 0),
      }
    }
    if (!fetched || fetched.key !== appliedKey) return null
    // A rollup is a superset of both shapes; the page's own projection only
    // exists to trim the server payload.
    return {
      stats: fetched.days as unknown as DayStat[],
      table: fetched.days as unknown as DayRowData[],
      tradeCount: fetched.tradeCount,
    }
  }, [applied, start, statsDays, tableDays, today, fetched, appliedKey])

  const active = applied != null && scoped != null
  const empty = active && scoped.table.length === 0
  const label = applied ? rangeLabel(applied.range) : undefined
  const setupsText = applied && applied.setups.length > 0 ? applied.setups.join(', ') : 'All setups'
  const noOp = draftSetups.length === 0 && draftRange === 'all'

  return (
    <>
      <div className="mt-8 pt-5 border-t border-gray-700">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative" ref={panelRef}>
            <button
              type="button"
              onClick={() => (open ? setOpen(false) : openPanel())}
              aria-expanded={open}
              className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-md px-2.5 py-1.5 border transition-colors ${
                active
                  ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-500'
                  : 'bg-gray-800 border-gray-700 text-gray-200 hover:border-gray-500'
              }`}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SlidersHorizontal className="w-3.5 h-3.5" />}
              Filter
              {active && applied.setups.length > 0 && (
                <span className="ml-0.5 rounded bg-white/20 px-1 text-[10px] leading-4">{applied.setups.length}</span>
              )}
            </button>

            {open && (
              <div className="absolute left-0 top-full mt-2 z-40 w-[min(22rem,calc(100vw-2rem))] bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-4 space-y-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">Setups</div>
                  {allSetups.length === 0 ? (
                    <p className="text-xs text-gray-500">No setups tagged on any trade yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto">
                      {allSetups.map(s => {
                        const on = draftSetups.includes(s)
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setDraftSetups(prev => (on ? prev.filter(x => x !== s) : [...prev, s]))}
                            aria-pressed={on}
                            className={`inline-flex items-center gap-1 text-xs rounded-md px-2 py-1 border transition-colors ${
                              on
                                ? 'bg-blue-950 border-blue-600 text-blue-300'
                                : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                            }`}
                          >
                            {on && <Check className="w-3 h-3" />}
                            {s}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <p className="text-[11px] text-gray-500 mt-2">
                    {draftSetups.length === 0 ? 'None picked — every trade counts.' : 'Trades tagged with any of these.'}
                  </p>
                </div>

                <div>
                  <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">Time</div>
                  <div className="grid grid-cols-6 gap-1">
                    {RANGES.map(r => (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => setDraftRange(r.key)}
                        aria-pressed={draftRange === r.key}
                        title={r.label}
                        className={`text-xs rounded-md py-1 border transition-colors ${
                          draftRange === r.key
                            ? 'bg-blue-950 border-blue-600 text-blue-300'
                            : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                        }`}
                      >
                        {r.short}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={apply}
                    disabled={noOp}
                    title={noOp ? 'All setups over all time is the unfiltered dashboard.' : undefined}
                    className="text-xs font-medium rounded-md px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600"
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>

          {applied && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="text-gray-200">{setupsText}</span>
              <span className="text-gray-600">·</span>
              <span className="text-gray-400">{label}</span>
              {scoped && (
                <>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-400">
                    {scoped.tradeCount} trade{scoped.tradeCount === 1 ? '' : 's'} across{' '}
                    {scoped.table.length} session{scoped.table.length === 1 ? '' : 's'}
                  </span>
                </>
              )}
              {loading && <span className="text-gray-500">Filtering…</span>}
              <button
                type="button"
                onClick={clear}
                className="inline-flex items-center gap-1 text-gray-400 hover:text-white px-1.5 py-0.5"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            </div>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>

        {active && applied.setups.length > 0 && !empty && (
          <p className="text-[11px] text-gray-500 -mt-2 mb-4 max-w-[70ch]">
            P&amp;L, win rate and excursions below count only these trades. A session&apos;s TapeScore still
            grades the whole session — it can&apos;t be split by setup.
          </p>
        )}

        {empty ? (
          <p className="text-sm text-gray-400 py-8">
            No {applied.setups.length > 0 ? `${setupsText} ` : ''}trades in {label!.toLowerCase()}.
          </p>
        ) : (
          <DashboardStats
            days={active ? scoped.stats : statsDays}
            hideScoreHero
            rangeLabel={active ? label : undefined}
          />
        )}
      </div>

      {!empty && <DashboardCharts days={active ? scoped.stats : statsDays} rangeLabel={active ? label : undefined} />}

      <div className="mt-8 pt-5 border-t border-gray-700">{achievements}</div>

      <div className="mt-8 pt-5 border-t border-gray-700">
        <RecentDaysSection
          // Remount on a new filter so the list's own date range resets to the
          // filter's span instead of clipping it to the default 30 days.
          key={active ? `f:${appliedKey}` : 'unfiltered'}
          initialDays={active ? scoped.table : tableDays}
          windowStart={windowStart}
          windowEnd={windowEnd}
          defaultFilterStart={active && start ? (start < windowStart ? windowStart : start) : defaultFilterStart}
        />
      </div>
    </>
  )
}
