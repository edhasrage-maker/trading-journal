'use client'

import { Fragment, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import LiveChart from '@/components/charts/LiveChart'
import { useChartInstruments } from '@/lib/use-chart-instruments'
import { chartSeriesRoot, symbolToMultiplier } from '@/lib/futures-symbols'
import type { Trade, TradingDay } from '@/lib/supabase/types'

const DISPLAY = { fontFamily: 'var(--font-display)' } as const

const PT_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const fmtTime = (iso: string | null) => (iso ? PT_TIME.format(new Date(iso)) : '—')

// tags_json categories to surface, in review order. Mistakes render in red.
const TAG_CATS: Array<{ key: string; label: string; danger?: boolean }> = [
  { key: 'setups', label: 'Setup' },
  { key: 'confluences', label: 'Confluence' },
  { key: 'order_flow', label: 'Order flow' },
  { key: 'entry_model', label: 'Entry' },
  { key: 'trade_management', label: 'Management' },
  { key: 'emotions', label: 'Emotion' },
  { key: 'mistakes', label: 'Mistake', danger: true },
]

// Favorable / adverse excursion (points) from the recorded extremes.
function excursion(t: Trade): { fav: number | null; adv: number | null } {
  const e = t.entry_price, h = t.high_during_position, l = t.low_during_position
  if (e == null) return { fav: null, adv: null }
  const fav = t.direction === 'short' ? (l != null ? e - l : null) : (h != null ? h - e : null)
  const adv = t.direction === 'short' ? (h != null ? Math.max(0, h - e) : null) : (l != null ? Math.max(0, e - l) : null)
  return { fav, adv }
}
// Share of the favorable move banked (winners only) — same basis as the coach.
function capturePct(t: Trade): number | null {
  const { fav } = excursion(t)
  if (fav == null || fav <= 0 || t.pnl == null || t.pnl <= 0 || t.quantity == null) return null
  const mfeUsd = fav * t.quantity * symbolToMultiplier(t.symbol ?? '')
  return mfeUsd > 0 ? Math.min(1, t.pnl / mfeUsd) : null
}
function rMultiple(t: Trade): number | null {
  if (t.entry_price == null || t.stop_price == null || t.quantity == null || t.pnl == null) return null
  const risk = Math.abs(t.entry_price - t.stop_price) * t.quantity * symbolToMultiplier(t.symbol ?? '')
  return risk > 0 ? t.pnl / risk : null
}

export default function SharedDayView({ day, trades }: { day: TradingDay; trades: Trade[] }) {
  // Most-common symbol on the day → the chart's default instrument.
  const defaultSymbol = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of trades) if (t.symbol) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1)
    let best: string | null = null, n = 0
    for (const [s, c] of counts) if (c > n) { best = s; n = c }
    return best
  }, [trades])

  // Instrument switcher (ES/NQ dropdown) — same hook the intraday/EOD charts use.
  // Falls back to the day's traded symbols when /api/bars/symbols isn't reachable
  // (logged-out share context), so multi-instrument days still get a toggle.
  const { activeSymbol, symbolOptions, onSymbolChange, chartTrades } = useChartInstruments(defaultSymbol, trades)
  const [expanded, setExpanded] = useState<string | null>(null)

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

        {/* Interactive chart — switch instrument (NQ/ES) with the symbol menu;
            hover entry/exit arrows to inspect fills. */}
        <div className="mt-5 bg-gray-900 border border-gray-800 rounded-xl p-4">
          <LiveChart
            date={day.date}
            symbol={activeSymbol}
            symbolOptions={symbolOptions}
            onSymbolChange={onSymbolChange}
            trades={chartTrades}
            readOnly
            height={520}
          />
          <p className="text-xs text-gray-500 mt-2">
            {symbolOptions.length > 1 ? 'Switch instrument with the symbol menu (top-left) · ' : ''}
            Hover the entry/exit markers to inspect fills · scroll to zoom · drag to pan.
          </p>
        </div>

        {trades.length > 0 && (
          <div className="mt-6 bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="px-2 py-2 w-6"></th>
                  <th className="px-3 py-2 font-medium">Time (PT)</th>
                  <th className="px-3 py-2 font-medium">Symbol</th>
                  <th className="px-3 py-2 font-medium">Dir</th>
                  <th className="px-3 py-2 font-medium">Entry</th>
                  <th className="px-3 py-2 font-medium">Exit</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const isOpen = expanded === t.id
                  const cap = capturePct(t)
                  const { fav, adv } = excursion(t)
                  const r = rMultiple(t)
                  const tj: Record<string, unknown> = (t.tags_json && typeof t.tags_json === 'object')
                    ? (t.tags_json as unknown as Record<string, unknown>) : {}
                  const tagGroups = TAG_CATS
                    .map(c => ({ ...c, items: Array.isArray(tj[c.key]) ? (tj[c.key] as string[]) : [] }))
                    .filter(g => g.items.length > 0)
                  const note = t.notes && t.notes.trim() ? t.notes : ''
                  const hasStats = cap != null || adv != null || r != null || fav != null
                  const hasDetail = tagGroups.length > 0 || !!note || hasStats
                  return (
                    <Fragment key={t.id}>
                      <tr
                        className="border-b border-gray-800/60 last:border-0 cursor-pointer hover:bg-gray-800/40"
                        onClick={() => setExpanded(isOpen ? null : t.id)}
                      >
                        <td className="px-2 py-2 text-gray-500">
                          <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-300 whitespace-nowrap">{fmtTime(t.entry_time)}</td>
                        <td className="px-3 py-2 font-mono text-gray-400">{t.symbol ? chartSeriesRoot(t.symbol) : '—'}</td>
                        <td className="px-3 py-2 capitalize">{t.direction ?? '—'}</td>
                        <td className="px-3 py-2 font-mono">{t.entry_price ?? '—'}</td>
                        <td className="px-3 py-2 font-mono">{t.exit_price ?? '—'}</td>
                        <td className="px-3 py-2 font-mono">{t.quantity ?? '—'}</td>
                        <td className={`px-3 py-2 font-mono text-right whitespace-nowrap ${(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '—'}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-950/60 border-b border-gray-800/60">
                          <td></td>
                          <td colSpan={7} className="px-3 pb-4 pt-1">
                            {!hasDetail && (
                              <p className="text-xs text-gray-500">No tags or notes logged for this trade.</p>
                            )}
                            {hasStats && (
                              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400 mb-2">
                                {cap != null && <span>MFE captured <span className="text-gray-200 font-medium">{Math.round(cap * 100)}%</span></span>}
                                {fav != null && <span>Peak MFE <span className="text-gray-200 font-medium">{fav.toFixed(1)} pts</span></span>}
                                {adv != null && <span>Heat (MAE) <span className="text-gray-200 font-medium">{adv.toFixed(1)} pts</span></span>}
                                {r != null && <span>R <span className={`font-medium ${r >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r >= 0 ? '+' : ''}{r.toFixed(2)}</span></span>}
                              </div>
                            )}
                            {tagGroups.length > 0 && (
                              <div className="flex flex-col gap-1.5 mb-2">
                                {tagGroups.map(g => (
                                  <div key={g.key} className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-[10px] uppercase tracking-wider text-gray-600 w-24 shrink-0">{g.label}</span>
                                    {g.items.map((it, i) => (
                                      <span key={i} className={`text-xs px-2 py-0.5 rounded-full border ${g.danger ? 'border-red-800/60 text-red-300 bg-red-950/30' : 'border-gray-700 text-gray-300 bg-gray-800/50'}`}>{it}</span>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
                            {note && (
                              <p className="text-sm text-gray-300 whitespace-pre-wrap border-l-2 border-gray-700 pl-3">{note}</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {day.eod_notes && (
          <div className="mt-6 bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Day notes</h2>
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
