'use client'

import { useMemo } from 'react'
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
    description: '1.0 = average. Higher Rvol = more activity than typical.',
    breaks: [0.7, 1.0, 1.5, 2.0],
    format: n => n.toFixed(2),
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
    breaks: [30, 50, 80, 120],
    format: n => n.toFixed(0),
  },
  {
    key: 'adr',
    title: 'Average Daily Range',
    description: 'ADR in points (RTH).',
    breaks: [80, 120, 180],
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
  return (
    <section>
      <header className="mb-3">
        <h2 className="font-semibold text-white">Performance by Market Condition</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          How your trades performed across different market regimes — {trades.length} trade{trades.length === 1 ? '' : 's'} in window
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {CONDITIONS.map(c => (
          <ConditionCard key={c.key} cond={c} trades={trades} />
        ))}
      </div>
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
