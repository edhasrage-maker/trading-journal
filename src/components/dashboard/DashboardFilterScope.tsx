'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { format, parseISO, subMonths } from 'date-fns'
import { SlidersHorizontal, X, Loader2, Check } from 'lucide-react'
import { PERIOD_KEY, monthName, periodBounds, periodLabel, computePeriodStats, profitFactorFor, dateSpan, type DayStat, type Period } from './DashboardStats'
import DashboardScoreboard from './DashboardScoreboard'
import ScoutingReport from './ScoutingReport'
import TradeManagementCard, { ProfitFactorCard } from '@/components/TradeManagementCard'
import { useMfeUnit } from '@/lib/mfe-unit'
import { mgmtView } from '@/lib/trade-management'
import { periodFinding, tradeCountSplit, bigDaysWhy, scoutingActions, type ReadDay } from '@/lib/dashboard-read'
import DashboardCharts from './DashboardCharts'
import RecentDaysSection from './RecentDaysSection'
import type { DayRowData } from './RecentDaysList'
import type { ScoredDayRollup } from '@/lib/day-stats'
import type { LiftDragView } from '@/lib/lift-drag'

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
  /** Rendered last, unfiltered (it's a lifetime collection). A slot so the
   *  page keeps its section order. */
  achievements: ReactNode
  /** Profit factor lifter / drag per scope — see DashboardStats. */
  liftDrag?: Record<string, LiftDragView | null>
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
/** The months before this one, newest first: "2026-09", "2026-08", … */
function monthsBefore(today: string, n: number): string[] {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  return Array.from({ length: n }, (_, k) => new Date(Date.UTC(y, m - 2 - k, 1)).toISOString().slice(0, 7))
}

