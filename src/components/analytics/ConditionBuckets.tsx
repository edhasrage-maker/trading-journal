'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import BarChart from '@/components/charts/BarChart'
import { bucketByNumeric, type TradeWithContext, type Bucket } from '@/lib/analytics'

interface ConditionDef {
  key: 'rvol' | 'ib_vs_10d_avg' | 'ib_size' | 'adr' | 'atr_1m'
  title: string
  description: string
  breaks: number[]
  format: (n: number) => string
}

const CONDITIONS: ConditionDef[] = [
  {
    key: 'rvol',
    title: 'Relative Volume',
    description: '100 = average. Higher Rvol = more activity than typical (stored as percentage).',
    breaks: [70, 100, 150, 200],
    format: n => n.toFixed(0),
  },
  {
    key: 'ib_vs_10d_avg',
    title: 'IB Size vs 10d Avg',
    description: 'Ratio of today\'s IB range to the trailing 10-day average.',
    breaks: [0.7, 1.0, 1.3],
    format: n => `${n.toFixed(1)}×`,
  },
  {
    key: 'ib_size',
    title: 'IB Size (points)',
    description: 'Initial Balance range in raw points.',
    // Calibrated for NQ/MNQ — recent native values cluster 137–330 with
    // median ~185. Older small-instrument breakpoints [30, 50, 80, 120]
    // dumped every NQ day into the ≥120 bucket.
    breaks: [120, 160, 200, 260],
    format: n => n.toFixed(0),
  },
  {
    key: 'adr',
    title: 'Average Daily Range',
    description: 'ADR in points (RTH).',
    // NQ ADR typically 280–410. Older [80, 120, 180] thresholds were below
    // even the quietest NQ days.
    breaks: [300, 340, 380],
    format: n => n.toFixed(0),
  },
  {
    key: 'atr_1m',
    title: 'ATR-10 (1m)',
    description: '1-minute ATR-10 — short-term volatility.',
    breaks: [10, 20, 40],
    format: n => n.toFixed(0),
  },
]

interface Props {
  trades: TradeWithContext[]
}

export default function ConditionBuckets({ trades }: Props) {
  const [open, setOpen] = useState(true)
  // Defer the BarChart render to post-hydration. The buckets feed BarChart's
  // SVG <rect> + <title> structure where the title text is derived from float
  // PnL totals; tiny float-precision drift between the SSR pass and the client
  // hydration pass (e.g. when the trades array order shifts even slightly under
  // memoization edge cases) shows up as a hydration mismatch on the title text.
  // Rendering the grid only after mount fully sidesteps SSR comparison for this
  // sub-tree without forcing the rest of the page to be client-only.
  const [mounted, setMounted] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount flag to gate post-hydration rendering of the BarChart sub-tree
  useEffect(() => { setMounted(true) }, [])
  return (
    <section>
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 text-left mb-3">
        <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div>
          <h2 className="font-semibold text-white">Performance by Market Condition</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            How your trades performed across different market regimes — {trades.length} trade{trades.length === 1 ? '' : 's'} in window
          </p>
        </div>
      </button>

      {open && (
        <div className="grid gap-4 lg:grid-cols-2">
          {mounted
            ? CONDITIONS.map(c => <ConditionCard key={c.key} cond={c} trades={trades} />)
            : CONDITIONS.map(c => (
                <div key={c.key} className="bg-gray-900 border border-gray-800 rounded-xl p-5 h-[280px]" />
              ))}
        </div>
      )}
    </section>
  )
}

function ConditionCard({ cond, trades }: { cond: ConditionDef; trades: TradeWithContext[] }) {
  const buckets = useMemo(
    () => bucketByNumeric(trades, t => t[cond.key], cond.breaks, cond.format),
    [trades, cond.key, cond.breaks, cond.format],
  )

  // Hide empty buckets except the Unknown sentinel — but keep Unknown only if it has data
  const visible = buckets.filter(b => b.trades.length > 0 || (b.range[0] != null || b.range[1] != null))

  if (visible.every(b => b.trades.length === 0)) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h3 className="font-medium text-white text-sm">{cond.title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{cond.description}</p>
        <p className="text-center text-xs text-gray-600 italic py-6">No data — populate market context for trading days first.</p>
      </div>
    )
  }

  // BarChart shows only the real buckets (defined numeric ranges). The
  // "Unknown" bucket is intentionally excluded from the chart — when many
  // historical trades lack market_context, an oversized Unknown bar dwarfs
  // the rest and the chart reads as a single green spike. The Unknown count
  // still surfaces in the table below so the user knows it's there.
  const barBuckets = visible.filter(b => b.range[0] != null || b.range[1] != null)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="font-medium text-white text-sm">{cond.title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{cond.description}</p>
      </div>

      {/* showValueLabels=false and no hint → bars + bucket-label row only, so
          the dense per-bucket numbers live exclusively in BucketTable below
          (which has dedicated columns for N / Win% / Expectancy / PnL). */}
      <BarChart
        data={barBuckets.map(b => ({
          label: b.label,
          value: b.stats.total_pnl,
        }))}
        height={140}
        formatValue={v => `${v >= 0 ? '+' : ''}$${v.toFixed(0)}`}
        showValueLabels={false}
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
