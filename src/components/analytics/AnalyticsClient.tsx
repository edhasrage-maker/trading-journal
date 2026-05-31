'use client'

import { useMemo, useState } from 'react'
import { format, parseISO, subMonths } from 'date-fns'
import TagPerformanceTable from './TagPerformanceTable'
import TagImpactTable from './TagImpactTable'
import ConditionBuckets from './ConditionBuckets'
import RollingPerformance from './RollingPerformance'
import CsvExportButton from './CsvExportButton'
import {
  aggregateByTag,
  aggregateByDayType,
  tagImpact,
  computeStats,
  type TradeWithContext,
} from '@/lib/analytics'

interface Props {
  trades: TradeWithContext[]
  defaultStartDate: string
  defaultEndDate: string
}

/**
 * Reject empty / partial / non-ISO date strings before they reach `new Date`
 * or `parseISO`. Native `<input type="date">` can emit an empty string when
 * the user clears or is mid-edit; we treat those as "no change" so the prior
 * good value stays in state and downstream date math never sees Invalid Date
 * (which throws inside date-fns `format`).
 */
function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(s + 'T12:00:00')
  return !isNaN(d.getTime())
}

/** Defensive header formatter — `format()` throws on Invalid Date, so guard. */
function fmtDate(s: string): string {
  return isValidDateString(s) ? format(new Date(s + 'T12:00:00'), 'MMM d, yyyy') : '—'
}

// months === 0 → "All", months === -1 → "Custom" (date inputs)
const RANGE_OPTIONS: { label: string; months: number }[] = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: 'All', months: 0 },
  { label: 'Custom', months: -1 },
]

type SourceFilter = 'all' | 'native' | 'historical'

