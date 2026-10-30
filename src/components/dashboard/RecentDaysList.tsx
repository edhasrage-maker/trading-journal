'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { TrendingUp, TrendingDown, Minus, Trash2, Loader2, Check, ChevronUp, ChevronDown } from 'lucide-react'
import type { TapeScoreResult } from '@/lib/tapescore'
import { axisTooltip, type TradeSums } from '@/lib/tapescore-axes'
import AchievementCoin from '@/components/AchievementCoin'
import { ACHIEVEMENT_CATALOG, type AchievementId } from '@/lib/achievements'
import { useMfeUnit, type MfeUnit } from '@/lib/mfe-unit'
import { mgmtView, formatKept, type MgmtTotals } from '@/lib/trade-management'
import { GLANCE_WINDOW_DAYS, RISK_OFF_MULTIPLE, PLAYBOOK_OFF_POINTS, KEPT_OFF_POINTS, TRADES_OFF_MULTIPLE, type DayGlanceRead } from '@/lib/day-glance'

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
  /** The day's per-trade sums + counts (src/lib/exit-rollup.ts) — what a
   *  period's axes pool over its trades. */
  trade_sums?: TradeSums | null
  win_rate: number | null
  avg_mfe_pts: number | null
  avg_mae_pts: number | null
  avg_mfe_dollars: number | null
  avg_mae_dollars: number | null
  /** Retired dollar-pooled capture figure. Still on the rollup for older
   *  readers; this table reads `mgmt` instead. */
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
  /** Trade-management sums for the day (src/lib/trade-management.ts) — behind
   *  the "Went your way" and "Kept" columns. Same sums the dashboard card pools. */
  mgmt?: MgmtTotals | null
  /** The four numbers read against the trader's usual (src/lib/day-glance.ts).
   *  Null/absent = nothing to read (no trades, or a cache row still recomputing). */
  glance_read?: DayGlanceRead | null
}

interface Props {
  initialDays: DayRowData[]
  /** 'pro' (default) = Detailed Tape: full column set + selection/delete/drag.
   *  'beginner' = Highlights: a lean read-only set (Tape / Trades / Win % /
   *  P&L), no selection, no delete, fixed order. Same table, one product. */
  mode?: 'beginner' | 'pro'
}

type SortColumn = 'date' | 'tapescore' | 'trades' | 'win_rate' | 'pnl' | 'off'
type SortDirection = 'asc' | 'desc'

/** Columns the user can drag-reorder (Detailed only). Date is pinned left (row
 *  identifier), the checkbox cell is pinned left (selection), the delete cell
 *  is pinned right (row action) — those never move.
 *
 *  Pt 13 rework (2026-07-12): Day type leaves the dashboard entirely (analytics
 *  is its home). Win % joins both modes; Detailed additionally shows the two
 *  trade-management reads — how many trades went your way, and how much of
 *  those you kept — the same two ideas as the Trade management card above.
 *
 *  2026-10-28: Detailed leads with the four numbers that say which day to open
 *  (src/lib/day-glance.ts) — Risk vs usual, Trades vs usual, MFE Profit Kept,
 *  After your high — plus how many of them are off. Entry Compliance, Win % and
 *  Went your way sit behind the Columns menu: on a 2–4 trade day a rate can only
 *  read 0, 50 or 100%, and Entry Compliance needs the trader's own entry rules
 *  (and is already part of the TapeScore's Entry). */
