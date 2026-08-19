'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { TrendingUp, TrendingDown, Minus, Trash2, Loader2, Check, ChevronUp, ChevronDown } from 'lucide-react'
import type { TapeScoreResult } from '@/lib/tapescore'
import AchievementCoin from '@/components/AchievementCoin'
import { ACHIEVEMENT_CATALOG, type AchievementId } from '@/lib/achievements'
import { formatCaptureCell } from '@/lib/analytics'

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
  /** Earned achievement coin ids for the day (persisted
   *  trading_days.achievements_json; empty pre-migration/backfill). Rendered
   *  as small coins next to the date — the successor to the old day-type chip. */
  achievements: string[]
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
  /** One TapeScore (Ruleset amendment 5) — the single 0-100 headline derived
   *  server-side from rules + execution + prep. Null = day never analyzed. */
  tapescore: TapeScoreResult | null
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
  /** Per-trade average-of-ratios ×ATR (mean of each trade's excursion / its own
   *  entry_atr_1m), matching the EOD recap's AvgMfeMaeCard exactly. Preferred
   *  for the ×ATR display; null on legacy days with no live entry ATR, where
   *  the cell falls back to the ratio-of-averages on avg_live_atr_1m ?? atr_1m. */
  avg_mfe_atr?: number | null
  avg_mae_atr?: number | null
}

interface Props {
  initialDays: DayRowData[]
  /** 'pro' (default) = Detailed Tape: full column set + selection/delete/drag.
   *  'beginner' = Highlights: a lean read-only set (Tape / Trades / Win % /
   *  P&L), no selection, no delete, fixed order. Same table, one product. */
  mode?: 'beginner' | 'pro'
}

type SortColumn = 'date' | 'tapescore' | 'trades' | 'win_rate' | 'pnl'
type SortDirection = 'asc' | 'desc'

/** Columns the user can drag-reorder (Detailed only). Date is pinned left (row
 *  identifier), the checkbox cell is pinned left (selection), the delete cell
 *  is pinned right (row action) — those never move.
 *
 *  Pt 13 rework (2026-07-12): Day type leaves the dashboard entirely (analytics
 *  is its home). Win % joins both modes; Detailed additionally shows the MFE
 *  factors at a glance — MFE:MAE ratio and capture % — the read people found
 *  most interesting, so it's no longer a click deep. */
type ReorderableColumnId = 'tapescore' | 'trades' | 'win_rate' | 'mfe_mae' | 'capture' | 'pnl'
const DEFAULT_COLUMN_ORDER: ReorderableColumnId[] = ['tapescore', 'pnl', 'trades', 'win_rate', 'mfe_mae', 'capture']
/** Highlights: lean, fixed, non-reorderable. */
const BEGINNER_COLUMN_ORDER: ReorderableColumnId[] = ['tapescore', 'pnl', 'trades', 'win_rate']
// v3: v2 carried the now-removed `day_type` id; bump so stale saved orders reset.
// v4: the default order changed (P&L moved up beside TapeScore). The key is
// versioned because the held order is persisted — without a bump, anyone who
// has ever used this table keeps the old arrangement and never sees the change.
const COLUMN_ORDER_STORAGE_KEY = 'dashboard-recent-days-column-order-v4'

/** Date earns a wider column than the numbers — it carries a weekday, a month
 *  and a date, plus any achievement coins — but only just: a quarter more. */
const DATE_COL_RATIO = 1.25
/** Selection checkbox and delete columns (Detailed only), as a share of the
 *  table. Both hold a single small control. */
const PINNED_COL_PCT = 3.5

/** MFE:MAE ratio for the cell — "2.4:1", "∞" when a day never went adverse,
 *  "—" when either leg is missing. */
function mfeMaeRatio(mfe: number | null, mae: number | null): string {
  if (mfe == null || mae == null) return '—'
  if (mae <= 0) return mfe > 0 ? '∞' : '—'
  return `${(mfe / mae).toFixed(1)}:1`
}

