'use client'

import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import BarChart from '@/components/charts/BarChart'
import { bucketByNumeric, type TradeWithContext, type Bucket } from '@/lib/analytics'

/**
 * Was: filter on trading_day_id (excluded all historical trades because
 * histToContext sets it to ''). Now: filter on whether any context FIELD is
 * actually populated, because the date-keyed lookup in analytics/page.tsx
 * inherits market_context onto historical trades whose date has data. A
 * historical trade with rvol/ib/adr/atr filled by inheritance is a real
 * market-context match and should bucket correctly, not get filtered out as
 * "Unknown".
 */
function hasMarketContext(t: TradeWithContext): boolean {
  return (
    t.rvol != null ||
    t.ib_size != null ||
    t.ib_vs_10d_avg != null ||
    t.adr != null ||
    t.atr_1m != null
  )
}

interface ConditionDef {
  key: 'rvol' | 'ib_vs_10d_avg' | 'ib_size' | 'adr' | 'atr_1m'
  title: string
  description: string
  breaks: number[]
  format: (n: number) => string
  /** Per-trade value override. Returns the entry-time snapshot when available
   *  (preferred — no afternoon lookahead), falls back to the day-level value
   *  on the trade row when the per-trade snapshot is null (e.g., pre-2025
   *  trades, or trades whose entry fell outside RTH). Conditions that are
   *  structurally day-level (IB size, ADR, IB vs 10d) leave this undefined
   *  and the chart uses t[key] directly. */
  resolve?: (t: TradeWithContext) => number | null
}

// Bucket boundaries are scale-of-the-data, NOT one-size-fits-all. NQ/MNQ
// values are larger than ES; the original breaks were sized for ES and
// dumped every trade into the top bucket. Rvol is stored as PERCENT
// (100 = average) per the live market_context data, so the breaks are on
// the percent scale — not the ratio scale.
const CONDITIONS: ConditionDef[] = [
  {
    key: 'rvol',
    title: 'Relative Volume (at entry)',
    description: '100 = average pace. Cumulative volume from RTH open through the entry minute / 10d avg same window. Trades pre-2025 fall back to full-day RVOL.',
    breaks: [70, 100, 130, 180],
    format: n => `${n.toFixed(0)}%`,
    // Prefer per-trade entry-time RVOL; fall back to day-level rvol when null.
    resolve: t => t.entry_rvol ?? t.rvol,
  },
  {
    key: 'ib_vs_10d_avg',
    title: 'IB Size vs 10d Avg',
    description: 'Ratio of today\'s IB range to the trailing 10-day average.',
    breaks: [0.7, 1.0, 1.3],
    format: n => `${n.toFixed(1)}×`,
  },
  // Break points below are rounded to nice numbers AT the actual quintile
  // boundaries of the user's market_context data (queried 2026-06-09):
  //   IB:    p20=105, p40=144, p60=185, p80=243   → [100, 150, 200, 250]
  //   ADR:   p20=216, p40=265, p60=316, p80=383   → [220, 270, 320, 380]
  //   ATR:   p20=10.0, p40=12.0, p60=14.9, p80=19.5 → [10, 12, 15, 20]
  // Earlier breaks (150/250/350/500 for IB, etc.) were guess-based and
  // dumped 60-70% of trades into the middle bucket, leaving the wings
  // sparse and the visualization useless. These quintile-aligned breaks
  // give roughly 20% of trades per bucket so each band is informative.
  {
    key: 'ib_size',
    title: 'IB Size (points)',
    description: 'Initial Balance range in raw points.',
    breaks: [100, 150, 200, 250],
    format: n => n.toFixed(0),
  },
  {
    key: 'adr',
    title: 'Average Daily Range',
    description: 'ADR in points (RTH).',
    breaks: [220, 270, 320, 380],
    format: n => n.toFixed(0),
  },
  {
    key: 'atr_1m',
    title: 'ATR-10 (at entry)',
    description: 'Wilder ATR-10 on 1m bars, snapshotted at the minute of entry. Trades pre-2025 fall back to end-of-RTH ATR.',
    breaks: [10, 12, 15, 20],
    format: n => n.toFixed(0),
    // Prefer per-trade entry-time ATR; fall back to day-level atr_1m when null.
    resolve: t => t.entry_atr_1m ?? t.atr_1m,
  },
]

interface Props {
  trades: TradeWithContext[]
}

