'use client'

import { useMemo } from 'react'
import LiveChart from '@/components/charts/LiveChart'
import type { Trade, TradingDay } from '@/lib/supabase/types'

const DISPLAY = { fontFamily: 'var(--font-display)' } as const

const PT_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const fmtTime = (iso: string | null) => (iso ? PT_TIME.format(new Date(iso)) : '—')

export default function SharedDayView({ day, trades }: { day: TradingDay; trades: Trade[] }) {
  // Most-common symbol on the day → drives the chart's bars/levels query.
  const symbol = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of trades) if (t.symbol) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1)
    let best: string | null = null, n = 0
    for (const [s, c] of counts) if (c > n) { best = s; n = c }
    return best
  }, [trades])

  const dateLabel = (() => {
    try {
      return new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    } catch { return day.date }
  })()

  const totalPnl = trades.reduce((a, t) => a + (t.pnl ?? 0), 0)

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      <header className="border-b border-gray-800">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/tapescore-logo.svg" alt="TapeScore" className="h-9 w-auto" />
          <span className="text-xs font-mono uppercase tracking-widest text-blue-500">Shared for review</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h1 className="text-xl font-semibold text-white" style={DISPLAY}>{dateLabel}</h1>
          <div className="text-sm text-gray-400">
            {trades.length} trade{trades.length === 1 ? '' : 's'} ·{' '}
            <span className={totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Interactive chart — hover entry/exit arrows to inspect fills. */}
        <div className="mt-5 bg-gray-900 border border-gray-800 rounded-xl p-4">
          <LiveChart date={day.date} symbol={symbol} trades={trades} readOnly height={520} />
          <p className="text-xs text-gray-500 mt-2">
            Hover the entry/exit markers to inspect fills · scroll to zoom · drag to pan.
          </p>
        </div>

        {trades.length > 0 && (
          <div className="mt-6 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-2 font-medium">Time (PT)</th>
                  <th className="px-4 py-2 font-medium">Dir</th>
                  <th className="px-4 py-2 font-medium">Entry</th>
                  <th className="px-4 py-2 font-medium">Exit</th>
                  <th className="px-4 py-2 font-medium">Qty</th>
                  <th className="px-4 py-2 font-medium text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id} className="border-b border-gray-800/60 last:border-0">
                    <td className="px-4 py-2 font-mono text-gray-300">{fmtTime(t.entry_time)}</td>
                    <td className="px-4 py-2 capitalize">{t.direction ?? '—'}</td>
                    <td className="px-4 py-2 font-mono">{t.entry_price ?? '—'}</td>
                    <td className="px-4 py-2 font-mono">{t.exit_price ?? '—'}</td>
                    <td className="px-4 py-2 font-mono">{t.quantity ?? '—'}</td>
                    <td className={`px-4 py-2 font-mono text-right ${(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {day.eod_notes && (
          <div className="mt-6 bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Notes</h2>
            <p className="text-sm text-gray-300 whitespace-pre-wrap">{day.eod_notes}</p>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-gray-600">
          Read-only shared session · <span style={DISPLAY} className="text-gray-400">TapeScore</span> — game film for traders
        </p>
      </main>
    </div>
  )
}