type ReorderableColumnId = 'tapescore' | 'trades' | 'win_rate' | 'went' | 'kept' | 'pnl' | 'risk' | 'playbook' | 'after_high' | 'off'
const DEFAULT_COLUMN_ORDER: ReorderableColumnId[] = ['tapescore', 'pnl', 'risk', 'trades', 'kept', 'after_high', 'off', 'playbook', 'win_rate', 'went']
/** Off by default in Detailed; the Columns menu adds them back. */
const DEFAULT_HIDDEN: ReorderableColumnId[] = ['playbook', 'win_rate', 'went']
const COLUMN_LABELS: Record<ReorderableColumnId, string> = {
  tapescore: 'TapeScore', pnl: 'PnL', risk: 'Risk vs usual', playbook: 'Entry Compliance', kept: 'MFE Profit Kept',
  after_high: 'After your high', off: 'Off usual', trades: 'Trades vs usual', win_rate: 'Win %', went: 'Went your way',
}
// v2: Trades vs usual became a default column and Entry Compliance optional;
// a saved v1 list would keep Trades hidden.
const HIDDEN_COLUMNS_STORAGE_KEY = 'dashboard-recent-days-hidden-columns-v2'
/** Highlights: lean, fixed, non-reorderable. */
const BEGINNER_COLUMN_ORDER: ReorderableColumnId[] = ['tapescore', 'pnl', 'trades', 'win_rate']
// v3: v2 carried the now-removed `day_type` id; bump so stale saved orders reset.
// v4: the default order changed (P&L moved up beside TapeScore). The key is
// versioned because the held order is persisted — without a bump, anyone who
// has ever used this table keeps the old arrangement and never sees the change.
// v5: `mfe_mae` and `capture` became `went` and `kept`; a saved order naming the
// old ids would drop both new columns.
// v6: the four day numbers joined and lead the default order.
// v7: Trades vs usual took Entry Compliance's place among them.
const COLUMN_ORDER_STORAGE_KEY = 'dashboard-recent-days-column-order-v7'

/** Date earns a wider column than the numbers — it carries a weekday, a month
 *  and a date, plus any achievement coins — but only just: a quarter more. */
const DATE_COL_RATIO = 1.25
/** Selection checkbox and delete columns (Detailed only), as a share of the
 *  table. Both hold a single small control. */
