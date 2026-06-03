'use client'

import { format } from 'date-fns'
import { Check, Trash2, Loader2 } from 'lucide-react'
import { captureRatio, maeHeatRatio, isGiveBackTrade, rMultiple } from '@/lib/analytics'
import type { Trade } from '@/lib/supabase/types'

/** Display capture % per trade — uses the same null-handling as the intraday row. */
function captureDisplay(t: Trade): string | null {
  const r = captureRatio(t)
  if (r == null) return null
  return `${Math.max(-999, Math.min(999, r * 100)).toFixed(0)}%`
}

/** Display MAE Heat as a percentage per trade. 100% = MAE touched stop level. */
function heatDisplay(t: Trade): string | null {
  const r = maeHeatRatio(t)
  if (r == null) return null
  return `${Math.round(r * 100)}%`
}

interface Props {
  trades: Trade[]
  hoveredTradeId: string | null
  onHoverEnter: (tradeId: string, e: React.MouseEvent) => void
  onHoverLeave: () => void
  selectedIds: Set<string>
  onToggleSelect: (tradeId: string) => void
  nearDuplicateIds: Set<string>
  onDelete: (tradeId: string) => void
  deletingId: string | null
  /** Open this trade's full log in the intraday page. */
  onRowOpen?: (tradeId: string) => void
  /** AI 1-2 line narrative per trade id (shown in the Overview column). */
  summaries?: Record<string, string>
  /** True while summaries are being generated. */
  summariesLoading?: boolean
  /** Per-trade live ATR-10 (Wilder) in points, computed at each trade's entry_time from 1-min bars. Powers an "ATR @ entry" chip. */
  liveAtrByTradeId?: Record<string, number>
  /** Per-trade post-exit continuation @30m — how much further the market went after the trade closed. Powers the "Post-Exit" column. */
  postExitByTradeId?: Record<string, import('@/lib/atr').PostExitData>
}