export default function AnalyticsClient({ trades, defaultStartDate, defaultEndDate }: Props) {
  const [rangeMonths, setRangeMonths] = useState(3)
  // Custom-mode dates. Seeded from server props so the inputs are usable the
  // moment Custom is selected.
  const [customStart, setCustomStart] = useState(defaultStartDate)
  const [customEnd, setCustomEnd] = useState(defaultEndDate)
  const isCustom = rangeMonths === -1
  // Source filter — lets the user reconcile against Tradezella by viewing the
  // imported historical_trades only, or look at just the Sierra-imported live
  // trades. Default 'all' preserves prior behavior.
  const [source, setSource] = useState<SourceFilter>('all')

  // The last date covered by Tradezella. Used as the cutoff for the All view:
  // Tradezella is authoritative through this date; native only contributes for
  // dates AFTER it. Re-imports of Tradezella shift this cutoff forward, and
  // any future native trades cleanly append on the post-cutoff side.
  const tzLastDate = useMemo(() => {
    let last = ''
    for (const t of trades) {
      if (t.source === 'historical' && t.date && t.date > last) last = t.date
    }
    return last || null
  }, [trades])

  // Counts shown on each Source button:
  //   Native     = every row marked source='native' (raw Sierra count)
  //   Historical = every row marked source='historical' (raw Tradezella count
  //                — matches Tradezella's UI directly; e.g. 915 total)
  //   All        = TZ-AS-BASELINE policy: full Tradezella set + native trades
  //                whose date is strictly AFTER Tradezella's last date. Pre-TZ
  //                native rows (Sierra imports from before Tradezella started)
  //                are intentionally excluded from All; flip to Native if you
  //                want to see them.
  const sourceCounts = useMemo(() => {
    let native = 0, historical = 0, nativeAfterTz = 0
    for (const t of trades) {
      if (t.source === 'historical') historical++
      else {
        native++
        if (!tzLastDate || (t.date && t.date > tzLastDate)) nativeAfterTz++
      }
    }
    return { native, historical, all: historical + nativeAfterTz }
  }, [trades, tzLastDate])

  // IMPORTANT: anchor preset ranges on the server-passed `defaultEndDate`,
  // never `new Date()`. Calling Date during render in a client component causes
  // a hydration mismatch — the server SSR pass and the client hydration pass
  // capture different moments, so when TZ or midnight shifts the date string,
  // downstream filters return different trades and the Recharts/BarChart SVG
  // bucket dimensions diverge between server and client HTML.
  const endDate = isCustom ? customEnd : defaultEndDate
  const startDate = useMemo(() => {
    if (isCustom) return customStart
    if (rangeMonths === 0) return defaultStartDate
    return format(subMonths(parseISO(defaultEndDate), rangeMonths), 'yyyy-MM-dd')
  }, [rangeMonths, isCustom, customStart, defaultStartDate, defaultEndDate])

  const filtered = useMemo(() => {
    // Step 1: apply Source filter.
    let pool: TradeWithContext[]
    if (source === 'native') {
      pool = trades.filter(t => t.source !== 'historical')
    } else if (source === 'historical') {
      pool = trades.filter(t => t.source === 'historical')
    } else {
      // 'all' → TZ-AS-BASELINE: every Tradezella row, plus native rows whose
      // date is strictly AFTER Tradezella's last date. Pre-TZ native data is
      // intentionally excluded — Tradezella is the audited baseline through
      // its last day, and native takes over from the day after.
      pool = trades.filter(t => {
        if (t.source === 'historical') return true
        if (!tzLastDate) return true
        return !!t.date && t.date > tzLastDate
      })
    }
    // Step 2: apply date range.
    return pool.filter(t => t.date >= startDate && t.date <= endDate)
  }, [trades, startDate, endDate, source, tzLastDate])

  const overall = useMemo(() => computeStats(filtered), [filtered])

  // How many trades exist in the current date range under the All view
  // (TZ-as-baseline policy). Drives the "hidden by source filter" banner.
  const totalInRangeAllSources = useMemo(() => {
    let count = 0
    for (const t of trades) {
      if (t.date < startDate || t.date > endDate) continue
      if (t.source === 'historical') count++
      else if (!tzLastDate || (t.date && t.date > tzLastDate)) count++
    }
    return count
  }, [trades, startDate, endDate, tzLastDate])
  const hiddenInRange = source === 'all' ? 0 : Math.max(0, totalInRangeAllSources - filtered.length)

  const setupPerf = useMemo(() => aggregateByTag(filtered, 'setups'), [filtered])
  const confluencePerf = useMemo(() => aggregateByTag(filtered, 'confluences'), [filtered])
  const orderFlowPerf = useMemo(() => aggregateByTag(filtered, 'order_flow'), [filtered])
  const mgmtPerf = useMemo(() => aggregateByTag(filtered, 'trade_management'), [filtered])
  const dayTypePerf = useMemo(() => aggregateByDayType(filtered), [filtered])

  const mistakesImpact = useMemo(() => tagImpact(filtered, 'mistakes'), [filtered])
  const emotionsImpact = useMemo(() => tagImpact(filtered, 'emotions'), [filtered])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Analytics</h1>
          <p className="text-gray-400 text-sm mt-1">
            {fmtDate(startDate)} – {fmtDate(endDate)}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {/* Source filter — switch between everything, just Sierra-imported
              native trades, or just Tradezella history. "Historical" lets the
              user reconcile against Tradezella's UI directly. */}
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-gray-500 uppercase tracking-wide">Source</span>
            <div className="flex bg-gray-900 border border-gray-800 rounded overflow-hidden">
              {([
                { key: 'all', label: 'All', count: sourceCounts.all },
                { key: 'native', label: 'Native', count: sourceCounts.native },
                { key: 'historical', label: 'Historical', count: sourceCounts.historical },
              ] as const).map(o => (
                <button
                  key={o.key}
                  onClick={() => setSource(o.key)}
                  className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    source === o.key
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                  }`}
                  title={
                    o.key === 'native' ? 'Sierra Chart imports + manual entries (per-fill granular)'
                    : o.key === 'historical' ? 'Tradezella re-imports (aggregated per position — matches Tradezella UI)'
                    : 'All sources, deduped by date (native wins on overlap)'
                  }
                >
                  {o.label} <span className="opacity-60">({o.count.toLocaleString()})</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <CsvExportButton from={startDate} to={endDate} />

            {/* Range selector */}
            <div className="flex bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              {RANGE_OPTIONS.map(o => (
                <button
                  key={o.label}
                  onClick={() => setRangeMonths(o.months)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    rangeMonths === o.months
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom-range date inputs — revealed only when "Custom" is selected
              so the header stays compact for the common preset path. Clicking
              anywhere in the label (the "From"/"To" text or the gap around
              the input) opens the date picker via showPicker(). */}
          {isCustom && (
            <div className="flex items-center gap-2 text-xs">
              <label
                className="flex items-center gap-1.5 text-gray-400 cursor-pointer hover:text-gray-200"
                onClick={e => {
                  if ((e.target as HTMLElement).tagName !== 'INPUT') {
                    e.preventDefault()
                    ;(e.currentTarget.querySelector('input[type=date]') as HTMLInputElement | null)?.showPicker?.()
                  }
                }}
              >
                <span>From</span>
                <input
                  type="date"
                  value={customStart}
                  min={defaultStartDate}
                  max={customEnd}
                  onChange={e => { if (isValidDateString(e.target.value)) setCustomStart(e.target.value) }}
                  className="bg-gray-900 border border-gray-800 text-white rounded px-2 py-1 font-mono focus:outline-none focus:border-blue-500 cursor-pointer"
                />
              </label>
              <span className="text-gray-600">→</span>
              <label
                className="flex items-center gap-1.5 text-gray-400 cursor-pointer hover:text-gray-200"
                onClick={e => {
                  if ((e.target as HTMLElement).tagName !== 'INPUT') {
                    e.preventDefault()
                    ;(e.currentTarget.querySelector('input[type=date]') as HTMLInputElement | null)?.showPicker?.()
                  }
                }}
              >
                <span>To</span>
                <input
                  type="date"
                  value={customEnd}
                  min={customStart}
                  max={defaultEndDate}
                  onChange={e => { if (isValidDateString(e.target.value)) setCustomEnd(e.target.value) }}
                  className="bg-gray-900 border border-gray-800 text-white rounded px-2 py-1 font-mono focus:outline-none focus:border-blue-500 cursor-pointer"
                />
              </label>
              <button
                type="button"
                onClick={() => { setCustomStart(defaultStartDate); setCustomEnd(defaultEndDate) }}
                className="text-gray-500 hover:text-white ml-1"
                title="Reset to full available range"
              >
                Reset
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Source-filter warning — surfaces hidden data when not on "All". */}
      {source !== 'all' && hiddenInRange > 0 && (
        <div className="bg-yellow-950/30 border border-yellow-900/40 text-yellow-200/90 text-xs rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>
            Source filter: <strong className="text-yellow-100">{source === 'native' ? 'Native only' : 'Historical only'}</strong>.
            {' '}<strong className="text-yellow-100">{hiddenInRange.toLocaleString()}</strong> trade{hiddenInRange === 1 ? '' : 's'} in
            this date range {hiddenInRange === 1 ? 'is' : 'are'} hidden from the {source === 'native' ? 'Tradezella' : 'live'} side.
          </span>
          <button
            type="button"
            onClick={() => setSource('all')}
            className="shrink-0 text-yellow-100 hover:text-white border border-yellow-800/60 hover:border-yellow-600 rounded px-2 py-0.5 transition-colors"
          >
            Show all
          </button>
        </div>
      )}

      {/* Overall stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <StatCard label="Trades" value={overall.count.toString()} positive={null} />
        <StatCard
          label="Win Rate"
          value={`${(overall.win_rate * 100).toFixed(0)}%`}
          positive={overall.win_rate >= 0.5}
        />
        <StatCard
          label="Total PnL"
          value={`${overall.total_pnl >= 0 ? '+' : ''}$${overall.total_pnl.toFixed(0)}`}
          positive={overall.total_pnl >= 0}
        />
        <StatCard
          label="Expectancy"
          value={`${overall.expectancy >= 0 ? '+' : ''}$${overall.expectancy.toFixed(2)}`}
          positive={overall.expectancy >= 0}
        />
        <StatCard
          label="Profit Factor"
          value={Number.isFinite(overall.profit_factor) ? overall.profit_factor.toFixed(2) : '∞'}
          positive={overall.profit_factor >= 1}
        />
        <StatCard
          label="Avg R"
          value={overall.avg_r == null ? '—' : `${overall.avg_r >= 0 ? '+' : ''}${overall.avg_r.toFixed(2)}R`}
          hint={`${overall.r_count} of ${overall.count}`}
          positive={overall.avg_r != null && overall.avg_r >= 0}
        />
      </div>

      {/* Tag performance sections */}
      <TagPerformanceTable
        title="Setup Performance"
        description="Win rate, expectancy, and PnL by setup tag"
        data={setupPerf}
      />
      <TagPerformanceTable
        title="Confluences"
        description="Performance when each confluence was tagged on the trade"
        data={confluencePerf}
      />
      <TagPerformanceTable
        title="Order Flow"
        description="Performance broken down by order-flow signal tags"
        data={orderFlowPerf}
      />
      <TagPerformanceTable
        title="Day Type"
        description="Performance by the day type set during prep"
        data={dayTypePerf}
      />
      <TagPerformanceTable
        title="Trade Management"
        description="How different management styles played out"
        data={mgmtPerf}
        minCount={2}
      />

      <TagImpactTable
        title="Mistakes Impact"
        description="Avg PnL on trades where each mistake was tagged vs. trades without it (most damaging at top)"
        data={mistakesImpact}
        variant="mistakes"
      />
      <TagImpactTable
        title="Emotions Impact"
        description="Avg PnL by emotional state — highlights what mindset costs vs. helps"
        data={emotionsImpact}
        variant="emotions"
      />

      <ConditionBuckets trades={filtered} />

      <RollingPerformance trades={filtered} />
    </div>
  )
}

function StatCard({
  label,
  value,
  hint,
  positive,
}: {
  label: string
  value: string
  hint?: string
  positive: boolean | null
}) {
  const color = positive == null ? 'text-white' : positive ? 'text-green-400' : 'text-red-400'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      {hint && <p className="text-[10px] text-gray-600 mt-0.5">{hint}</p>}
    </div>
  )
}