export default function RecentDaysList({ initialDays, mode = 'pro' }: Props) {
  const isPro = mode === 'pro'
  const router = useRouter()
  const [days, setDays] = useState<DayRowData[]>(initialDays)
  const [deletingDate, setDeletingDate] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>('date')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  // Drag-reorder state for the data columns. Restored from localStorage on
  // mount; persisted on every change. Invalid stored values fall back to the
  // canonical default order.
  const [columnOrder, setColumnOrder] = useState<ReorderableColumnId[]>(DEFAULT_COLUMN_ORDER)
  const [dragColId, setDragColId] = useState<ReorderableColumnId | null>(null)
  const [dragOverColId, setDragOverColId] = useState<ReorderableColumnId | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      const filtered = parsed.filter((x): x is ReorderableColumnId =>
        typeof x === 'string' && (DEFAULT_COLUMN_ORDER as string[]).includes(x))
      // Append any missing columns (e.g. a future column gets added without
      // wiping the user's saved order) at their canonical position.
      const next: ReorderableColumnId[] = [...filtered]
      for (const id of DEFAULT_COLUMN_ORDER) if (!next.includes(id)) next.push(id)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from localStorage
      setColumnOrder(next)
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder)) } catch { /* ignore */ }
  }, [columnOrder])

  const onColDragStart = (e: React.DragEvent<HTMLTableCellElement>, id: ReorderableColumnId) => {
    setDragColId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  const onColDragOver = (e: React.DragEvent<HTMLTableCellElement>, id: ReorderableColumnId) => {
    if (!dragColId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverColId !== id) setDragOverColId(id)
  }
  const onColDrop = (e: React.DragEvent<HTMLTableCellElement>, dropOnId: ReorderableColumnId) => {
    e.preventDefault()
    if (!dragColId || dragColId === dropOnId) {
      setDragColId(null); setDragOverColId(null); return
    }
    setColumnOrder(prev => {
      const next = prev.filter(c => c !== dragColId)
      const idx = next.indexOf(dropOnId)
      next.splice(idx === -1 ? next.length : idx, 0, dragColId)
      return next
    })
    setDragColId(null); setDragOverColId(null)
  }
  const onColDragEnd = () => { setDragColId(null); setDragOverColId(null) }

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
        case 'tapescore': return d.tapescore?.score ?? null
        case 'trades': return d.trade_count
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

  // Drag-handle props applied to each reorderable header <th>. The header
  // gets draggable=true, drag start/over/drop/end handlers, an opacity tweak
  // while it's the source, and a left/right border highlight when it's the
  // current drop target (column slides into the slot where the target
  // currently sits).
  const dragProps = (id: ReorderableColumnId): React.ThHTMLAttributes<HTMLTableCellElement> => {
    // Highlights columns are fixed — no drag affordance.
    if (!isPro) return {}
    const isDragging = dragColId === id
    const isHover = dragOverColId === id && dragColId !== null && dragColId !== id
    return {
      draggable: true,
      onDragStart: e => onColDragStart(e, id),
      onDragOver: e => onColDragOver(e, id),
      onDrop: e => onColDrop(e, id),
      onDragEnd: onColDragEnd,
      className: [
        'cursor-grab active:cursor-grabbing select-none',
        isDragging ? 'opacity-40' : '',
        isHover ? 'ring-2 ring-blue-500 rounded' : '',
      ].filter(Boolean).join(' '),
      title: 'Drag to reorder',
    }
  }

  // Header node per reorderable column id, with the draggable / drop-hint
  // props spread onto each <th>.
  const headerNodes: Record<ReorderableColumnId, React.ReactNode> = {
    tapescore: (
      <SortableTh
        key="tapescore"
        label="TapeScore"
        column="tapescore"
        current={sortColumn}
        direction={sortDirection}
        onSort={setSort}
        align="center"
        className="pr-3"
        titleAttr="One 0-100 score per day — rules kept, execution quality, and prep blended. Hover a score for its components."
        thProps={dragProps('tapescore')}
      />
    ),
    trades: (
      <SortableTh
        key="trades"
        label="Trades"
        column="trades"
        current={sortColumn}
        direction={sortDirection}
        onSort={setSort}
        align="center"
        className="pr-3"
        thProps={dragProps('trades')}
      />
    ),
    win_rate: (
      <SortableTh
        key="win_rate"
        label="Win %"
        column="win_rate"
        current={sortColumn}
        direction={sortDirection}
        onSort={setSort}
        align="center"
        className="pr-3"
        titleAttr="Share of the day's trades that closed green."
        thProps={dragProps('win_rate')}
      />
    ),
    mfe_mae: (
      <th
        key="mfe_mae"
        {...dragProps('mfe_mae')}
        className={`font-normal py-2 pr-3 text-center ${dragProps('mfe_mae').className ?? ''}`}
        title="Average favorable excursion vs. average adverse excursion — how much room the trades gave you relative to the heat you took."
      >
        <span className="text-gray-500">MFE:MAE</span>
      </th>
    ),
    capture: (
      <th
        key="capture"
        {...dragProps('capture')}
        className={`font-normal py-2 pr-3 text-center ${dragProps('capture').className ?? ''}`}
        title="Of the best point the trades reached in your favor, how much you kept at exit, on average."
      >
        <span className="text-gray-500">Profit Captured</span>
      </th>
    ),
    pnl: (
      <SortableTh
        key="pnl"
        label="PnL"
        column="pnl"
        current={sortColumn}
        direction={sortDirection}
        onSort={setSort}
        align="center"
        className="pr-3 whitespace-nowrap"
        thProps={dragProps('pnl')}
      />
    ),
  }
  const effectiveOrder = isPro ? columnOrder : BEGINNER_COLUMN_ORDER
  // One share per data column, Date 1.25 shares. The two pinned columns
  // (selection, delete) exist only in Detailed and are taken off the top.
  const columnUnitPct =
    (100 - (isPro ? PINNED_COL_PCT * 2 : 0)) / (effectiveOrder.length + DATE_COL_RATIO)

  return (
    <>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? 'âœ“' : 'âœ•'} {toast.msg}
        </div>
      )}

      {isPro && selectedIds.size > 0 && (
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
        {/* Every data column gets the same slice and Date takes a quarter
            more, so the row reads as an even rhythm instead of one wide date
            column and a huddle of numbers. Percentages (not fixed widths) keep
            it right at any window size, and the count adapts to the mode —
            Highlights shows four data columns, Detailed six. */}
        <table className="w-full text-sm table-fixed">
          <colgroup>
            {isPro && <col style={{ width: `${PINNED_COL_PCT}%` }} />}
            <col style={{ width: `${columnUnitPct * DATE_COL_RATIO}%` }} />
            {effectiveOrder.map(id => <col key={id} style={{ width: `${columnUnitPct}%` }} />)}
            {isPro && <col style={{ width: `${PINNED_COL_PCT}%` }} />}
          </colgroup>
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800">
              {/* Selection checkbox column — Detailed only. */}
              {isPro && <th className="font-normal py-2 pl-2 pr-1 w-8" />}
              {/* Every data column is a fixed width; Date was the only one
                  without, so auto table layout handed it all the leftover space
                  and left a gulf between the date and the first number. Give it
                  a width of its own and the slack spreads across the row. */}
              <SortableTh label="Date" column="date" current={sortColumn} direction={sortDirection} onSort={setSort} align="left" className="pr-3 whitespace-nowrap" />
              {/* Data columns. In Detailed these are draggable (held order lives
                  in columnOrder state, persisted to localStorage); Highlights
                  uses a fixed lean set. Date stays pinned (row identity); the
                  delete column (Detailed only) stays pinned right. */}
              {effectiveOrder.map(id => headerNodes[id])}
              {isPro && <th className="w-10" />}
            </tr>
          </thead>
          <tbody>
            {sortedDays.map(day => (
              <DayRowItem
                key={day.id}
                day={day}
                mode={mode}
                selected={selectedIds.has(day.id)}
                deleting={deletingDate === day.date || (bulkDeleting && selectedIds.has(day.id))}
                columnOrder={effectiveOrder}
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
  thProps,
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
  /** Extra props spread onto the <th> — used by RecentDaysList to attach
   *  drag/drop handlers without forking the component. */
  thProps?: React.ThHTMLAttributes<HTMLTableCellElement>
}) {
  const isActive = current === column
  const alignClass = align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center'
  return (
    <th
      {...thProps}
      className={`font-normal py-2 ${alignClass} ${className ?? ''} ${thProps?.className ?? ''}`}
      title={titleAttr}
    >
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
  mode,
  selected,
  deleting,
  columnOrder,
  onToggleSelect,
  onDelete,
}: {
  day: DayRowData
  /** 'beginner' hides the selection + delete cells (read-only Highlights). */
  mode: 'beginner' | 'pro'
  selected: boolean
  deleting: boolean
  /** Order of the reorderable data columns. Must match what the parent's
   *  <thead> iterates so headers and cells stay in lockstep. */
  columnOrder: ReorderableColumnId[]
  onToggleSelect: () => void
  onDelete: () => void
}) {
  const isPro = mode === 'pro'
  const pnl = day.eod_pnl
  const pnlColor = pnl === null ? 'text-gray-500' : pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const Icon = pnl === null ? Minus : pnl > 0 ? TrendingUp : pnl < 0 ? TrendingDown : Minus

  const cellBg = selected ? 'bg-blue-950/40' : 'group-hover:bg-gray-800/40'
  // Wrapping each cell in a Link would inflate markup; instead use a single
  // overlay link via the row's last cell with an onClick stopPropagation guard
  // on the checkbox + delete button.
  const navigate = () => { window.location.href = `/review/today/${day.date}` }

  return (
    <tr className={`group border-b border-gray-800/60 transition-colors ${selected ? 'bg-blue-950/40' : ''}`}>
      {isPro && (
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
      )}
      <td className={`py-2 pr-3 cursor-pointer ${cellBg}`} onClick={navigate}>
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 shrink-0 ${pnlColor}`} />
          {/* whitespace-nowrap keeps "Thu, Jun 4" inline — without it, a wide
              combo-tag chip pushes the date to wrap into "Thu," / "Jun 4". */}
          <Link href={`/review/today/${day.date}`} className="text-white hover:text-blue-300 transition-colors font-medium whitespace-nowrap">
            {format(new Date(day.date + 'T12:00:00'), 'EEE, MMM d')}
          </Link>
          {/* Achievement coins earned that day (persisted ids). Unknown ids
              (e.g. a retired badge in old rows) are filtered so the catalog can
              evolve without breaking the render. */}
          {(() => {
            const coins = day.achievements.filter(
              (id): id is AchievementId => id in ACHIEVEMENT_CATALOG,
            )
            if (coins.length === 0) return null
            return (
              <span className="flex items-center gap-1 shrink-0">
                {coins.map(id => (
                  <AchievementCoin
                    key={id}
                    id={id}
                    size={16}
                    ring="flat"
                    title={`${ACHIEVEMENT_CATALOG[id].label} — ${ACHIEVEMENT_CATALOG[id].blurb}`}
                  />
                ))}
              </span>
            )
          })()}
        </div>
      </td>
      {/* Reorderable data cells. Keyed by ReorderableColumnId so the iteration
          below stays in lockstep with the parent's header iteration. */}
      {(() => {
        const cellNodes: Record<ReorderableColumnId, React.ReactNode> = {
          tapescore: (
            <td key="tapescore" className={`py-2 pr-3 text-center ${cellBg}`}>
              <TapeScorePill result={day.tapescore} date={day.date} />
            </td>
          ),
          trades: (
            <td key="trades" className={`py-2 pr-3 text-center text-gray-300 font-mono ${cellBg}`}>
              {day.trade_count > 0 ? day.trade_count : <span className="text-gray-700">—</span>}
            </td>
          ),
          win_rate: (
            <td key="win_rate" className={`py-2 pr-3 text-center text-gray-300 font-mono text-xs ${cellBg}`}>
              {day.win_rate == null ? <span className="text-gray-700">—</span> : `${Math.round(day.win_rate)}%`}
            </td>
          ),
          mfe_mae: (
            <td key="mfe_mae" className={`py-2 pr-3 text-center text-gray-300 font-mono text-xs ${cellBg}`}>
              {(() => {
                const v = mfeMaeRatio(day.avg_mfe_pts, day.avg_mae_pts)
                return v === '—' ? <span className="text-gray-700">—</span> : v
              })()}
            </td>
          ),
          capture: (
            <td key="capture" className={`py-2 pr-3 text-center text-gray-300 font-mono text-xs ${cellBg}`}>
              {(() => {
                const { text, title } = formatCaptureCell(day.avg_capture, day.avg_mfe_pts)
                return title
                  ? <span className={`cursor-help ${text === '—' ? 'text-gray-700' : ''}`} title={title}>{text}</span>
                  : text
              })()}
            </td>
          ),
          pnl: (
            <td key="pnl" className={`py-2 pr-3 text-center font-mono font-medium text-xs ${pnlColor} ${cellBg}`}>
              {pnl === null ? '—' : `${pnl >= 0 ? '+' : ''}$${Math.round(pnl).toLocaleString()}`}
            </td>
          ),
        }
        return columnOrder.map(id => cellNodes[id])
      })()}
      {isPro && (
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
      )}
    </tr>
  )
}

/**
 * One-TapeScore pill (Ruleset amendment 5). Single 0-100 number colored by
 * band — green >= 70, amber 50-69, red < 50; every Breach day (2+ rails
 * failed) lands red via the <= 49 cap. The tooltip carries the component
 * breakdown so the old Execution / Process / prep detail is one hover away.
 */
/**
 * TapeScore grades DECISION QUALITY, which is fully measurable on a single
 * trade — did you size right, respect the stop, take your setup, exit at plan?
 * It is not an estimate of edge, so trade count carries no confidence penalty:
 * an earlier version muted any day under 3 trades, which told a one-and-done
 * trader their best-disciplined sessions didn't count. That penalised exactly
 * the restraint the score exists to reward. Sample-size caveats belong on the
 * statistical read-outs (win rate, expectancy, capture %), not here.
 */
function TapeScorePill({ result, date }: { result: TapeScoreResult | null; date: string }) {
  // An ungraded session used to render a dead grey dash. On a freshly imported
  // journal that's the ENTIRE column, which reads as "broken" rather than "not
  // done yet" — so the empty cell carries the action that fills it. Deliberately
  // understated: a column of loud buttons would drown the scores beside it.
  if (result == null) {
    return (
      <Link
        href={`/review/today/${date}`}
        className="text-[11px] text-gray-600 hover:text-amber-300 transition-colors"
        title="Not graded yet — open this session's recap and run Analyze Session."
      >
        Grade
      </Link>
    )
  }
  const color =
    result.band === 'high' ? 'text-green-300 border-green-800/60 bg-green-950/40'
    : result.band === 'mid' ? 'text-amber-300 border-amber-800/60 bg-amber-950/40'
    : 'text-red-300 border-red-800/60 bg-red-950/40'
  const { passCount, railCount, entry, capture } = result.components
  const tooltip = result.basis === 'legacy'
    ? 'Scored under an earlier rubric (pre-v1.3 single score).'
    : [
        passCount != null ? `Risk limits respected: ${passCount}/${railCount ?? 5}` : null,
        entry != null ? `Entry ${entry}` : null,
        capture != null ? `Capture ${capture}` : null,
        result.capped ? 'capped at 49 — 2+ rails broke' : null,
      ].filter(Boolean).join(' · ')
  return (
    <span
      className={`font-mono font-bold border rounded px-1.5 py-0.5 inline-block w-9 text-center text-xs ${color}`}
      title={tooltip}
    >
      {result.score}
    </span>
  )
}
