'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { TagImpact } from '@/lib/analytics'

interface Props {
  title: string
  description?: string
  data: TagImpact[]
  variant?: 'mistakes' | 'emotions'
  minCount?: number
}

/**
 * Side-by-side comparison: avg PnL on trades WITH a given tag vs WITHOUT it.
 * Sorted with biggest negative impact first (most damaging mistake / emotion).
 */
export default function TagImpactTable({
  title,
  description,
  data,
  variant = 'mistakes',
  minCount = 3,
}: Props) {
  const filtered = data.filter(d => d.withStats.count >= minCount)
  const [open, setOpen] = useState(false)
  const tone = variant === 'mistakes'
    ? 'bg-red-900/30 border-red-800 text-red-300'
    : 'bg-purple-900/30 border-purple-800 text-purple-300'

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 text-left">
        <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
        </div>
      </button>

      {open && (filtered.length === 0 ? (
        <p className="text-center text-xs text-gray-600 italic py-6">
          Not enough tagged trades yet (need ≥ {minCount} per tag).
        </p>
      ) : (
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-xs font-mono">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left font-normal py-2 pr-3">Tag</th>
                <th className="text-right font-normal py-2 pr-3" colSpan={3}>With Tag</th>
                <th className="text-right font-normal py-2 pr-3" colSpan={2}>Without Tag</th>
                <th className="text-right font-normal py-2">Δ Avg PnL</th>
              </tr>
              <tr className="text-[10px] text-gray-600 border-b border-gray-800">
                <th></th>
                <th className="text-right font-normal py-1 pr-3">N</th>
                <th className="text-right font-normal py-1 pr-3">Win %</th>
                <th className="text-right font-normal py-1 pr-3">Avg PnL</th>
                <th className="text-right font-normal py-1 pr-3">Win %</th>
                <th className="text-right font-normal py-1 pr-3">Avg PnL</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ label, withStats, withoutStats, delta_avg_pnl }) => (
                <tr key={label} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                  <td className="py-1.5 pr-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-[11px] border ${tone}`}>
                      {label}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-right text-gray-300">{withStats.count}</td>
                  <td className="py-1.5 pr-3 text-right text-gray-300">
                    {(withStats.win_rate * 100).toFixed(0)}%
                  </td>
                  <td className={`py-1.5 pr-3 text-right ${withStats.avg_pnl > 0 ? 'text-green-400' : withStats.avg_pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {withStats.avg_pnl >= 0 ? '+' : ''}{withStats.avg_pnl.toFixed(2)}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-gray-500">
                    {(withoutStats.win_rate * 100).toFixed(0)}%
                  </td>
                  <td className={`py-1.5 pr-3 text-right ${withoutStats.avg_pnl > 0 ? 'text-green-500' : withoutStats.avg_pnl < 0 ? 'text-red-500' : 'text-gray-600'}`}>
                    {withoutStats.avg_pnl >= 0 ? '+' : ''}{withoutStats.avg_pnl.toFixed(2)}
                  </td>
                  <td className={`py-1.5 text-right font-bold ${delta_avg_pnl > 0 ? 'text-green-400' : delta_avg_pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {delta_avg_pnl >= 0 ? '+' : ''}{delta_avg_pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  )
}
