'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import TagPerformanceTable from './TagPerformanceTable'
import TagImpactTable from './TagImpactTable'
import ConditionBuckets from './ConditionBuckets'
import RollingPerformance from './RollingPerformance'
import PeriodComparison from './PeriodComparison'
import JournalThemes from './JournalThemes'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import CsvExportButton from './CsvExportButton'
import TradeListModal, { type ModalCategory } from './TradeListModal'
import DataInsights from '@/components/insights/DataInsights'
import { computeInsights, type InsightTrade } from '@/lib/data-insights'
import { mergeDiveInsights, runDives, toDiveRows, type DiveRow } from '@/lib/deep-dive/registry'
import { useUiMode } from '@/lib/ui-mode'
import { useTagCategories } from '@/lib/tag-categories-client'
import { useLongTaskBeacon } from '@/lib/longtask-beacon'
import { MIN_SAMPLE, tooFewToJudge } from '@/lib/sample-size'
import {
  aggregateByTag,
  aggregateByDayType,
  aggregateByStructureFollowFade,
  aggregateByIbRegime,
  aggregateByIbSizeBand,
  tagImpact,
  computeStats,
  formatCapturePct,
  CAPTURE_MISMATCH_TOOLTIP,
  type TradeWithContext,
} from '@/lib/analytics'

/** Active window preset. Resolved server-side from searchParams — the page
 *  only ships trades inside the window (alpha-readiness P0: stop sending the
 *  entire history to the browser). */
export type AnalyticsRange = '1m' | '3m' | '6m' | '1y' | 'all' | 'custom'

interface Props {
  trades: TradeWithContext[]
  /** Per-day stats fed to PeriodComparison: date, eod_pnl override, and the
   *  prep AI's process score. Separate from `trades` so the comparison can
   *  pull day-level metrics without re-aggregating per-trade. */
  dayStats: Array<{ date: string; eod_pnl: number | null; process_score: number | null }>
  activeRange: AnalyticsRange
  /** Resolved window bounds (YYYY-MM-DD, both inclusive). */
  windowStart: string
  windowEnd: string
  /** From the trader's scoring profile (resolveRubric). When false, order-flow
   *  breakdowns are hidden — mirrors the AI lens rule in the UI (Pt 17). The
   *  owner's empty profile resolves to true, so the local app is unchanged. */
  usesOrderFlow: boolean
}

const RANGE_OPTIONS: { label: string; param: Exclude<AnalyticsRange, 'custom'> }[] = [
  { label: '1M', param: '1m' },
  { label: '3M', param: '3m' },
  { label: '6M', param: '6m' },
  { label: '1Y', param: '1y' },
  { label: 'All', param: 'all' },
]

/** Tighter headings for the cross-tab filter dropdown, where the canonical
 *  category names are too long. Anything unlisted (every custom category)
 *  uses its own label. */
const FILTER_SHORT_LABELS: Record<string, string> = {
  setups: 'Setup',
  confluences: 'Confluence',
  order_flow: 'Orderflow',
  trade_management: 'Trade Mgmt',
  mistakes: 'Mistake',
  emotions: 'Emotion',
}