export default function ConditionBuckets({ trades }: Props) {
  // Default collapsed — analytics page has many sections and starting them
  // all open made the page feel cluttered. User opens the section they care
  // about for that review.
  const [open, setOpen] = useState(false)
  const scopedTrades = useMemo(() => trades.filter(hasMarketContext), [trades])
  const excluded = trades.length - scopedTrades.length
  return (
    // Wrapped in the same card styling as every other analytics section
    // (bg-gray-900 / border / rounded-xl / p-5) so this section stops
    // visually orphaning at the bottom of the page.
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 text-left">
        <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div>
          <h2 className="font-semibold text-white">Performance by Market Condition</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            How your trades performed across different market regimes — {scopedTrades.length} trade{scopedTrades.length === 1 ? '' : 's'} in window
            {excluded > 0 && (
              <span className="text-gray-600">
                {' · '}{excluded} historical excluded (no market data)
              </span>
            )}
          </p>
        </div>
      </button>

      {open && (
        <div className="grid gap-4 lg:grid-cols-2 mt-4">
          {CONDITIONS.map(c => (
            <ConditionCard key={c.key} cond={c} trades={scopedTrades} />
          ))}
        </div>
      )}
    </section>
  )
}

function ConditionCard({ cond, trades }: { cond: ConditionDef; trades: TradeWithContext[] }) {
  // Use per-trade resolver when provided (rvol/atr_1m → entry-time snapshot
  // with day-level fallback). Day-level structural conditions (IB/ADR/etc)
  // omit the resolver and we read t[cond.key] directly. valueOf is inlined
  // into the useMemo callback so its identity doesn't change render-to-render.
  const buckets = useMemo(
    () => {
      const valueOf = cond.resolve ?? ((t: TradeWithContext) => t[cond.key])
      return bucketByNumeric(trades, valueOf, cond.breaks, cond.format)
    },
    [trades, cond.resolve, cond.key, cond.breaks, cond.format],
  )

  // Hide ANY bucket with zero trades — previously we kept named buckets
  // (those with non-null range bounds) even when empty, which produced rows
  // like "≥ 500 | 0 | — | — | —" cluttering the table. User wants the
  // chart/table to show only buckets that have actual trades to evaluate.
  const visible = buckets.filter(b => b.trades.length > 0)

  if (visible.every(b => b.trades.length === 0)) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="font-medium text-white text-sm">{cond.title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{cond.description}</p>
        <p className="text-center text-xs text-gray-600 italic py-6">No data — populate market context for trading days first.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="font-medium text-white text-sm">{cond.title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{cond.description}</p>
      </div>

      <BarChart
        data={visible.map(b => ({
          label: b.label,
          value: b.stats.total_pnl,
          hint: `${b.stats.count} · ${(b.stats.win_rate * 100).toFixed(0)}%`,
        }))}
        height={140}
        formatValue={v => `${v >= 0 ? '+' : ''}$${v.toFixed(0)}`}
      />

      <BucketTable buckets={visible} />
    </div>
  )
}

function BucketTable({ buckets }: { buckets: Bucket[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead className="text-gray-500 border-b border-gray-800">
          <tr>
            <th className="text-left font-normal py-1.5 pr-3">Bucket</th>
            <th className="text-right font-normal py-1.5 pr-3">N</th>
            <th className="text-right font-normal py-1.5 pr-3">Win %</th>
            <th className="text-right font-normal py-1.5 pr-3">Expectancy</th>
            <th className="text-right font-normal py-1.5">Total PnL</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map(b => (
            <tr key={b.label} className="border-b border-gray-800/50">
              <td className="py-1.5 pr-3 text-gray-300">{b.label}</td>
              <td className="py-1.5 pr-3 text-right text-gray-400">{b.stats.count}</td>
              <td className={`py-1.5 pr-3 text-right ${b.stats.win_rate >= 0.5 ? 'text-green-400' : 'text-gray-400'}`}>
                {b.stats.count === 0 ? '—' : `${(b.stats.win_rate * 100).toFixed(0)}%`}
              </td>
              <td className={`py-1.5 pr-3 text-right ${b.stats.expectancy > 0 ? 'text-green-400' : b.stats.expectancy < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                {b.stats.count === 0 ? '—' : `${b.stats.expectancy >= 0 ? '+' : ''}${b.stats.expectancy.toFixed(2)}`}
              </td>
              <td className={`py-1.5 text-right font-bold ${b.stats.total_pnl > 0 ? 'text-green-400' : b.stats.total_pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                {b.stats.count === 0 ? '—' : `${b.stats.total_pnl >= 0 ? '+' : ''}$${b.stats.total_pnl.toFixed(0)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
