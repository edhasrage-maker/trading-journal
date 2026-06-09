'use client'

import { useState, useMemo } from 'react'
import { ArrowUpDown, ArrowUp, ArrowDown, ChevronDown } from 'lucide-react'
import type { TagPerf } from '@/lib/analytics'

interface Props {
  title: string
  description?: string
  data: TagPerf[]
  /** When true, use mistakes/emotions style coloring (red/purple). Otherwise default gray + green/red on PnL */
  variant?: 'default' | 'mistakes' | 'emotions'
  /** Hide rows with fewer than this many trades */
  minCount?: number
  emptyMessage?: string
  /** Click handler for the tag label. When provided, the label becomes a
   *  button that opens the drilldown modal (TradeListModal). Pages that
   *  don't need drilldown can omit this — the row stays static. */
  onTagClick?: (label: string) => void
}

type SortKey = 'label' | 'count' | 'win_rate' | 'avg_pnl' | 'profit_factor' | 'avg_r' | 'avg_capture' | 'avg_heat' | 'total_pnl'

export default function TagPerformanceTable({
  title,
  description,
  data,
  variant = 'default',
  minCount = 1,
  emptyMessage = 'No tagged trades in this category yet.',
  onTagClick,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('total_pnl')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => data.filter(d => d.stats.count >= minCount), [data, minCount])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0
      switch (sortKey) {
        case 'label':       av = a.label.toLowerCase();         bv = b.label.toLowerCase(); break
        case 'count':       av = a.stats.count;                 bv = b.stats.count; break
        case 'win_rate':    av = a.stats.win_rate;              bv = b.stats.win_rate; break
        case 'avg_pnl':     av = a.stats.avg_pnl;               bv = b.stats.avg_pnl; break
        case 'profit_factor': {
          // Sort Infinity (no losers, all wins) above any finite PF.
          av = a.stats.profit_factor === Infinity ? Number.MAX_VALUE : a.stats.profit_factor
          bv = b.stats.profit_factor === Infinity ? Number.MAX_VALUE : b.stats.profit_factor
          break
        }
        case 'avg_r':       av = a.stats.avg_r ?? -Infinity;    bv = b.stats.avg_r ?? -Infinity; break
        case 'avg_capture': av = a.stats.avg_capture ?? -Infinity; bv = b.stats.avg_capture ?? -Infinity; break
        case 'avg_heat':    av = a.stats.avg_heat ?? Infinity;     bv = b.stats.avg_heat ?? Infinity; break
        case 'total_pnl':   av = a.stats.total_pnl;             bv = b.stats.total_pnl; break
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    return arr
  }, [filtered, sortKey, sortDir])

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(k)
      setSortDir(k === 'label' ? 'asc' : 'desc')
    }
  }

  const HEADERS: { k: SortKey; label: string; align: 'left' | 'right' }[] = [
    { k: 'label', label: 'Tag', align: 'left' },
    { k: 'count', label: 'Trades', align: 'right' },
    { k: 'win_rate', label: 'Win %', align: 'right' },
    { k: 'avg_pnl', label: 'Avg PnL', align: 'right' },
    { k: 'profit_factor', label: 'Profit Factor', align: 'right' },
    { k: 'avg_r', label: 'Avg Win/Loss R', align: 'right' },
    { k: 'avg_capture', label: 'MFE %', align: 'right' },
    { k: 'avg_heat', label: 'MAE %', align: 'right' },
    { k: 'total_pnl', label: 'Total PnL', align: 'right' },
  ]

  const labelTone = variant === 'mistakes'
    ? 'bg-red-900/30 border-red-800 text-red-300'
    : variant === 'emotions'
      ? 'bg-purple-900/30 border-purple-800 text-purple-300'
      : 'bg-gray-800 border-gray-700 text-gray-200'

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 text-left">
        <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
        </div>
      </button>

      {open && (sorted.length === 0 ? (
        <p className="text-center text-xs text-gray-600 italic py-6">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-xs font-mono">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                {HEADERS.map(h => {
                  const Icon = sortKey !== h.k ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown
                  return (
                    <th
                      key={h.k}
                      className={`${h.align === 'left' ? 'text-left' : 'text-right'} font-normal py-2 pr-3 cursor-pointer select-none hover:text-gray-200 transition-colors`}
                      onClick={() => toggleSort(h.k)}
                    >
                      <span className={`inline-flex items-center gap-1 ${h.align === 'right' ? 'flex-row-reverse' : ''}`}>
                        <Icon className="w-2.5 h-2.5" />
                        {h.label}
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ label, stats }) => (
                <tr key={label} className="border-b border-gray-800/50 hover:bg-gray-800/40 transition-colors">
                  <td className="py-1.5 pr-3">
                    {onTagClick ? (
                      // Clickable label opens the drilldown modal — shows every
                      // trade in this aggregate. Hover ring highlights the
                      // affordance; cursor flips to pointer.
                      <button
                        type="button"
                        onClick={() => onTagClick(label)}
                        className={`inline-block px-2 py-0.5 rounded text-[11px] border ${labelTone} hover:ring-1 hover:ring-blue-500 cursor-pointer transition-shadow`}
                        title={`Show all ${stats.count} trade${stats.count === 1 ? '' : 's'} with this tag`}
                      >
                        {label}
                      </button>
                    ) : (
                      <span className={`inline-block px-2 py-0.5 rounded text-[11px] border ${labelTone}`}>
                        {label}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-gray-300">{stats.count}</td>
                  <td className={`py-1.5 pr-3 text-right ${stats.win_rate >= 0.5 ? 'text-green-400' : 'text-gray-300'}`}>
                    {(stats.win_rate * 100).toFixed(0)}%
                  </td>
                  <td className={`py-1.5 pr-3 text-right ${stats.avg_pnl > 0 ? 'text-green-400' : stats.avg_pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {stats.avg_pnl >= 0 ? '+' : ''}{stats.avg_pnl.toFixed(2)}
                  </td>
                  {/* Profit Factor — sum_winners / |sum_losers|. > 1 = green
                      (gross winners outweighed gross losers). < 1 = red.
                      Infinity (no losers) renders as "∞" and gets the deepest
                      green tone. */}
                  <td
                    className={`py-1.5 pr-3 text-right ${
                      stats.profit_factor === Infinity ? 'text-green-300 font-bold'
                      : stats.profit_factor > 1 ? 'text-green-400'
                      : stats.profit_factor < 1 ? 'text-red-400'
                      : 'text-gray-500'
                    }`}
                    title="Gross winning dollars ÷ gross losing dollars. >1 means dollars-won exceeded dollars-lost in this group. ∞ means the group had no losing trades."
                  >
                    {stats.profit_factor === Infinity ? '∞' : stats.profit_factor.toFixed(2)}
                  </td>
                  {/* Avg Win/Loss R — split display showing the average winner-R
                      and average loser-R side by side, matching the visual of
                      the "$294 / -$130" win/loss card. Reads as "winners
                      typically book +X.XR, losers typically take -Y.YR." */}
                  <td
                    className="py-1.5 pr-3 text-right text-gray-400 whitespace-nowrap"
                    title="Average R-multiple across winners (+) and losers (−). Looking for high winner-R relative to loser-R; the ratio between them is the R-multiple version of profit factor."
                  >
                    {stats.avg_winner_r == null && stats.avg_loser_r == null ? (
                      <span className="text-gray-700">—</span>
                    ) : (
                      <>
                        <span className="text-green-400">
                          {stats.avg_winner_r == null ? '—' : `+${stats.avg_winner_r.toFixed(2)}R`}
                        </span>
                        <span className="text-gray-600 mx-1">/</span>
                        <span className="text-red-400">
                          {stats.avg_loser_r == null ? '—' : `${stats.avg_loser_r.toFixed(2)}R`}
                        </span>
                      </>
                    )}
                  </td>
                  <td
                    className={`py-1.5 pr-3 text-right ${
                      stats.avg_capture == null ? 'text-gray-700'
                      : stats.avg_capture < 0 ? 'text-red-400 font-bold'
                      : 'text-gray-400'
                    }`}
                    title={stats.avg_capture == null ? 'No native trades with MFE data in this group' : `Avg of (realized PnL / peak favorable in $) across ${stats.capture_count} of ${stats.count} trades. Red bold means trades in this group averaged a give-back (negative capture).`}
                  >
                    {stats.avg_capture == null ? '—' : `${(stats.avg_capture * 100).toFixed(0)}%`}
                  </td>
                  <td
                    className={`py-1.5 pr-3 text-right ${
                      stats.avg_heat == null ? 'text-gray-700'
                      : stats.avg_heat > 1.0 ? 'text-red-400 font-bold'
                      : 'text-gray-400'
                    }`}
                    title={stats.avg_heat == null ? 'No native trades with stop + MAE data in this group' : `Avg of (peak adverse / planned stop) across ${stats.heat_count} of ${stats.count} trades, as %. 100% = touched stop level. Red bold means trades in this group averaged past their planned stop.`}
                  >
                    {stats.avg_heat == null ? '—' : `${Math.round(stats.avg_heat * 100)}%`}
                  </td>
                  <td className={`py-1.5 text-right font-bold ${stats.total_pnl > 0 ? 'text-green-400' : stats.total_pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {stats.total_pnl >= 0 ? '+' : ''}${stats.total_pnl.toFixed(0)}
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
