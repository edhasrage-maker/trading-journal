'use client'

import { useMemo, useState } from 'react'
import { format, subMonths } from 'date-fns'
import TagPerformanceTable from './TagPerformanceTable'
import TagImpactTable from './TagImpactTable'
import ConditionBuckets from './ConditionBuckets'
import RollingPerformance from './RollingPerformance'
import PeriodComparison from './PeriodComparison'
import JournalThemes from './JournalThemes'
import CsvExportButton from './CsvExportButton'
import TradeListModal, { type ModalCategory } from './TradeListModal'
import {
  aggregateByTag,
  aggregateByDayType,
  tagImpact,
  computeStats,
  type TradeWithContext,
} from '@/lib/analytics'

interface Props {
  trades: TradeWithContext[]
  /** Per-day stats fed to PeriodComparison: date, eod_pnl override, and the
   *  prep AI's process score. Separate from `trades` so the comparison can
   *  pull day-level metrics without re-aggregating per-trade. */
  dayStats: Array<{ date: string; eod_pnl: number | null; process_score: number | null }>
  defaultStartDate: string
  defaultEndDate: string
}

const RANGE_OPTIONS: { label: string; months: number }[] = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: 'All', months: 0 },
]

export default function AnalyticsClient({ trades, dayStats, defaultStartDate, defaultEndDate }: Props) {
  const today = format(new Date(), 'yyyy-MM-dd')
  // Range mode: either one of the preset windows (1M/3M/6M/1Y/All) OR a
  // user-entered From/To range. Two pieces of state so the user can flip
  // between modes without losing their custom selection.
  const [rangeMonths, setRangeMonths] = useState<number | 'custom'>(3)
  const [customFrom, setCustomFrom] = useState<string>(
    format(subMonths(new Date(), 3), 'yyyy-MM-dd'),
  )
  const [customTo, setCustomTo] = useState<string>(today)

  const startDate = useMemo(() => {
    if (rangeMonths === 'custom') return customFrom
    if (rangeMonths === 0) return defaultStartDate
    return format(subMonths(new Date(), rangeMonths), 'yyyy-MM-dd')
  }, [rangeMonths, defaultStartDate, customFrom])
  const endDate = useMemo(() => {
    if (rangeMonths === 'custom') return customTo
    return today > defaultEndDate ? today : defaultEndDate
  }, [rangeMonths, customTo, today, defaultEndDate])

  const filtered = useMemo(() => {
    return trades.filter(t => t.date >= startDate && t.date <= endDate)
  }, [trades, startDate, endDate])
  // Day stats filtered to the same range so the period-comparison table
  // honors the global range selector at the top of the page.
  const filteredDayStats = useMemo(() => {
    return dayStats.filter(d => d.date >= startDate && d.date <= endDate)
  }, [dayStats, startDate, endDate])

  const overall = useMemo(() => computeStats(filtered), [filtered])

  const setupPerf = useMemo(() => aggregateByTag(filtered, 'setups'), [filtered])
  const confluencePerf = useMemo(() => aggregateByTag(filtered, 'confluences'), [filtered])
  const orderFlowPerf = useMemo(() => aggregateByTag(filtered, 'order_flow'), [filtered])
  const mgmtPerf = useMemo(() => aggregateByTag(filtered, 'trade_management'), [filtered])
  const dayTypePerf = useMemo(() => aggregateByDayType(filtered), [filtered])

  // Drilldown modal state — which (category, label) pair the user clicked
  // on. Click any tag label in any of the five performance tables to open
  // a list of the trades behind that aggregate.
  const [openTag, setOpenTag] = useState<{ category: ModalCategory; label: string } | null>(null)
  const openCategory = (category: ModalCategory) => (label: string) => setOpenTag({ category, label })

  // Mistakes + Emotions impact aggregations removed — both categories hidden
  // from the tagging system pending a redesign. Historical tag data is
  // preserved in tags_json; restore these two lines and the two
  // <TagImpactTable> renders below to re-expose without DB changes.

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Analytics</h1>
          <p className="text-gray-400 text-sm mt-1">
            {format(new Date(startDate + 'T12:00:00'), 'MMM d, yyyy')} – {format(new Date(endDate + 'T12:00:00'), 'MMM d, yyyy')}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <CsvExportButton from={startDate} to={endDate} />

            {/* Range selector — preset windows plus a "Custom" button that
                reveals From/To date inputs below. Custom is a sibling of the
                presets (not a separate mode toggle) so it's discoverable. */}
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
              <button
                onClick={() => setRangeMonths('custom')}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-800 ${
                  rangeMonths === 'custom'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                Custom
              </button>
            </div>
          </div>

          {rangeMonths === 'custom' && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <label className="text-gray-500">From</label>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={e => setCustomFrom(e.target.value)}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-200 [color-scheme:dark] focus:outline-none focus:border-blue-600"
              />
              <label className="text-gray-500">To</label>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={e => setCustomTo(e.target.value)}
                className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-gray-200 [color-scheme:dark] focus:outline-none focus:border-blue-600"
              />
            </div>
          )}
        </div>
      </div>

      {/* Overall stats */}
      <div className="grid grid-cols-2 md:grid-cols-8 gap-3">
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
        <StatCard
          label="MFE Realized %"
          value={overall.avg_capture == null ? '—' : `${(overall.avg_capture * 100).toFixed(0)}%`}
          hint={`${overall.capture_count} of ${overall.count}`}
          positive={overall.avg_capture != null && overall.avg_capture >= 0.5}
        />
        <StatCard
          label="MAE Heat %"
          value={overall.avg_heat == null ? '—' : `${Math.round(overall.avg_heat * 100)}%`}
          hint={`${overall.heat_count} of ${overall.count}`}
          positive={overall.avg_heat != null && overall.avg_heat <= 0.6}
        />
      </div>

      {/* Tag performance sections — each label click opens TradeListModal
          filtered to that tag (within the active date range). */}
      <TagPerformanceTable
        title="Setup Performance"
        description="Win rate, expectancy, and PnL by setup tag"
        data={setupPerf}
        onTagClick={openCategory('setups')}
      />
      <TagPerformanceTable
        title="Confluences"
        description="Performance when each confluence was tagged on the trade"
        data={confluencePerf}
        onTagClick={openCategory('confluences')}
      />
      <TagPerformanceTable
        title="Order Flow"
        description="Performance broken down by order-flow signal tags"
        data={orderFlowPerf}
        onTagClick={openCategory('order_flow')}
      />
      <TagPerformanceTable
        title="Day Type"
        description="Performance by the day type set during prep"
        data={dayTypePerf}
        onTagClick={openCategory('day_types')}
      />
      <TagPerformanceTable
        title="Trade Management"
        description="How different management styles played out"
        data={mgmtPerf}
        minCount={2}
        onTagClick={openCategory('trade_management')}
      />

      {/* Mistakes / Emotions Impact tables removed — pending new tagging
          system. Historical data preserved in tags_json. */}

      <ConditionBuckets trades={filtered} />

      <RollingPerformance trades={filtered} />

      <PeriodComparison trades={filtered} dayStats={filteredDayStats} />

      <JournalThemes from={startDate} to={endDate} />

      {/* Drilldown drawer — uses `filtered` (date-range-scoped) and includes
          both native + historical trades. Closes via Escape, backdrop, or X. */}
      <TradeListModal
        open={openTag}
        trades={filtered}
        onClose={() => setOpenTag(null)}
      />
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