export default function DashboardFilterScope({
  statsDays, tableDays, allSetups, today, windowStart, windowEnd, achievements,
  liftDrag,
}: Props) {
  // ── The one Period (founder, 2026-10-31): a row of chips that every section
  // follows — the cards, both charts, the calendar and the list. Built from
  // the server's day so the month names can't disagree with the server render.
  const [prev1, prev2] = monthsBefore(today, 2)
  const chips: { p: Period; label: string }[] = [
    { p: '30d', label: 'Last 30 days' },
    { p: 'week', label: 'This week' },
    { p: 'month', label: monthName(today.slice(0, 7)) },
    { p: `m:${prev1}`, label: monthName(prev1) },
    { p: `m:${prev2}`, label: monthName(prev2) },
    { p: 'all', label: 'All time' },
  ]
  const [period, setPeriod] = useState<Period>('30d')
  const [periodLoaded, setPeriodLoaded] = useState(false)
  useEffect(() => {
    // The saved choice, when it is still one of the chips (a month drops off
    // once it is three months back; the longer ranges live in the Filter).
    try {
      const raw = localStorage.getItem(PERIOD_KEY)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (raw && chips.some(c => c.p === raw)) setPeriod(raw as Period)
    } catch { /* ignore */ }
    setPeriodLoaded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only hydration
  }, [])
  useEffect(() => {
    if (!periodLoaded) return
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* ignore */ }
  }, [period, periodLoaded])

  const [open, setOpen] = useState(false)
  const [draftSetups, setDraftSetups] = useState<string[]>([])
  const [draftRange, setDraftRange] = useState<RangeKey>('3m')
  const [applied, setApplied] = useState<Applied | null>(null)
  const [fetched, setFetched] = useState<{ key: string; days: ScoredDayRollup[]; tradeCount: number } | null>(null)
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
      setFetched({ key: keyOf(next), days: data.days as ScoredDayRollup[], tradeCount: data.tradeCount as number })
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

  // Unfiltered, everything reads the Period's days.
  const bounds = periodBounds(period)
  const periodStats = statsDays.filter(d => d.date >= bounds.start && d.date <= bounds.end)
  const pickPeriod = (p: Period) => {
    // A chip replaces an applied filter's time range, so the filter goes.
    if (applied) clear()
    setPeriod(p)
  }

  // The list's dates and the calendar's month: the filter's range when one is
  // on, otherwise the Period's.
  const daysFrom = active && start ? start : bounds.start
  const daysTo = active ? today : bounds.end

  const filterPanel = (
        <div className="absolute right-0 top-full mt-2 z-40 w-[min(22rem,calc(100vw-2rem))] bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-4 space-y-4">
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
  )

  // ── The scoreboard reads (founder, 2026-11-01): the band, the Scouting
  // report and the score-vs-money dots all read the same days as the cards.
  const [mfeUnit] = useMfeUnit()
  const bandDays = active ? scoped.stats : statsDays
  const bandPeriod: Period = active ? 'all' : period
  const bandStats = useMemo(() => computePeriodStats(bandDays, bandPeriod), [bandDays, bandPeriod])
  const readDays = useMemo(
    () => (active ? scoped.table : tableDays.filter(d => d.date >= bounds.start && d.date <= bounds.end)) as ReadDay[],
    [active, scoped, tableDays, bounds.start, bounds.end],
  )
  const finding = useMemo(() => periodFinding(readDays), [readDays])
  const split = useMemo(() => tradeCountSplit(readDays), [readDays])
  const why = useMemo(() => bigDaysWhy(readDays), [readDays])
  const liftDragScope = active ? (applied.setups.length > 0 ? null : `r:${applied.range}`) : undefined
  const profitFactor = profitFactorFor(liftDrag, liftDragScope, period, active ? label : undefined)
  const actions = useMemo(() => {
    const v = mgmtView(bandStats.mgmt, mfeUnit)
    return scoutingActions({
      split,
      liftDrag: profitFactor?.view ?? null,
      mgmt: { unit: mfeUnit, wentCount: v.went.count, neverCount: v.never.count, wentMae: v.went.mae, neverMae: v.never.mae },
    })
  }, [bandStats.mgmt, mfeUnit, split, profitFactor?.view])

  const spanText = bandStats.tradedDaysCount > 0
    ? `${dateSpan(active && start ? start : bounds.start, active ? today : bounds.end)} · ${bandStats.totalTradesWithPnl} trade${bandStats.totalTradesWithPnl === 1 ? '' : 's'}`
    : null

  return (
    <div>
      {/* The scoreboard band: full width, flush under the masthead (it undoes
          AppMain's p-6). Navy in both themes — .ts-band in globals.css. */}
      <section aria-label="Scoreboard" className="ts-band -mx-6 -mt-6 px-6 pt-3 pb-24">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px]">
          <div className="flex flex-wrap gap-x-5 gap-y-1" role="group" aria-label="Period">
            {chips.map(c => {
              const on = !applied && period === c.p
              return (
                <button
                  key={c.p}
                  type="button"
                  onClick={() => pickPeriod(c.p)}
                  aria-pressed={on}
                  className={`py-1.5 transition-colors ${
                    on
                      ? 'text-[var(--b-ink)] font-semibold shadow-[inset_0_-2px_0_var(--b-ink)]'
                      : 'text-[var(--b-mut)] hover:text-[var(--b-ink)]'
                  }`}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
          <span className="flex-1" />
          {spanText && <span className="text-[var(--b-mut)]">{spanText}</span>}
          <div className="relative" ref={panelRef}>
            <button
              type="button"
              onClick={() => (open ? setOpen(false) : openPanel())}
              aria-expanded={open}
              className={`inline-flex items-center gap-1.5 text-[13px] font-medium rounded-md px-3 py-1.5 border transition-colors ${
                active
                  ? 'bg-[var(--b-ink)] border-[var(--b-ink)] text-[#171C2C]'
                  : 'border-[#46506A] text-[var(--b-ink)] hover:border-[var(--b-mut)]'
              }`}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SlidersHorizontal className="w-3.5 h-3.5" />}
              Filter
              {active && applied.setups.length > 0 && (
                <span className="ml-0.5 rounded bg-[#171C2C]/15 px-1 text-[10px] leading-4">{applied.setups.length}</span>
              )}
            </button>
            {open && filterPanel}
          </div>
        </div>

        {(applied || error) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--b-mut)]">
            {applied && (
              <>
                <span>Filter:</span>
                <span className="text-[var(--b-ink)]">{setupsText}</span>
                <span>·</span>
                <span>{label}</span>
                {scoped && (
                  <>
                    <span>·</span>
                    <span>
                      {scoped.tradeCount} trade{scoped.tradeCount === 1 ? '' : 's'} across{' '}
                      {scoped.table.length} session{scoped.table.length === 1 ? '' : 's'}
                    </span>
                  </>
                )}
                {loading && <span>Filtering…</span>}
                <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-[var(--b-ink)] hover:underline px-1.5 py-0.5">
                  <X className="w-3 h-3" /> Clear
                </button>
                <span className="hidden lg:inline">· Pick a period to clear it.</span>
              </>
            )}
            {error && <span className="text-[var(--b-neg)]">{error}</span>}
          </div>
        )}
        {active && applied.setups.length > 0 && !empty && (
          <p className="mt-1 text-[12px] text-[var(--b-mut)] max-w-[70ch]">
            P&amp;L, win rate and excursions count only these trades. A session&apos;s TapeScore still
            grades the whole session — it can&apos;t be split by setup.
          </p>
        )}

        {empty ? (
          <p className="mt-8 text-[15px] text-[var(--b-mut)]">
            No {applied.setups.length > 0 ? `${setupsText} ` : ''}trades in {label!.toLowerCase()}.
          </p>
        ) : (
          <DashboardScoreboard stats={bandStats} finding={finding} />
        )}
      </section>

      {/* Everything below rises out of the band. */}
      <div className="relative -mt-16 space-y-9">
        {!empty && (
          <DashboardCharts
            days={active ? scoped.stats : periodStats}
            rangeLabel={active ? label : periodLabel(period)}
            scoreboard={{ top: <ScoutingReport why={why} actions={actions} />, splitK: split?.k ?? null }}
          />
        )}

        {!empty && (
          <section aria-label="Trade management and profit factor" className="grid grid-cols-1 lg:grid-cols-2 border-t-2 border-gray-100">
            <TradeManagementCard
              totals={bandStats.mgmt}
              heading
              className={`min-w-0 pt-5 pb-2 ${profitFactor ? 'lg:pr-8 lg:border-r border-gray-800' : 'lg:col-span-2'}`}
            />
            {profitFactor && (
              <ProfitFactorCard
                ruled
                view={profitFactor.view}
                windowLabel={profitFactor.window}
                className="min-w-0 pt-5 pb-2 lg:pl-8 border-t lg:border-t-0 border-gray-800 mt-4 lg:mt-0"
              />
            )}
          </section>
        )}

        <RecentDaysSection
          // Remount on a new period or filter so the list's dates and the
          // calendar's month start from it.
          key={active ? `f:${appliedKey}` : `p:${period}`}
          initialDays={active ? scoped.table : tableDays}
          windowStart={windowStart}
          windowEnd={windowEnd}
          defaultFilterStart={daysFrom < windowStart ? windowStart : daysFrom}
          defaultFilterEnd={daysTo}
        />

        <div className="border-t border-gray-800 pt-5">{achievements}</div>
      </div>
    </div>
  )
}
