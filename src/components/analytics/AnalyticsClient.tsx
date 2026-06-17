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

  const dateFiltered = useMemo(() => {
    return trades.filter(t => t.date >= startDate && t.date <= endDate)
  }, [trades, startDate, endDate])

  // Cross-tab tag filter: pick a category + label and every aggregation
  // below (setup table, day-type table, period comparison, etc.) re-scopes
  // to just trades carrying that tag. Lets the trader ask things like
  // "of my delta-flip trades, how do they distribute across day types?"
  // or "S&D win rate on Range days only" without exporting to a spreadsheet.
  //
  // Categories supported:
  //   - 'setups' / 'confluences' / 'order_flow' / 'trade_management' /
  //     'mistakes' / 'emotions' — read from t.tags_json[category]
  //   - 'day_type' — read from t.day_types[] (or legacy t.day_type) — a
  //     trade-level property derived from the day's labels.
  type FilterCategory = 'setups' | 'confluences' | 'order_flow' | 'trade_management' | 'mistakes' | 'emotions' | 'day_type' | 'structure_5m'
  const FILTER_CATEGORY_LABELS: Record<FilterCategory, string> = {
    setups: 'Setup',
    confluences: 'Confluence',
    order_flow: 'Orderflow',
    trade_management: 'Trade Mgmt',
    mistakes: 'Mistake',
    emotions: 'Emotion',
    day_type: 'Day Type',
    structure_5m: '5m Structure',
  }
  const [filterCategory, setFilterCategory] = useState<FilterCategory | ''>('')
  const [filterLabel, setFilterLabel] = useState<string>('')

  // Available labels for the current filter category — computed from the
  // date-filtered set so the dropdown only offers labels actually present
  // in the chosen window.
  const availableLabels = useMemo(() => {
    if (!filterCategory) return []
    const set = new Set<string>()
    for (const t of dateFiltered) {
      if (filterCategory === 'day_type') {
        const types = t.day_types.length > 0 ? t.day_types : (t.day_type ? [t.day_type] : [])
        for (const raw of types) {
          const trimmed = raw?.trim()
          if (trimmed) set.add(trimmed)
        }
      } else if (filterCategory === 'structure_5m') {
        const v = (t as unknown as { structure_5m_alignment?: string | null }).structure_5m_alignment
        if (v === 'following' || v === 'fading' || v === 'neutral') set.add(v)
      } else {
        const tags = t.tags_json as { [k: string]: string[] | undefined } | null
        const arr = tags ? tags[filterCategory] : undefined
        if (!Array.isArray(arr)) continue
        for (const raw of arr) {
          const trimmed = raw?.trim()
          if (trimmed) set.add(trimmed)
        }
      }
    }
    return Array.from(set).sort()
  }, [dateFiltered, filterCategory])

  // The actual narrowed set every downstream aggregation reads from. Falls
  // through to dateFiltered when no tag filter is active.
  const filtered = useMemo(() => {
    if (!filterCategory || !filterLabel) return dateFiltered
    return dateFiltered.filter(t => {
      if (filterCategory === 'day_type') {
        const types = t.day_types.length > 0 ? t.day_types : (t.day_type ? [t.day_type] : [])
        return types.some(x => x?.trim() === filterLabel)
      }
      if (filterCategory === 'structure_5m') {
        return (t as unknown as { structure_5m_alignment?: string | null }).structure_5m_alignment === filterLabel
      }
      const tags = t.tags_json as { [k: string]: string[] | undefined } | null
      const arr = tags ? tags[filterCategory] : undefined
      if (!Array.isArray(arr)) return false
      return arr.some(x => x?.trim() === filterLabel)
    })
  }, [dateFiltered, filterCategory, filterLabel])
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

      {/* Cross-tab tag filter — pick a category + label, every aggregation
          below re-scopes to just trades carrying that tag. */}
      <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 flex-wrap">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Filter trades by tag</span>
        <select
          value={filterCategory}
          onChange={e => {
            setFilterCategory(e.target.value as FilterCategory | '')
            setFilterLabel('')   // reset label when category changes
          }}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-600"
        >
          <option value="">Category…</option>
          {(Object.keys(FILTER_CATEGORY_LABELS) as FilterCategory[]).map(c => (
            <option key={c} value={c}>{FILTER_CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        <select
          value={filterLabel}
          onChange={e => setFilterLabel(e.target.value)}
          disabled={!filterCategory || availableLabels.length === 0}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1 min-w-[180px] focus:outline-none focus:border-blue-600 disabled:opacity-40"
        >
          <option value="">{filterCategory ? `Any ${FILTER_CATEGORY_LABELS[filterCategory]}…` : 'Pick a category first'}</option>
          {availableLabels.map(label => (
            <option key={label} value={label}>{label}</option>
          ))}
        </select>
        {(filterCategory || filterLabel) && (
          <button
            type="button"
            onClick={() => { setFilterCategory(''); setFilterLabel('') }}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Clear filter
          </button>
        )}
        {filterCategory && filterLabel && (
          <span className="text-xs text-blue-300 ml-auto">
            Showing <span className="font-bold">{filtered.length}</span> of {dateFiltered.length} trades
            <span className="text-gray-500"> · {FILTER_CATEGORY_LABELS[filterCategory]}: {filterLabel}</span>
          </span>
        )}
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