export default function AnalyticsClient({ trades, dayStats, activeRange, windowStart, windowEnd, usesOrderFlow }: Props) {
  const today = format(new Date(), 'yyyy-MM-dd')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  // Custom From/To inputs — local state seeded from the active window; each
  // valid change navigates, and the server re-windows the payload.
  const [customOpen, setCustomOpen] = useState(activeRange === 'custom')
  const [customFrom, setCustomFrom] = useState<string>(windowStart)
  const [customTo, setCustomTo] = useState<string>(windowEnd)

  const startDate = windowStart
  const endDate = windowEnd

  const applyRange = (param: Exclude<AnalyticsRange, 'custom'>) => {
    setCustomOpen(false)
    startTransition(() => router.replace(`/analytics?range=${param}`, { scroll: false }))
  }
  const applyCustom = (from: string, to: string) => {
    if (!from || !to || from > to) return
    startTransition(() => router.replace(`/analytics?from=${from}&to=${to}`, { scroll: false }))
  }

  // Server already windows the payload; this is a cheap exact guard for the
  // few slack rows around the window edges during a pending transition.
  const dateFiltered = useMemo(() => {
    return trades.filter(t => t.date >= startDate && t.date <= endDate)
  }, [trades, startDate, endDate])

  // The trader's own tag categories, for the cross-tab filter below.
  const tagCategories = useTagCategories()

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
  //
  // The tag categories are the TRADER'S OWN (Pt 16) — built-ins they kept plus
  // any axis they added in Settings → Tags — so a custom category like "4h
  // Candle Shape" breaks out here exactly like Setup does. The generic branch
  // below already reads tags_json[category], so nothing else needed widening.
  // 'structure_5m' is appended as a derived (non-tag) filter.
  type FilterCategory = string
  const filterOptions = useMemo(() => [
    ...tagCategories.map(c => ({ key: c.key, label: FILTER_SHORT_LABELS[c.key] ?? c.label })),
    { key: 'structure_5m', label: '5m Structure' },
  ], [tagCategories])
  const filterLabelFor = (key: string): string =>
    filterOptions.find(o => o.key === key)?.label ?? key
  const [filterCategory, setFilterCategory] = useState<FilterCategory | ''>('')
  const [filterLabel, setFilterLabel] = useState<string>('')
  // Beginner shows a plain KPI subset + Setup Performance + Journal Themes; Pro
  // shows all metrics and every breakdown table. (docs/BEGINNER_PRO_MODES.md)
  const { mode } = useUiMode()

  // Alpha-readiness item 6 tail: watch for main-thread hangs on this page (two
  // ~10-min renderer stalls were reported but never reproduced). Beacons a
  // summary to the Vercel logs only when blocking is actually noticeable.
  useLongTaskBeacon({ route: '/analytics', meta: { range: activeRange, trades: trades.length, mode } })

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

  // Tag-free insights (Pt 15) — patterns derived from the raw fills alone, so a
  // freshly-imported account (whose Setup table below collapses to a single
  // Discretionary bucket) still gets a real "what your data already says" read.
  // Computed over the same `filtered` set every table reads, gated + ranked by
  // (effect × sample confidence); the engine returns nothing on a thin sample,
  // and DataInsights renders nothing when the list is empty.
  // Deep dives (Pt 11) merge into the same list: they carry the modelled-dollar
  // findings the contrast engine can't produce, and each supersedes any
  // shallower read of its own subject. Pure functions over rows already in
  // memory, so this costs no extra query.
  const insights = useMemo(
    () => mergeDiveInsights(
      computeInsights(filtered.map(toInsightTrade), { limit: 6 }),
      runDives(toDiveRows(filtered as unknown as (Partial<DiveRow> & { id: string })[])),
      5,
    ),
    [filtered],
  )

  const setupPerf = useMemo(() => aggregateByTag(filtered, 'setups'), [filtered])
  const confluencePerf = useMemo(() => aggregateByTag(filtered, 'confluences'), [filtered])
  const orderFlowPerf = useMemo(() => aggregateByTag(filtered, 'order_flow'), [filtered])
  const mgmtPerf = useMemo(() => aggregateByTag(filtered, 'trade_management'), [filtered])
  const dayTypePerf = useMemo(() => aggregateByDayType(filtered), [filtered])
  const structurePerf = useMemo(() => aggregateByStructureFollowFade(filtered), [filtered])
  const ibRegimePerf = useMemo(() => aggregateByIbRegime(filtered), [filtered])
  const ibSizePerf = useMemo(() => aggregateByIbSizeBand(filtered), [filtered])

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
        <div data-tour="analytics-header">
          <h1
            className="text-[clamp(22px,2.6vw,28px)] font-bold tracking-[-0.025em] text-gray-100 leading-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            What repeats in your trading.
          </h1>
          <p className="text-gray-400 text-sm mt-1.5 tabular-nums">
            {format(new Date(startDate + 'T12:00:00'), 'MMM d, yyyy')} – {format(new Date(endDate + 'T12:00:00'), 'MMM d, yyyy')}
          </p>
        </div>

        <div data-tour="analytics-range" className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <CsvExportButton from={startDate} to={endDate} />

            {/* Range selector — preset windows plus a "Custom" button that
                reveals From/To date inputs below. Custom is a sibling of the
                presets (not a separate mode toggle) so it's discoverable. */}
            <div className={`inline-flex border border-gray-700 rounded overflow-hidden text-xs ${isPending ? 'opacity-60' : ''}`}>
              {RANGE_OPTIONS.map(o => (
                <button
                  key={o.label}
                  onClick={() => applyRange(o.param)}
                  className={`px-3 py-1.5 border-r border-gray-700 last:border-r-0 transition-colors ${
                    activeRange === o.param && !customOpen
                      ? 'bg-gray-800 text-gray-100 shadow-[inset_0_-2px_0_var(--color-accent-deep)]'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {o.label}
                </button>
              ))}
              <button
                onClick={() => setCustomOpen(true)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-800 ${
                  customOpen || activeRange === 'custom'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                Custom
              </button>
            </div>
          </div>

          {(customOpen || activeRange === 'custom') && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <label className="text-gray-500">From</label>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={e => { setCustomFrom(e.target.value); applyCustom(e.target.value, customTo) }}
                className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 [color-scheme:dark] focus:outline-none focus:border-blue-600"
              />
              <label className="text-gray-500">To</label>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={today}
                onChange={e => { setCustomTo(e.target.value); applyCustom(customFrom, e.target.value) }}
                className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-200 [color-scheme:dark] focus:outline-none focus:border-blue-600"
              />
            </div>
          )}
        </div>
      </div>

      {/* Cross-tab tag filter — pick a category + label, every aggregation
          below re-scopes to just trades carrying that tag. */}
      <div className="flex items-center gap-3 border-t border-gray-800 pt-3 flex-wrap">
        <span className="text-xs text-gray-500">Filter trades by tag</span>
        <select
          value={filterCategory}
          onChange={e => {
            setFilterCategory(e.target.value as FilterCategory | '')
            setFilterLabel('')   // reset label when category changes
          }}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-600"
        >
          <option value="">Category…</option>
          {filterOptions
            // Hide Orderflow as a filter category when the trader's profile
            // doesn't use order flow (Pt 17 profile-driven UI).
            .filter(o => usesOrderFlow || o.key !== 'order_flow')
            .map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
        </select>
        <select
          value={filterLabel}
          onChange={e => setFilterLabel(e.target.value)}
          disabled={!filterCategory || availableLabels.length === 0}
          className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1 min-w-[180px] focus:outline-none focus:border-blue-600 disabled:opacity-40"
        >
          <option value="">{filterCategory ? `Any ${filterLabelFor(filterCategory)}…` : 'Pick a category first'}</option>
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
            <span className="text-gray-500"> · {filterLabelFor(filterCategory)}: {filterLabel}</span>
          </span>
        )}
      </div>

      {/* Overall stats. Beginner: plain subset (Trades, Win Rate, Total PnL,
          Move captured). Pro: the full 8-metric grid. */}
      <div className={`grid grid-cols-2 gap-3 ${mode === 'beginner' ? (overall.avg_capture == null ? 'md:grid-cols-3' : 'md:grid-cols-4') : 'md:grid-cols-8'}`}>
        <StatCard label="Trades" value={overall.count.toString()} positive={null} />
        <StatCard
          label="Win Rate"
          value={`${(overall.win_rate * 100).toFixed(0)}%`}
          hint={overall.count < MIN_SAMPLE ? tooFewToJudge(overall.count) : `n=${overall.count}`}
          positive={overall.count < MIN_SAMPLE ? null : overall.win_rate >= 0.5}
        />
        <StatCard
          label="Total P&L"
          value={`${overall.total_pnl >= 0 ? '+' : ''}$${overall.total_pnl.toFixed(0)}`}
          positive={overall.total_pnl >= 0}
        />
        {mode === 'pro' && (
          <StatCard
            label="Expectancy"
            value={`${overall.expectancy >= 0 ? '+' : ''}$${overall.expectancy.toFixed(2)}`}
            positive={overall.expectancy >= 0}
          />
        )}
        {mode === 'pro' && (
          <StatCard
            label="Profit Factor"
            value={Number.isFinite(overall.profit_factor) ? overall.profit_factor.toFixed(2) : '∞'}
            hint={overall.count < MIN_SAMPLE ? tooFewToJudge(overall.count) : `n=${overall.count}`}
            positive={overall.count < MIN_SAMPLE ? null : overall.profit_factor >= 1}
          />
        )}
        {mode === 'pro' && (
          <StatCard
            label="Avg R"
            value={overall.avg_r == null ? '—' : `${overall.avg_r >= 0 ? '+' : ''}${overall.avg_r.toFixed(2)}R`}
            hint={`${overall.r_count} of ${overall.count}`}
            positive={overall.avg_r != null && overall.avg_r >= 0}
          />
        )}
        {/* Beginner hides this when there's no capture data (a bare "—" reads
            as broken); Pro always shows it. Same plain-English label in both. */}
        {(mode === 'pro' || overall.avg_capture != null) && (
          <StatCard
            label="Profit Captured"
            value={overall.avg_capture == null ? '—' : (formatCapturePct(overall.avg_capture) ?? '—')}
            title={overall.avg_capture != null && formatCapturePct(overall.avg_capture) == null ? CAPTURE_MISMATCH_TOOLTIP : undefined}
            hint={mode === 'beginner' ? "of your trade's best point" : `${overall.capture_count} of ${overall.count}`}
            positive={overall.avg_capture != null && formatCapturePct(overall.avg_capture) != null && overall.avg_capture >= 0.5}
          />
        )}
        {mode === 'pro' && (
          <StatCard
            label="MAE Heat %"
            value={overall.avg_heat == null ? '—' : `${Math.round(overall.avg_heat * 100)}%`}
            hint={`${overall.heat_count} of ${overall.count}`}
            positive={overall.avg_heat != null && overall.avg_heat <= 0.6}
          />
        )}
      </div>

      {/* Tag-free insights — leads the analysis section, directly above the
          Setup table (which is empty/Discretionary-only on a tagless import). */}
      <DataInsights insights={insights} variant="analytics" />

      {/* Tag performance sections — each label click opens TradeListModal
          filtered to that tag (within the active date range). */}
      <TagPerformanceTable
        title="Setup Performance"
        description={mode === 'beginner' ? 'Win rate and total P&L by setup' : 'Win rate, expectancy, and PnL by setup tag'}
        data={setupPerf}
        onTagClick={openCategory('setups')}
        columns={mode === 'beginner' ? 'plain' : 'full'}
      />
      {/* Deeper breakdowns are Pro-only — Beginner keeps Setup Performance +
          Journal Themes so it stays "what's working / what to watch" without a
          wall of tables. */}
      {mode === 'pro' && (
        <>
          <TagPerformanceTable
            title="Confluences"
            description="Performance when each confluence was tagged on the trade"
            data={confluencePerf}
            onTagClick={openCategory('confluences')}
          />
          {/* Order-flow breakdown renders only for traders whose profile uses
              order flow (Pt 17, doc item 16) — mirrors the AI lens rule in the
              UI. A one-line note tells power users where it went. Data/tags are
              untouched; this is a conditional render only. */}
          {usesOrderFlow ? (
            <TagPerformanceTable
              title="Order Flow"
              description="Performance broken down by order-flow signal tags"
              data={orderFlowPerf}
              onTagClick={openCategory('order_flow')}
            />
          ) : (
            <p className="text-xs text-gray-600 px-1">
              Order-flow breakdown hidden — not in your trader profile.{' '}
              <a href="/settings/coaching" className="text-blue-500 hover:text-blue-400">Turn it on in your Player Profile</a> to track it.
            </p>
          )}
          <TagPerformanceTable
            title="Day Type"
            description="Performance by the day type set during prep"
            data={dayTypePerf}
            onTagClick={openCategory('day_types')}
          />
          {/* Day CHARACTER — the derived counterpart to Day Type above. Two
              separate tables on purpose: Day Type is what you tagged after the
              fact, this is what the Initial Balance actually printed by 07:30.
              Merging them would make it impossible to tell a hindsight label
              from a measurement. Renders only once days have been classified
              (scripts/backfill-ib-day-type.ts). */}
          {ibRegimePerf.length > 0 && (
            <TagPerformanceTable
              title="Day Character (measured at IB close)"
              description="IB range ÷ its own ATR — how directional the first hour actually was. Derived from bars at 07:30 PT, not tagged by hand."
              data={ibRegimePerf}
            />
          )}
          {ibSizePerf.length > 0 && (
            <TagPerformanceTable
              title="IB Size Band (measured at IB close)"
              description="IB range vs its trailing 10-day average — how big the first hour was relative to normal."
              data={ibSizePerf}
            />
          )}
          <TagPerformanceTable
            title="Structure (Follow / Fade)"
            description="Pivot 5m market structure at entry — trading with vs against the HH-HL trend"
            data={structurePerf}
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
        </>
      )}

      {/* Journal Themes is still an "Under Construction" placeholder — only show
          it in the local power-user build; hide it entirely on the hosted/public
          build (incl. the demo account) so prospects don't see a stub feature. */}
      {LOCAL_FEATURES_ENABLED && <JournalThemes />}

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

/** Project a joined analytics row onto the raw shape the insight engine reads.
 *  exit_time / exits_json aren't on the shared TradeWithContext type (the
 *  analytics select fetches exit_time at runtime; exits_json is absent, and
 *  captureComponents tolerates its absence by falling back to the simple
 *  peak × full-qty formula), so both are read via a widening cast. */
function toInsightTrade(t: TradeWithContext): InsightTrade {
  const x = t as TradeWithContext & {
    exit_time?: string | null
    exits_json?: unknown
  }
  return {
    id: t.id,
    pnl: t.pnl,
    direction: t.direction,
    entry_time: t.entry_time,
    exit_time: x.exit_time ?? null,
    symbol: t.symbol,
    quantity: t.quantity,
    entry_price: t.entry_price,
    stop_price: t.stop_price,
    high_during_position: t.high_during_position,
    low_during_position: t.low_during_position,
    entry_atr_1m: t.entry_atr_1m,
    exits_json: x.exits_json ?? null,
    mfe_dollars_per_leg: t.mfe_dollars_per_leg,
    date: t.date,
    trading_day_id: t.trading_day_id,
    // Day-type context (inherited from market_context).
    ib_size: t.ib_size,
    ib_vs_10d_avg: t.ib_vs_10d_avg,
    atr_at_ib_close: t.atr_at_ib_close,
  }
}

function StatCard({
  label,
  value,
  hint,
  positive,
  title,
}: {
  label: string
  value: string
  hint?: string
  positive: boolean | null
  title?: string
}) {
  const color = positive == null ? 'text-gray-100' : positive ? 'text-green-400' : 'text-red-400'
  // A hairline row, not a boxed KPI card. The grid of bordered stat cards is
  // the most recognisable AI-dashboard move there is; the locked language reads
  // numbers as display numerals on a rule instead.
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-4 items-baseline py-2 border-t border-gray-800" title={title}>
      <span className="text-[13px] text-gray-400">{label}</span>
      <span
        className={`text-[17px] font-bold tabular-nums text-right ${color}`}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </span>
      {hint && <span className="text-[11px] text-gray-500 col-span-2">{hint}</span>}
    </div>
  )
}
