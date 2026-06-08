'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { TrendingUp, TrendingDown, Minus, Trash2, Loader2, Check, ChevronUp, ChevronDown, HelpCircle, X } from 'lucide-react'

export interface DayRowData {
  id: string
  date: string
  eod_pnl: number | null
  /** Legacy single-tag column — kept for backward compat with code paths that
   *  haven't migrated yet (analytics filter, predict-day-type). */
  day_type: string | null
  /** Multi-select array. Render this in the UI; falls back to [day_type] for
   *  legacy days (filled server-side in dashboard/page.tsx). */
  day_types: string[]
  trade_count: number
  /** Wins among the day's trades (pnl > 0). Powers the per-trade win rate
   *  aggregate in DashboardStats. */
  trade_wins: number
  /** Trades that have a recorded pnl. Denominator for trade_wins. */
  trades_with_pnl_count: number
  setups: string[] // all setups used that day, sorted by frequency desc
  process_score: number | null
  overall_grade: number | null
  /** v1.3 Process verdict — null if the EOD AI hasn't run or this is a
   *  legacy pre-v1.3 row. Compliant or Breach drives the pill color. */
  process_verdict: 'Compliant' | 'Breach' | null
  /** v1.3 Process score on the same 0-10 scale as Execution — Math.round
   *  of (passCount / 7) * 10. The COLOR follows the verdict, not this
   *  number (per v1.3 amended 2026-06-08, 5–7/7 = Compliant). */
  process_v13_score: number | null
  /** Rule IDs that failed (P1..P7). Powers the hover tooltip on Breach days. */
  process_breach_rules: string[] | null
  win_rate: number | null
  avg_mfe_pts: number | null
  avg_mae_pts: number | null
  avg_mfe_dollars: number | null
  avg_mae_dollars: number | null
  /** Day-level MFE Capture %: realized PnL / peak favorable in $. Null when no trades had MFE data. */
  avg_capture: number | null
  /** Day-level MAE Loss ×R: peak adverse / planned risk in points (NOT realized dollar loss). Null when no stops were set. */
  avg_heat: number | null
  /** 1-min ATR-10 (Wilder) entered during prep — fallback when bars are missing for the live computation. */
  atr_1m: number | null
  /** Avg of per-trade LIVE ATR-10 (Wilder) computed at each trade's entry_time from 1-min bars. Preferred over atr_1m for the "in ATR" display when present. Null when no trades had bar data available. */
  avg_live_atr_1m: number | null
  /** How many of the day's trades fed avg_live_atr_1m. Powers a tooltip noting partial coverage. */
  live_atr_count: number
}

interface Props {
  initialDays: DayRowData[]
}

type SortColumn = 'date' | 'grade' | 'process_v13' | 'trades' | 'mfe_mae' | 'capture' | 'win_rate' | 'pnl'
type SortDirection = 'asc' | 'desc'
type MfeUnit = 'pts' | 'dollars' | 'atr'

