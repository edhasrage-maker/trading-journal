'use client'

import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import LineChart from '@/components/charts/LineChart'
import { rollingStats, maxDrawdown, type TradeLike } from '@/lib/analytics'
import { format } from 'date-fns'

interface Props {
  trades: TradeLike[]
}

const WINDOWS = [10, 20, 50]
const COLORS = ['#60a5fa', '#a78bfa', '#fbbf24'] // blue, violet, amber

export default function RollingPerformance({ trades }: Props) {
  const baseline = useMemo(() => rollingStats(trades, 1), [trades])
  const series = useMemo(() => WINDOWS.map(w => rollingStats(trades, w)), [trades])
  const [open, setOpen] = useState(false)

  if (baseline.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-2">Rolling Performance</h2>
        <p className="text-center text-xs text-gray-600 italic py-6">
          No trades with both entry_time and pnl in this window.
        </p>
      </section>
    )
  }

  const xLabels = baseline.map(p => format(new Date(p.date + 'T12:00:00'), 'MMM d'))
  const equityValues = baseline.map(p => p.cum_pnl)

  // Win rate / expectancy series (rolling per trade index)
  const winRateSeries = series.map((points, i) => ({
    label: `${WINDOWS[i]}-trade`,
    color: COLORS[i],
    values: points.map(p => p.rolling_win_rate * 100),
  }))
  const expectancySeries = series.map((points, i) => ({
    label: `${WINDOWS[i]}-trade`,
    color: COLORS[i],
    values: points.map(p => p.rolling_expectancy),
  }))

  const finalCum = baseline[baseline.length - 1]?.cum_pnl ?? 0
  const peakCum = Math.max(...baseline.map(p => p.cum_pnl), 0)
  const dd = maxDrawdown(baseline)

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-6">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 text-left">
        <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div>
          <h2 className="font-semibold text-white">Rolling Performance</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Equity curve and rolling stats over the last {trades.length} trades.
          </p>
        </div>
      </button>

      {open && (<>
      {/* Equity curve */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Equity Curve</h3>
          <div className="flex gap-4 text-xs font-mono">
            <span className="text-gray-500">
              Final: <span className={finalCum >= 0 ? 'text-green-400' : 'text-red-400'}>
                {finalCum >= 0 ? '+' : ''}${finalCum.toFixed(0)}
              </span>
            </span>
            <span className="text-gray-500">
              Peak: <span className="text-green-400">+${peakCum.toFixed(0)}</span>
            </span>
            <span className="text-gray-500">
              Max DD: <span className="text-red-400">-${dd.toFixed(0)}</span>
            </span>
          </div>
        </div>
        <LineChart
          xLabels={xLabels}
          series={[{ label: 'Cumulative PnL', color: '#22c55e', values: equityValues }]}
          height={200}
          formatY={v => `$${v.toFixed(0)}`}
          zeroLine
          showLegend={false}
        />
      </div>

      {/* Rolling win rate */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Rolling Win Rate</h3>
          <div className="flex gap-3 text-xs font-mono text-gray-500">
            {WINDOWS.map((w, i) => {
              const last = series[i][series[i].length - 1]
              return (
                <span key={w}>
                  {w}t: <span style={{ color: COLORS[i] }}>{last ? `${(last.rolling_win_rate * 100).toFixed(0)}%` : '—'}</span>
                </span>
              )
            })}
          </div>
        </div>
        <LineChart
          xLabels={xLabels}
          series={winRateSeries}
          height={180}
          formatY={v => `${v.toFixed(0)}%`}
        />
      </div>

      {/* Rolling expectancy */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Rolling Expectancy</h3>
          <div className="flex gap-3 text-xs font-mono text-gray-500">
            {WINDOWS.map((w, i) => {
              const last = series[i][series[i].length - 1]
              return (
                <span key={w}>
                  {w}t: <span style={{ color: COLORS[i] }}>
                    {last ? `${last.rolling_expectancy >= 0 ? '+' : ''}$${last.rolling_expectancy.toFixed(2)}` : '—'}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
        <LineChart
          xLabels={xLabels}
          series={expectancySeries}
          height={180}
          formatY={v => `$${v.toFixed(1)}`}
          zeroLine
        />
      </div>
      </>)}
    </section>
  )
}