const PINNED_COL_PCT = 3.5

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
  // Shared with the Trade management card, so "Kept" here and on the card are
  // always in the same unit.
  const [mfeUnit] = useMfeUnit()
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
  // Columns the trader switched off (Detailed only), same hydrate/persist pattern.
  const [hiddenCols, setHiddenCols] = useState<ReorderableColumnId[]>(DEFAULT_HIDDEN)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_COLUMNS_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from localStorage
      setHiddenCols(parsed.filter((x): x is ReorderableColumnId =>
        typeof x === 'string' && (DEFAULT_COLUMN_ORDER as string[]).includes(x)))
    } catch { /* ignore */ }
  }, [])
  const toggleColumn = (id: ReorderableColumnId) => {
    setHiddenCols(prev => {
      const next = prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
      // Never hide the last column.
      if (next.length >= DEFAULT_COLUMN_ORDER.length) return prev
      try { localStorage.setItem(HIDDEN_COLUMNS_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

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
        case 'off': return d.glance_read?.off ?? null
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
        selected.map(d => `  • ${d.date}${d.eod_pnl != null ? ` (PnL ${d.eod_pnl >= 0 ? '+' : '-'}$${Math.abs(d.eod_pnl)})` : ''}`).join('\n') +
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

  // A two-line header for the four day numbers: the name, then what it measures.
  const kpiTh = (id: ReorderableColumnId, label: string, sub: string, title: string) => (
    <th
      key={id}
      {...dragProps(id)}
      className={`font-normal py-2 pr-3 text-center ${dragProps(id).className ?? ''}`}
      title={title}
    >
      <span className="text-gray-500">{label}</span>
      <span className="block text-[10px] text-gray-600">{sub}</span>
    </th>
  )

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
        label={isPro
          ? <span className="inline-flex flex-col items-center"><span>Trades vs usual</span><span className="text-[10px] text-gray-600">trades taken</span></span>
          : 'Trades'}
        column="trades"
        current={sortColumn}
        direction={sortDirection}
        onSort={setSort}
        align="center"
        className="pr-3"
        titleAttr={isPro ? `The day's trade count against your usual day (the middle of your last ${GLANCE_WINDOW_DAYS} trading days). Lights up at ${TRADES_OFF_MULTIPLE}× or more.` : undefined}
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
    went: (
      <th
        key="went"
        {...dragProps('went')}
        className={`font-normal py-2 pr-3 text-center ${dragProps('went').className ?? ''}`}
        title="How many of the day's trades got at least 1×ATR in your favor at some point. The rest never got going — an entry problem, not an exit one."
      >
        <span className="text-gray-500">Went your way</span>
      </th>
    ),
    kept: (
      <th
        key="kept"
        {...dragProps('kept')}
        className={`font-normal py-2 pr-3 text-center ${dragProps('kept').className ?? ''}`}
        title="On the trades that went your way: what you banked out of how far they ran, losses included. Uses the unit chosen on the Trade management card."
      >
        <span className="text-gray-500">{isPro ? 'MFE Profit Kept' : 'Kept'}</span>
        {isPro && <span className="block text-[10px] text-gray-600">of what went your way</span>}
      </th>
    ),
    risk: kpiTh('risk', 'Risk vs usual', 'avg risk per trade',
      `The day's average planned dollar risk per trade, against your usual risk per trade going into the day (the same average Loss size uses). Lights up at ${RISK_OFF_MULTIPLE}× or more.`),
    playbook: kpiTh('playbook', 'Entry Compliance', 'trades that passed every rule',
      `The share of the day's trades that passed every one of your entry rules, against your last ${GLANCE_WINDOW_DAYS} trading days. Lights up ${PLAYBOOK_OFF_POINTS}+ points under usual.`),
    after_high: kpiTh('after_high', 'After your high', 'once up a good day',
      `Did you keep trading after your realized P&L reached a good day — your average green day over your last ${GLANCE_WINDOW_DAYS} trading days? Lights up when you did.`),
    off: (
      <SortableTh
        key="off"
        label="Off"
        column="off"
        current={sortColumn}
        direction={sortDirection}
        onSort={setSort}
        align="center"
        className="pr-3"
        titleAttr="How many of Risk vs usual, Trades vs usual, MFE Profit Kept and After your high are off your usual. Sort by it to put the days worth a look first."
        thProps={dragProps('off')}
      />
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
  const effectiveOrder = isPro ? columnOrder.filter(c => !hiddenCols.includes(c)) : BEGINNER_COLUMN_ORDER
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

      {isPro && (
        <div className="flex justify-end mb-2">
          {/* A native disclosure: opens and closes without a click-outside handler. */}
          <details className="relative">
            <summary className="list-none cursor-pointer select-none text-xs text-gray-400 hover:text-white border border-gray-700 rounded-md px-2.5 py-1">
              Columns ▾
            </summary>
            <div className="absolute right-0 mt-1 z-20 w-52 bg-gray-900 border border-gray-700 rounded-lg shadow-lg p-2 flex flex-col gap-0.5">
              {columnOrder.map(id => (
                <label key={id} className="flex items-center gap-2 text-xs text-gray-300 px-1.5 py-1 rounded hover:bg-gray-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!hiddenCols.includes(id)}
                    onChange={() => toggleColumn(id)}
                    className="accent-blue-500"
                  />
                  {COLUMN_LABELS[id]}
                </label>
              ))}
            </div>
          </details>
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
  mfeUnit,
  onToggleSelect,
  onDelete,
}: {
  day: DayRowData
  /** Display unit for the Kept column (shared app-wide preference). */
  mfeUnit: MfeUnit
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
  const mgmt = day.mgmt ? mgmtView(day.mgmt, mfeUnit) : null
  const g = day.glance_read ?? null
  // Wrapping each cell in a Link would inflate markup; instead use a single
  // overlay link via the row's last cell with an onClick stopPropagation guard
  // on the checkbox + delete button.
  const navigate = () => { window.location.href = `/session/${day.date}` }

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
          <Link href={`/session/${day.date}`} className="text-white hover:text-blue-300 transition-colors font-medium whitespace-nowrap">
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
              {day.trade_count === 0
                ? <span className="text-gray-700">—</span>
                : !isPro || g == null
                  ? day.trade_count
                  : (
                    <GlanceCell
                      main={String(day.trade_count)}
                      sub={g.trades.usual != null ? `usual ${g.trades.usual % 1 ? g.trades.usual.toFixed(1) : g.trades.usual}` : 'no usual yet'}
                      off={g.trades.off}
                      title={`${day.trade_count} trade${day.trade_count === 1 ? '' : 's'}.${g.trades.usual != null ? ` Your usual day: ${g.trades.usual} (the middle of your last ${GLANCE_WINDOW_DAYS} trading days).` : ''}`}
                    />
                  )}
            </td>
          ),
          win_rate: (
            <td key="win_rate" className={`py-2 pr-3 text-center text-gray-300 font-mono text-xs ${cellBg}`}>
              {day.win_rate == null ? <span className="text-gray-700">—</span> : `${Math.round(day.win_rate)}%`}
            </td>
          ),
          went: (
            <td key="went" className={`py-2 pr-3 text-center text-gray-300 font-mono text-xs ${cellBg}`}>
              {mgmt == null || mgmt.classified === 0
                ? <span className="text-gray-700">—</span>
                : `${mgmt.went.count} of ${mgmt.classified}`}
            </td>
          ),
          kept: (
            <td key="kept" className={`py-2 pr-3 text-center text-gray-300 font-mono text-xs ${cellBg}`}>
              {mgmt == null || mgmt.classified === 0
                ? <span className="text-gray-700">—</span>
                : mgmt.went.count === 0
                  // No trade went your way: there was no exit to grade. A dash,
                  // not 0% — 0% is reserved for "it ran and you kept none of it".
                  ? <span className="text-gray-600 cursor-help" title="No trade went your way this day, so there was no exit to grade.">—</span>
                  : !isPro
                    ? formatKept(mgmt.went.keptPct)
                    : (
                      <GlanceCell
                        main={formatKept(mgmt.went.keptPct)}
                        sub={g?.kept.usual != null ? `usual ${Math.round(g.kept.usual * 100)}%` : 'no usual yet'}
                        off={g?.kept.off ?? false}
                        title={`What you banked out of how far the trades that went your way ran.${g?.kept.usual != null ? ` Usual: ${Math.round(g.kept.usual * 100)}% over your last ${GLANCE_WINDOW_DAYS} trading days. Lights up ${KEPT_OFF_POINTS}+ points under usual.` : ''}`}
                      />
                    )}
            </td>
          ),
          risk: (
            <td key="risk" className={`py-2 pr-3 text-center ${cellBg}`}>
              {g?.risk == null
                ? <span className="text-gray-700" title="No trade this day had a planned stop.">—</span>
                : (
                  <GlanceCell
                    main={usd(g.risk.avg)}
                    sub={g.risk.ratio != null ? `${g.risk.ratio.toFixed(1)}× usual` : 'no usual yet'}
                    off={g.risk.off}
                    title={`Average planned risk per trade: ${usd(g.risk.avg)}${g.risk.max != null ? ` (biggest single trade ${usd(g.risk.max)})` : ''}.${g.risk.usual != null ? ` Your usual risk per trade going into this day: ${usd(g.risk.usual)}.` : ''}`}
                  />
                )}
            </td>
          ),
          playbook: (
            <td key="playbook" className={`py-2 pr-3 text-center ${cellBg}`}>
              {g?.playbook == null
                ? <span className="text-gray-700" title="No entry-rule checks this day: no rules set, or the trades have no tape snapshot yet.">—</span>
                : (
                  <GlanceCell
                    main={`${Math.round(g.playbook.pct * 100)}% (${g.playbook.passed} of ${g.playbook.trades})`}
                    sub={g.playbook.mostMissed ? `most missed: ${g.playbook.mostMissed}` : 'every trade passed'}
                    off={g.playbook.off}
                    title={`Trades that passed every entry rule: ${g.playbook.passed} of ${g.playbook.trades}.${g.playbook.usual != null ? ` Usual: ${Math.round(g.playbook.usual * 100)}% over your last ${GLANCE_WINDOW_DAYS} trading days.` : ''}`}
                  />
                )}
            </td>
          ),
          after_high: (
            <td key="after_high" className={`py-2 pr-3 text-center ${cellBg}`}>
              {g?.high == null ? <span className="text-gray-700">—</span> : <AfterHighCell high={g.high} />}
            </td>
          ),
          off: (
            <td key="off" className={`py-2 pr-3 text-center text-xs tracking-widest text-gray-300 ${cellBg}`}>
              {g == null
                ? <span className="text-gray-700">—</span>
                : <span aria-label={`${g.off} of 4 off your usual`} title={`${g.off} of 4 off your usual`}>{'●'.repeat(g.off)}{'○'.repeat(4 - g.off)}</span>}
            </td>
          ),
          pnl: (
            <td key="pnl" className={`py-2 pr-3 text-center font-mono font-medium text-xs ${pnlColor} ${cellBg}`}>
              {pnl === null ? '—' : `${pnl >= 0 ? '+' : '-'}$${Math.abs(Math.round(pnl)).toLocaleString('en-US')}`}
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

/** Whole dollars, with a sign when asked: "$400", "+$1,297", "-$340". */
function usd(n: number, signed = false): string {
  const s = n < 0 ? '-' : signed && n > 0 ? '+' : ''
  return `${s}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`
}

/** One of the four day numbers: the value, a short line under it, and a
 *  caution tint when it is off the trader's usual. Quiet otherwise. */
function GlanceCell({ main, sub, off, title }: { main: string; sub: string; off: boolean; title: string }) {
  return (
    <span
      className={`inline-flex flex-col items-center leading-tight rounded px-1.5 py-0.5 border ${
        off ? 'bg-amber-950/40 border-amber-800/60' : 'border-transparent'
      }`}
      title={title}
    >
      <span className={`font-mono text-xs whitespace-nowrap ${off ? 'text-white font-semibold' : 'text-gray-300'}`}>{main}</span>
      <span className={`text-[10px] ${off ? 'text-amber-300' : 'text-gray-500'}`}>{sub}</span>
    </span>
  )
}

/** "After your high": only a high worth a good day counts, so a day that was
 *  briefly up $53 doesn't read as "gave it back". */
function AfterHighCell({ high }: { high: NonNullable<DayGlanceRead['high']> }) {
  const goodDay = high.bar != null ? usd(high.bar) : null
  const title = `Your best realized P&L of the day: ${usd(high.peak, true)}.${goodDay ? ` A good day for you lately (average green day, last ${GLANCE_WINDOW_DAYS} trading days): ${goodDay}.` : ' Not enough green days yet to know what a good day is.'}`
  if (high.peak <= 0) return <GlanceCell main="Never green" sub="no high to stop at" off={false} title={title} />
  if (high.bar == null) return <GlanceCell main={`Best ${usd(high.peak, true)}`} sub="no usual yet" off={false} title={title} />
  if (!high.reached) return <GlanceCell main="No big high" sub={`best ${usd(high.peak, true)} · good day ${goodDay}`} off={false} title={title} />
  if (high.off) {
    return (
      <GlanceCell
        main={`${high.afterTrades} trade${high.afterTrades === 1 ? '' : 's'} after`}
        sub={`up ${usd(high.peak, true)}, then ${usd(high.afterPnl, true)}`}
        off
        title={title}
      />
    )
  }
  return <GlanceCell main="Stopped at the high" sub={`up ${usd(high.peak, true)}, nothing after`} off={false} title={title} />
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
        href={`/session/${date}`}
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
  const { risk, entry, exit } = result.components
  // Each axis on a line, with the parts behind it underneath.
  const tooltip = result.basis === 'legacy'
    ? 'Scored under an earlier rubric (pre-v1.3 single score).'
    : [
        risk != null ? axisTooltip(`Risk ${risk}${result.capped ? ' (capped at 49 — rules broken)' : ''}`, result.parts, 'risk') : null,
        entry != null ? axisTooltip(`Entry ${entry}`, result.parts, 'entry', { checklistItems: false }) : null,
        exit != null ? axisTooltip(`Exit ${exit}`, result.parts, 'exit') : null,
        result.chaseCapped ? `Capped at 69 (from ${result.uncapped}): ${result.chaseTrades} chase trades, quick re-entries after a loss with no fresh trigger.` : null,
      ].filter(Boolean).join('\n\n')
  return (
    <span
      className={`font-mono font-bold border rounded px-1.5 py-0.5 inline-block w-9 text-center text-xs ${color}`}
      title={tooltip}
    >
      {result.score}
    </span>
  )
}