export default function RecentDaysList({ initialDays }: Props) {
  const router = useRouter()
  const [days, setDays] = useState<DayRowData[]>(initialDays)
  const [deletingDate, setDeletingDate] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [mfeInfoOpen, setMfeInfoOpen] = useState(false)
  const [mfeUnit, setMfeUnit] = useState<MfeUnit>('pts')
  const mfeInfoRef = useRef<HTMLDivElement>(null)
  const [realizedInfoOpen, setRealizedInfoOpen] = useState(false)
  const realizedInfoRef = useRef<HTMLDivElement>(null)

  // Click-outside + Escape dismiss for the MFE/MAE info popover.
  useEffect(() => {
    if (!mfeInfoOpen) return
    const handleMouse = (e: MouseEvent) => {
      if (mfeInfoRef.current && !mfeInfoRef.current.contains(e.target as Node)) {
        setMfeInfoOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMfeInfoOpen(false)
    }
    document.addEventListener('mousedown', handleMouse)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouse)
      document.removeEventListener('keydown', handleKey)
    }
  }, [mfeInfoOpen])

  // Click-outside + Escape dismiss for the MFE Realized % / MAE Heat % popover.
  useEffect(() => {
    if (!realizedInfoOpen) return
    const handleMouse = (e: MouseEvent) => {
      if (realizedInfoRef.current && !realizedInfoRef.current.contains(e.target as Node)) {
        setRealizedInfoOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRealizedInfoOpen(false)
    }
    document.addEventListener('mousedown', handleMouse)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouse)
      document.removeEventListener('keydown', handleKey)
    }
  }, [realizedInfoOpen])

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const setSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(column)
      // Sensible defaults: dates default to descending (newest first);
      // numeric metrics default to descending (best/highest first).
      setSortDirection('desc')
    }
  }

  // Nulls always sort last regardless of direction — keep them visually at
  // the bottom of the list since they typically mean "data missing."
  const sortedDays = useMemo(() => {
    const get = (d: DayRowData): number | string | null => {
      switch (sortColumn) {
        case 'date': return d.date
        case 'grade': return d.overall_grade
        case 'process_v13': return d.process_v13_score
        case 'trades': return d.trade_count
        case 'mfe_mae': return d.avg_mfe_pts // unit-agnostic; ordering identical across pts/dollars
        case 'capture': return d.avg_capture
        case 'win_rate': return d.win_rate
        case 'pnl': return d.eod_pnl
      }
    }
    return [...days].sort((a, b) => {
      const va = get(a)
      const vb = get(b)
      const aNull = va === null || va === undefined
      const bNull = vb === null || vb === undefined
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      let cmp: number
      if (typeof va === 'string' && typeof vb === 'string') cmp = va < vb ? -1 : va > vb ? 1 : 0
      else cmp = (va as number) - (vb as number)
      return sortDirection === 'asc' ? cmp : -cmp
    })
  }, [days, sortColumn, sortDirection])

  const deleteOne = async (date: string): Promise<boolean> => {
    const res = await fetch(`/api/trading-days/${date}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: date }),
    })
    return res.ok
  }

  const handleSingleDelete = async (date: string, hasData: boolean) => {
    const msg = hasData
      ? `Delete ${date}? This permanently removes all trades, prep, screenshots, calibration, and EOD data for this day.`
      : `Delete ${date} from your journal? (No PnL recorded — likely just a prep entry.)`
    if (!confirm(msg)) return

    setDeletingDate(date)
    try {
      const ok = await deleteOne(date)
      if (!ok) {
        showToast(`Delete failed for ${date}`, 'error')
        return
      }
      setDays(prev => prev.filter(d => d.date !== date))
      showToast(`Deleted ${date}`, 'success')
      router.refresh()
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setDeletingDate(null)
    }
  }

  const handleBulkDelete = async () => {
    const selected = days.filter(d => selectedIds.has(d.id))
    if (selected.length === 0) return

    const proceed = confirm(
      `Delete ${selected.length} day${selected.length === 1 ? '' : 's'}?\n\n` +
        selected.map(d => `  • ${d.date}${d.eod_pnl != null ? ` (PnL ${d.eod_pnl >= 0 ? '+' : ''}$${d.eod_pnl})` : ''}`).join('\n') +
        `\n\nThis permanently removes all trades, prep, screenshots, calibration, and EOD data ` +
        `for each selected day. Cannot be undone.`,
    )
    if (!proceed) return

    setBulkDeleting(true)
    const succeeded: string[] = []
    const failed: string[] = []
    for (const d of selected) {
      try {
        const ok = await deleteOne(d.date)
        if (ok) succeeded.push(d.date)
        else failed.push(d.date)
      } catch {
        failed.push(d.date)
      }
    }
    setDays(prev => prev.filter(d => !succeeded.includes(d.date)))
    clearSelection()
    setBulkDeleting(false)

    if (failed.length === 0) {
      showToast(`Deleted ${succeeded.length} day${succeeded.length === 1 ? '' : 's'}`, 'success')
    } else if (succeeded.length === 0) {
      showToast(`All ${failed.length} deletes failed`, 'error')
    } else {
      showToast(`Deleted ${succeeded.length}, ${failed.length} failed`, 'error')
    }
    router.refresh()
  }

  if (days.length === 0) {
    return (
      <p className="text-gray-500 text-sm">No trading days yet. Start by completing your daily prep.</p>
    )
  }

  return (
    <>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="mb-3 bg-red-950/60 border border-red-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-red-200">
            {selectedIds.size} day{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkDeleting}
              className="text-xs text-red-300 hover:text-white disabled:opacity-50"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5"
            >
              {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              {bulkDeleting ? 'Deleting…' : 'Delete selected'}
            </button>
          </div>
        </div>
      )}

      {/* overflow-x stays auto in case a combo-day chip stretches the row past
          the container, but the scrollbar itself is hidden — content can still
          scroll via trackpad / shift-wheel if needed, but doesn't reserve a
          chunky bar at the bottom of the dashboard for no reason. */}
      <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800">
              <th className="font-normal py-2 pl-2 pr-1 w-8" />
              <SortableTh label="Date" column="date" current={sortColumn} direction={sortDirection} onSort={setSort} align="left" className="pr-3" />
              {/* Header reads "Execution" in full (was "Exec") per user
                  preference. The column now uses w-24 to fit the longer
                  label without truncating; previous w-20 worked for "Exec"
                  but truncated "Execution". Tooltip retained for the
                  numeric definition. */}
              <SortableTh label="Execution" column="grade" current={sortColumn} direction={sortDirection} onSort={setSort} align="center" className="pr-3 w-24" titleAttr="Execution composite score (0–10) — see /eod page for the per-metric breakdown." />
              {/* v1.3 Process verdict — single 0-10, banded green/red color
                  by verdict per 2026-06-08 amendment (5/7 threshold). The old
                  "Process" column (which actually showed the prep AI score)
                  was renamed to Prep and then dropped from this dense table. */}
              <SortableTh label="Process" column="process_v13" current={sortColumn} direction={sortDirection} onSort={setSort} align="center" className="pr-3 w-20" />
              <SortableTh label="Trades" column="trades" current={sortColumn} direction={sortDirection} onSort={setSort} align="center" className="pr-3 w-16" />
              <th className="font-normal py-2 pr-3 text-center w-28 relative">
                <div className="flex flex-col items-center gap-0.5">
                  {/* Help icon parked on its own row above the title so it
                      doesn't crowd the centered column heading. */}
                  <button
                    type="button"
                    onClick={() => setMfeInfoOpen(o => !o)}
                    className={`transition-colors ${mfeInfoOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                    title="What is MFE/MAE?"
                  >
                    <HelpCircle className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSort('mfe_mae')}
                    className={`inline-flex items-center gap-1 hover:text-white transition-colors ${
                      sortColumn === 'mfe_mae' ? 'text-blue-300' : 'text-gray-500'
                    }`}
                  >
                    Avg MFE/MAE
                    {sortColumn === 'mfe_mae' ? (
                      sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                    ) : (
                      <span className="w-3 h-3 opacity-30">▾</span>
                    )}
                  </button>
                  <select
                    value={mfeUnit}
                    onChange={e => setMfeUnit(e.target.value as MfeUnit)}
                    onClick={e => e.stopPropagation()}
                    className="bg-gray-800 border border-gray-700 text-gray-300 text-[10px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight"
                    title="Display unit for MFE/MAE"
                  >
                    <option value="pts">pts</option>
                    <option value="dollars">$</option>
                    <option value="atr">ATR</option>
                  </select>
                </div>
                {mfeInfoOpen && (
                  <div
                    ref={mfeInfoRef}
                    className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-white">Avg MFE / MAE</p>
                      <button
                        type="button"
                        onClick={() => setMfeInfoOpen(false)}
                        className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5"
                        aria-label="Close"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mb-2">
                      Average per-trade <strong className="text-green-300">M</strong>aximum <strong className="text-green-300">F</strong>avorable / <strong className="text-red-300">M</strong>aximum <strong className="text-red-300">A</strong>dverse <strong>E</strong>xcursion across the day&apos;s trades. Sourced tick-precise from Sierra Chart&apos;s <span className="font-mono">HighDuringPosition</span> / <span className="font-mono">LowDuringPosition</span> on closing fills.
                    </p>
                    <p className="mb-2">Per-trade calc, depending on direction:</p>
                    <ul className="list-disc pl-4 space-y-1 mb-2">
                      <li><strong>Long</strong>: MFE = high − entry, MAE = entry − low</li>
                      <li><strong>Short</strong>: MFE = entry − low, MAE = high − entry</li>
                    </ul>
                    <p className="mb-2">Unit options:</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li><strong>pts</strong>: raw price points</li>
                      <li><strong>$</strong>: points × per-symbol contract multiplier × trade quantity</li>
                      <li><strong>ATR</strong>: 1× ATR-10 (Wilder) units. Uses the day&apos;s prep ATR (market_context.atr_1m); shows — if not entered.</li>
                    </ul>
                    <p className="mt-2 text-gray-500">Click outside or press <kbd className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px]">Esc</kbd> to close.</p>
                  </div>
                )}
              </th>
              <th className="font-normal py-2 pr-3 text-center w-36 relative whitespace-nowrap">
                <div className="flex flex-col items-center gap-0.5">
                  {/* Help icon parked on its own row above the title — matches
                      the Avg MFE/MAE column's layout so the two help icons
                      sit at the same vertical level across the row. */}
                  <button
                    type="button"
                    onClick={() => setRealizedInfoOpen(o => !o)}
                    className={`transition-colors ${realizedInfoOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                    title="What are MFE Realized % and MAE Heat %?"
                  >
                    <HelpCircle className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSort('capture')}
                    className={`inline-flex flex-col items-center leading-tight hover:text-white transition-colors ${sortColumn === 'capture' ? 'text-blue-300' : 'text-gray-500'}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      MFE Realized %
                      {sortColumn === 'capture' && (sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                    </span>
                    <span>MAE Heat %</span>
                  </button>
                </div>
                {realizedInfoOpen && (
                  <div
                    ref={realizedInfoRef}
                    className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-white">MFE Realized % / MAE Heat %</p>
                      <button
                        type="button"
                        onClick={() => setRealizedInfoOpen(false)}
                        className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5"
                        aria-label="Close"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <p className="mb-2">
                      Two execution-quality metrics averaged across the day&apos;s trades. Both bounded by <strong>entry → exit</strong> — they measure what happened <em>while you held the position</em>, not after.
                    </p>

                    <p className="mb-1"><strong className="text-green-300">MFE Realized %</strong></p>
                    <p className="mb-2 text-gray-400">
                      = realized PnL ÷ peak favorable excursion in $ — &ldquo;of the move I was offered, how much did I take?&rdquo;
                    </p>
                    <ul className="list-disc pl-4 space-y-1 mb-3 text-gray-400">
                      <li><strong>100%</strong>: exited at the high — perfect timing</li>
                      <li><strong>50%</strong>: trade ran +2R, you took +1R — cut a runner</li>
                      <li><strong>0% or negative</strong>: <strong className="text-red-300">give-back</strong> — trade went green then closed at a loss</li>
                    </ul>

                    <p className="mb-1"><strong className="text-red-300">MAE Heat %</strong></p>
                    <p className="mb-2 text-gray-400">
                      = peak adverse excursion ÷ planned stop distance — &ldquo;how much of my planned risk did I sit through?&rdquo;
                    </p>
                    <ul className="list-disc pl-4 space-y-1 mb-3 text-gray-400">
                      <li><strong>0–50%</strong>: clean entry, light pressure</li>
                      <li><strong>50–100%</strong>: meaningful heat but stop respected</li>
                      <li><strong>&gt; 100%</strong>: <strong className="text-red-300">past stop</strong> — you moved it, slipped, or trade reversed in time to save you</li>
                    </ul>

                    <p className="mb-2 text-gray-500">
                      <strong>Color rule:</strong> gray by default; red bold only on standout days — when the day averaged a give-back (capture &lt; 0) or sat past planned stop (heat &gt; 100%). Other days stay gray on purpose so the eye lands on what needs review.
                    </p>

                    <p className="mb-1 text-gray-500">Trades excluded from the average:</p>
                    <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-500">
                      <li>No stop_price recorded (no risk baseline)</li>
                      <li>MFE &lt; 20% of planned risk (denominator too small — capture ratio is noise)</li>
                    </ul>

                    <p className="mt-2 text-gray-500">Click outside or press <kbd className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px]">Esc</kbd> to close.</p>
                  </div>
                )}
              </th>
              <SortableTh label="Win %" column="win_rate" current={sortColumn} direction={sortDirection} onSort={setSort} align="center" className="pr-3 w-16 whitespace-nowrap" />
              <SortableTh label="PnL" column="pnl" current={sortColumn} direction={sortDirection} onSort={setSort} align="right" className="pr-3 w-24 whitespace-nowrap" />
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {sortedDays.map(day => (
              <DayRowItem
                key={day.id}
                day={day}
                selected={selectedIds.has(day.id)}
                deleting={deletingDate === day.date || (bulkDeleting && selectedIds.has(day.id))}
                mfeUnit={mfeUnit}
                onToggleSelect={() => toggleSelect(day.id)}
                onDelete={() => handleSingleDelete(day.date, day.eod_pnl != null)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function SortableTh({
  label,
  column,
  current,
  direction,
  onSort,
  align,
  className,
  titleAttr,
}: {
  // Accepts either a plain string or pre-rendered JSX so columns can have
  // multi-line headers (e.g. "MFE Realized %" / "MAE Heat %" stacked).
  label: string | React.ReactNode
  column: SortColumn
  current: SortColumn
  direction: SortDirection
  onSort: (c: SortColumn) => void
  align: 'left' | 'center' | 'right'
  className?: string
  /** Hover tooltip — useful when the header label is abbreviated (e.g. "Exec"
   *  for Execution) and a first-time reader wants the full meaning. */
  titleAttr?: string
}) {
  const isActive = current === column
  const alignClass = align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center'
  return (
    <th className={`font-normal py-2 ${alignClass} ${className ?? ''}`} title={titleAttr}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 hover:text-white transition-colors ${isActive ? 'text-blue-300' : 'text-gray-500'}`}
      >
        {label}
        {isActive ? (
          direction === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <span className="w-3 h-3 opacity-30">▾</span>
        )}
      </button>
    </th>
  )
}

function DayRowItem({
  day,
  selected,
  deleting,
  mfeUnit,
  onToggleSelect,
  onDelete,
}: {
  day: DayRowData
  selected: boolean
  deleting: boolean
  mfeUnit: MfeUnit
  onToggleSelect: () => void
  onDelete: () => void
}) {
  const pnl = day.eod_pnl
  const pnlColor = pnl === null ? 'text-gray-500' : pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const Icon = pnl === null ? Minus : pnl > 0 ? TrendingUp : pnl < 0 ? TrendingDown : Minus

  const cellBg = selected ? 'bg-blue-950/40' : 'group-hover:bg-gray-800/40'
  // Wrapping each cell in a Link would inflate markup; instead use a single
  // overlay link via the row's last cell with an onClick stopPropagation guard
  // on the checkbox + delete button.
  const navigate = () => { window.location.href = `/eod/${day.date}` }

  return (
    <tr className={`group border-b border-gray-800/60 transition-colors ${selected ? 'bg-blue-950/40' : ''}`}>
      <td className={`py-2 pl-2 pr-1 ${cellBg}`}>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onToggleSelect() }}
          className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
            selected
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'border-gray-600 hover:border-gray-400 bg-gray-900'
          }`}
          title={selected ? 'Deselect' : 'Select for bulk action'}
        >
          {selected ? <Check className="w-3 h-3" /> : null}
        </button>
      </td>
      <td className={`py-2 pr-3 cursor-pointer ${cellBg}`} onClick={navigate}>
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 shrink-0 ${pnlColor}`} />
          {/* whitespace-nowrap keeps "Thu, Jun 4" inline — without it, a wide
              combo-tag chip pushes the date to wrap into "Thu," / "Jun 4". */}
          <Link href={`/eod/${day.date}`} className="text-white hover:text-blue-300 transition-colors font-medium whitespace-nowrap">
            {format(new Date(day.date + 'T12:00:00'), 'EEE, MMM d')}
          </Link>
          {/* Combo-day chip (Option C): join multiple day_types into a single
              comma-separated chip so a 2-tag day doesn't stretch the column or
              push to a second row. Full list also available on hover via the
              title attribute. */}
          {day.day_types.length > 0 && (
            <span
              // max-w + truncate keep long combo chips (e.g. "GBX Reversal,
              // Double Inside (PD + ON), Medium Mush Market (Indecisive)")
              // from pushing the Date column wide enough to clip PnL on the
              // right edge of the table. Full text still on hover.
              className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded-full whitespace-nowrap truncate max-w-[200px] inline-block"
              title={day.day_types.join(', ')}
            >
              {day.day_types.join(', ')}
            </span>
          )}
        </div>
      </td>
      <td className={`py-2 pr-3 text-center ${cellBg}`}><ScorePill value={day.overall_grade} /></td>
      <td className={`py-2 pr-3 text-center ${cellBg}`}>
        <VerdictPill
          value={day.process_v13_score}
          verdict={day.process_verdict}
          breachRules={day.process_breach_rules}
        />
      </td>
      <td className={`py-2 pr-3 text-center text-gray-300 font-mono ${cellBg}`}>
        {day.trade_count > 0 ? day.trade_count : <span className="text-gray-700">—</span>}
      </td>
      <td className={`py-2 pr-3 text-center font-mono text-xs ${cellBg}`}>
        <MfeMaeCell day={day} unit={mfeUnit} />
      </td>
      <td className={`py-2 pr-3 text-center font-mono text-xs ${cellBg}`}>
        <CaptureHeatCell day={day} />
      </td>
      {/* Win % and PnL rendered at text-xs (one size down from the table
          default text-sm) — keeps the columns readable but visually
          de-emphasizes vs the more central Grade/Process/MFE columns. */}
      <td className={`py-2 pr-3 text-center font-mono text-xs ${cellBg}`}>
        {day.win_rate === null
          ? <span className="text-gray-700">—</span>
          : <span className={day.win_rate >= 50 ? 'text-green-400' : 'text-gray-400'}>{day.win_rate.toFixed(0)}%</span>}
      </td>
      <td className={`py-2 pr-3 text-right font-mono font-medium text-xs ${pnlColor} ${cellBg}`}>
        {/* Whole-dollar PnL — the narrow Recent Days column was clipping
            ".50" off "$368.50" and showing a dangling "$368." period. The
            day-level summary doesn't need cent precision; per-trade rows
            still keep decimals where they matter. */}
        {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}$${Math.round(pnl).toLocaleString()}`}
      </td>
      <td className={`py-2 pr-2 text-right ${cellBg}`}>
        <button
          onClick={onDelete}
          disabled={deleting}
          className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-30 disabled:cursor-wait"
          title={`Delete ${day.date}`}
        >
          {deleting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </td>
    </tr>
  )
}

function MfeMaeCell({ day, unit }: { day: DayRowData; unit: MfeUnit }) {
  // ATR unit divides the points-based MFE/MAE by the day's prep ATR-10 to
  // express the excursion in "how many ATRs of typical 1m range." Falls back
  // to em-dash when the day's market_context.atr_1m wasn't filled in.
  if (unit === 'atr') {
    // Prefer live ATR (avg of per-trade ATR computed from 1-min bars at each
    // trade's entry_time) over the prep snapshot when available. Bar coverage
    // exists for SCID-imported days, ~since the start of the import; older
    // days fall back to prep_atr_1m so they don't silently render as em-dash.
    const atrRef = day.avg_live_atr_1m ?? day.atr_1m
    const isLive = day.avg_live_atr_1m != null
    if (day.avg_mfe_pts == null || day.avg_mae_pts == null || !atrRef) {
      return <span className="text-gray-700">—</span>
    }
    const fmt = (v: number) => `${v.toFixed(2)}×`
    const title = isLive
      ? `Per-trade live ATR-10 averaged across ${day.live_atr_count} trade${day.live_atr_count === 1 ? '' : 's'} on this day (${atrRef.toFixed(2)} pts).`
      : `Prep-time ATR-10 (${atrRef.toFixed(2)} pts) — live computation unavailable because bars are missing for this day.`
    return (
      <span title={title}>
        <span className="text-green-400">+{fmt(day.avg_mfe_pts / atrRef)}</span>
        <span className="text-gray-600"> / </span>
        <span className="text-red-400">-{fmt(day.avg_mae_pts / atrRef)}</span>
        {!isLive && <span className="text-gray-600 text-[9px] ml-1">prep</span>}
      </span>
    )
  }
  const mfe = unit === 'dollars' ? day.avg_mfe_dollars : day.avg_mfe_pts
  const mae = unit === 'dollars' ? day.avg_mae_dollars : day.avg_mae_pts
  if (mfe == null || mae == null) {
    return <span className="text-gray-700">—</span>
  }
  // Display: MFE in green (favorable), MAE as a negative magnitude in red.
  // Dollars get whole-number rounding; points get one decimal for tick-level
  // precision.
  const fmt = (v: number) => unit === 'dollars'
    ? `$${Math.round(v).toLocaleString()}`
    : v.toFixed(1)
  return (
    <span>
      <span className="text-green-400">+{fmt(mfe)}</span>
      <span className="text-gray-600"> / </span>
      <span className="text-red-400">-{fmt(mae)}</span>
    </span>
  )
}

/**
 * Capture % / Heat % per day. Gray-by-default; only standout values
 * (give-back day average, or sat-past-stop day average) get a color so the
 * eye lands on days that need review.
 *
 * Both shown as percentages for uniformity:
 *   Capture %  = realized PnL ÷ peak favorable in $ during the position
 *   Heat %     = peak MAE ÷ planned stop distance in pts (100% = touched stop)
 */
function CaptureHeatCell({ day }: { day: DayRowData }) {
  if (day.avg_capture == null && day.avg_heat == null) {
    return <span className="text-gray-700">—</span>
  }
  // Standout rules for the day-level aggregate:
  //   capture < 0   → day averaged give-back trades (red, bold)
  //   heat   > 100% → day averaged past planned stop (red, bold)
  const capStandout = day.avg_capture != null && day.avg_capture < 0
  const heatStandout = day.avg_heat != null && day.avg_heat > 1.0
  const capCls = capStandout ? 'text-red-400 font-bold' : 'text-gray-400'
  const heatCls = heatStandout ? 'text-red-400 font-bold' : 'text-gray-400'
  return (
    <span
      className="flex flex-col items-center leading-tight whitespace-nowrap"
      title="MFE Realized % = avg realized PnL ÷ peak favorable $ per trade (during position, not after exit). MAE Heat % = avg peak MAE ÷ planned stop distance per trade (100% = touched stop level; > 100% = blew past it). Red bold means the day averaged a give-back (capture < 0) or sat past planned stop (heat > 100%)."
    >
      <span className={capCls}>{day.avg_capture == null ? '—' : `${(day.avg_capture * 100).toFixed(0)}%`}</span>
      <span className={heatCls}>{day.avg_heat == null ? '—' : `${(day.avg_heat * 100).toFixed(0)}%`}</span>
    </span>
  )
}

function ScorePill({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-gray-700 font-mono">—</span>
  }
  // 1-10 scale per the AI analyze prompts (analyze-eod, analyze-prep routes).
  const color =
    value >= 9 ? 'text-green-400 border-green-800/50 bg-green-950/40'
    : value >= 7 ? 'text-blue-300 border-blue-800/50 bg-blue-950/40'
    : value >= 5 ? 'text-yellow-300 border-yellow-800/50 bg-yellow-950/40'
    : 'text-red-300 border-red-800/50 bg-red-950/40'
  return (
    <span className={`font-mono border rounded px-1.5 py-0.5 inline-block w-8 text-center text-xs ${color}`}>
      {value}
    </span>
  )
}

/**
 * v1.4 Process pill — same 0-10 visual footprint as ScorePill so columns
 * line up. The COLOR BAND is driven by the verdict (green=Compliant when
 * ≥4/5 rules pass per 2026-06-08 amendment 3, red=Breach when ≤3/5); the
 * SHADE within each band is driven by the score so 5/5 reads deeper green
 * than a 4/5 scrape-through, and 0/5 total failure reads darker than a 3/5
 * just-under breach. With 5 rules the score values are {0, 2, 4, 6, 8, 10}.
 */
function VerdictPill({
  value, verdict, breachRules,
}: {
  value: number | null
  verdict: 'Compliant' | 'Breach' | null
  breachRules: string[] | null
}) {
  if (value === null || verdict === null) {
    return <span className="text-gray-700 font-mono">—</span>
  }
  const isCompliant = verdict === 'Compliant'
  const color = isCompliant
    ? (value >= 10 ? 'text-green-300 border-green-700/60 bg-green-900/50'      // 5/5 — deep green
      :              'text-emerald-300 border-emerald-700/40 bg-emerald-900/25') // 4/5 — at threshold, cooler
    : (value >= 6  ? 'text-orange-300 border-orange-700/50 bg-orange-900/30'  // 3/5 — just-under breach
      : value >= 4  ? 'text-red-300 border-red-800/50 bg-red-950/40'           // 2/5
      : value >= 2  ? 'text-red-200 border-red-700/60 bg-red-900/50'           // 1/5
      :              'text-red-100 border-red-600/70 bg-red-900/70')           // 0/5 — total failure
  const tooltip = isCompliant
    ? `Compliant — ${value}/10 (≥4/5 rules pass)`
    : `Breach — ${(breachRules ?? []).join(', ') || 'rule(s) failed'}`
  return (
    <span
      className={`font-mono border rounded px-1.5 py-0.5 inline-block w-8 text-center text-xs ${color}`}
      title={tooltip}
    >
      {value}
    </span>
  )
}