export default function TradeList({
  trades,
  hoveredTradeId,
  onHoverEnter,
  onHoverLeave,
  selectedIds,
  onToggleSelect,
  nearDuplicateIds,
  onDelete,
  deletingId,
  onRowOpen,
  summaries = {},
  summariesLoading = false,
  liveAtrByTradeId,
  postExitByTradeId,
}: Props) {
  if (trades.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
        No trades yet. Use the intraday tagging flow or import a Sierra Chart log to populate this day.
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="font-semibold text-white mb-3 text-sm">Trades ({trades.length})</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="font-normal pb-2 pr-2 w-8" />
              <th className="text-left font-normal pb-2 pr-3">Time</th>
              <th className="text-left font-normal pb-2 pr-3">Dir</th>
              <th className="text-right font-normal pb-2 pr-3">Entry</th>
              <th className="text-right font-normal pb-2 pr-3">Stop</th>
              <th className="text-right font-normal pb-2 pr-3">TP1</th>
              <th className="text-right font-normal pb-2 pr-3">Qty</th>
              <th className="text-right font-normal pb-2 pr-3" title="Live ATR-10 (Wilder) on 1-min bars computed at the trade's entry_time. Reflects volatility at the actual moment of the trade, not the morning prep snapshot.">ATR@</th>
              <th className="text-right font-normal pb-2 pr-3">PnL</th>
              <th className="text-right font-normal pb-2 pr-3" title="R-multiple: realized PnL / planned risk in dollars. Includes the contract multiplier (so MNQ R is in true risk units).">R</th>
              <th className="text-right font-normal pb-2 pr-3" title="MFE Capture: realized PnL / peak favorable excursion in $. 100% = you took the high. Bolded when the trade was a give-back (MFE >= 1R favorable then closed at a loss).">Cap</th>
              <th className="text-right font-normal pb-2 pr-3" title="MAE Heat: peak adverse / planned stop distance, as %. 100% = MAE touched stop. Red bold on lucky-escape winners (heat > 100% but trade closed green) or on standout heat (>= 100%).">Heat</th>
              <th className="text-right font-normal pb-2 pr-3" title="Post-Exit Continuation @30m: how much further the market moved in your trade direction in the 30 minutes after your exit. Format: '+8 pts (18%)' = 8 pts of further favorable move, which is 18% of what you captured. Positive numbers mean you could have ridden it longer; em-dash means the move reversed against you after exit.">Post-Exit</th>
              <th className="text-left font-normal pb-2">Overview</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              const pnl = t.pnl ?? 0
              const isHovered = hoveredTradeId === t.id
              const isSelected = selectedIds.has(t.id)
              const isNearDup = nearDuplicateIds.has(t.id)
              const summary = summaries[t.id]
              return (
                <tr
                  key={t.id}
                  onMouseEnter={e => onHoverEnter(t.id, e)}
                  onMouseLeave={onHoverLeave}
                  onClick={() => onRowOpen?.(t.id)}
                  title="Open this trade's log in the intraday page"
                  className={`group border-b border-gray-800 transition-colors ${onRowOpen ? 'cursor-pointer' : 'cursor-default'} ${
                    isSelected
                      ? 'bg-blue-900/30'
                      : isHovered
                      ? 'bg-blue-950/30'
                      : isNearDup
                      ? 'bg-yellow-950/20 hover:bg-yellow-950/30'
                      : 'hover:bg-gray-800/50'
                  }`}
                >
                  <td className="py-1.5 pr-2 align-middle">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onToggleSelect(t.id) }}
                      className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : isNearDup
                          ? 'border-yellow-600 hover:border-yellow-400 bg-gray-900'
                          : 'border-gray-600 hover:border-gray-400 bg-gray-900'
                      }`}
                      title={isNearDup ? 'Possible duplicate — select to merge' : 'Select for merge'}
                    >
                      {isSelected ? <Check className="w-3 h-3" /> : null}
                    </button>
                  </td>
                  <td className="py-1.5 pr-3 text-gray-300">
                    {t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        t.direction === 'long'
                          ? 'bg-green-900/50 text-green-300'
                          : t.direction === 'short'
                          ? 'bg-red-900/50 text-red-300'
                          : 'bg-gray-800 text-gray-500'
                      }`}
                    >
                      {t.direction?.toUpperCase() ?? '--'}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-right text-gray-300">{t.entry_price ?? '--'}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-500">{t.stop_price ?? '--'}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-500">{t.tp1_price ?? '--'}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-300">{t.quantity ?? '--'}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-400" title={liveAtrByTradeId?.[t.id] != null ? `Live ATR-10 (1m Wilder) at this trade's entry_time` : 'Bars unavailable for live ATR — fallback to prep ATR not shown here'}>
                    {liveAtrByTradeId?.[t.id] != null ? liveAtrByTradeId[t.id].toFixed(2) : '—'}
                  </td>
                  <td
                    className={`py-1.5 pr-3 text-right font-bold ${
                      pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-500'
                    }`}
                  >
                    {pnl >= 0 ? '+' : ''}
                    {pnl.toFixed(2)}
                  </td>
                  {(() => {
                    const r = rMultiple(t)
                    return (
                      <td className={`py-1.5 pr-3 text-right ${
                        r == null ? 'text-gray-700'
                        : r >= 1 ? 'text-green-400'
                        : r >= 0 ? 'text-green-500'
                        : r >= -0.5 ? 'text-orange-400'
                        : 'text-red-400'
                      }`} title="R = pnl / (|entry-stop| * qty * multiplier).">
                        {r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}
                      </td>
                    )
                  })()}
                  {/* Cap and Loss render first, then Post-Exit Continuation. Post-Exit
                      asks "after I exited, how much further did the move keep going in my
                      direction?" — compared to what you captured, expressed as a % "extra
                      leg" you could have taken. */}
                  {/* Cap and Loss: same per-trade math as the intraday row chip.
                      Bold marks high-signal cross-cases that deserve attention
                      on review (give-back loser, lucky-escape winner). */}
                  {(() => {
                    const cap = captureRatio(t)
                    const heat = maeHeatRatio(t)
                    const isGiveBack = isGiveBackTrade(t)
                    const isLuckyEscape = (t.pnl ?? 0) > 0 && heat != null && heat > 1.0
                    // Gray default; standout cells (give-back, lucky escape, heat past stop)
                    // get red+bold so the eye lands on trades that need review.
                    const capStandout = isGiveBack
                    const heatStandout = isLuckyEscape || (heat != null && heat > 1.0)
                    const capCls = capStandout ? 'text-red-400 font-bold' : 'text-gray-400'
                    const heatCls = heatStandout ? 'text-red-400 font-bold' : 'text-gray-400'
                    return (
                      <>
                        <td className={`py-1.5 pr-3 text-right ${capCls}`}
                          title={isGiveBack ? 'Give-back: trade had MFE >= 1R favorable then closed at a loss.' : undefined}>
                          {captureDisplay(t) ?? '—'}
                        </td>
                        <td className={`py-1.5 pr-3 text-right ${heatCls}`}
                          title={isLuckyEscape ? 'Lucky escape: winning trade that violated planned stop.' : undefined}>
                          {heatDisplay(t) ?? '—'}
                        </td>
                      </>
                    )
                  })()}
                  {(() => {
                    const ext = postExitByTradeId?.[t.id]
                    if (!ext) return <td className="py-1.5 pr-3 text-right text-gray-700">—</td>
                    const isLong = t.direction === 'long'
                    const capturedPts = (t.entry_price != null && t.exit_price != null)
                      ? (isLong ? t.exit_price - t.entry_price : t.entry_price - t.exit_price)
                      : null
                    const cont = ext.continued_favorable_pts
                    const against = ext.continued_against_pts
                    // Color: green if continuation was significant relative to capture,
                    // yellow if mild, gray if essentially nothing; red signal lives in
                    // the reversal/against side when it dominated.
                    const fmt = (n: number) => `${n.toFixed(1)} pts`
                    let label: string
                    let cls: string
                    let title: string
                    if (cont > against) {
                      const pct = (capturedPts != null && capturedPts > 0)
                        ? Math.round((cont / capturedPts) * 100)
                        : null
                      label = `+${fmt(cont)}${pct != null ? ` (${pct}%)` : ''}`
                      cls = cont >= 3 ? 'text-green-400' : 'text-yellow-400'
                      title = `In the 30 min after exit, market continued +${cont.toFixed(2)} pts in your direction.${pct != null ? ` That's ${pct}% of what you captured.` : ''}${!ext.full_window ? ' (Partial window — bars ran out.)' : ''}`
                    } else if (against > 0.1) {
                      label = `−${fmt(against)}`
                      cls = 'text-red-400'
                      title = `Market reversed −${against.toFixed(2)} pts against your direction in the 30 min after exit.${!ext.full_window ? ' (Partial window.)' : ''}`
                    } else {
                      label = '—'
                      cls = 'text-gray-600'
                      title = 'Essentially flat in the 30 min after exit.'
                    }
                    return (
                      <td className={`py-1.5 pr-3 text-right ${cls}`} title={title}>
                        {label}
                      </td>
                    )
                  })()}
                  <td className="py-1.5 pr-2 max-w-md">
                    {summary ? (
                      <span className="text-gray-300 font-sans whitespace-normal leading-snug">{summary}</span>
                    ) : summariesLoading ? (
                      <span className="text-gray-600 inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> summarizing…
                      </span>
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pl-2 text-right">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onDelete(t.id) }}
                      disabled={deletingId === t.id}
                      className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30 disabled:cursor-wait"
                      title="Delete this trade"
                    >
                      {deletingId === t.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
