'use client'

import { format } from 'date-fns'
import { Check, Trash2, Loader2 } from 'lucide-react'
import type { Trade } from '@/lib/supabase/types'

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
              <th className="text-left font-normal pb-2 pr-3">Setup</th>
              <th className="text-left font-normal pb-2 pr-3">Mistakes</th>
              <th className="text-right font-normal pb-2">PnL</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {trades.map(t => {
              const pnl = t.pnl ?? 0
              const isHovered = hoveredTradeId === t.id
              const isSelected = selectedIds.has(t.id)
              const isNearDup = nearDuplicateIds.has(t.id)
              const setups = t.tags_json?.setups ?? []
              const mistakes = t.tags_json?.mistakes ?? []
              return (
                <tr
                  key={t.id}
                  onMouseEnter={e => onHoverEnter(t.id, e)}
                  onMouseLeave={onHoverLeave}
                  className={`group border-b border-gray-800 transition-colors cursor-default ${
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
                  <td className="py-1.5 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {setups.length === 0 ? (
                        <span className="text-gray-600">—</span>
                      ) : (
                        setups.map(s => (
                          <span
                            key={s}
                            className="bg-blue-900/40 border border-blue-800 text-blue-200 px-1.5 py-0.5 rounded text-[10px]"
                          >
                            {s}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {mistakes.length === 0 ? (
                        <span className="text-gray-600">—</span>
                      ) : (
                        mistakes.map(s => (
                          <span
                            key={s}
                            className="bg-red-900/40 border border-red-800 text-red-200 px-1.5 py-0.5 rounded text-[10px]"
                          >
                            {s}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td
                    className={`py-1.5 text-right font-bold ${
                      pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-500'
                    }`}
                  >
                    {pnl >= 0 ? '+' : ''}
                    {pnl.toFixed(2)}
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
