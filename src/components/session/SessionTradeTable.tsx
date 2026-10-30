'use client'

/**
 * SessionTradeTable — the one trade table shared by the Intraday (capture) and
 * EOD (review) surfaces. Two configurations off a single implementation:
 *
 *   - `capture` (Intraday, market open): Time · Instr chip · Setup · Entry ·
 *     Stop · TP1 · Qty · P&L · edit. No scores, no verdicts, no AI — the live
 *     room is a write surface, judgment stays out of sight until the close.
 *   - `review` (EOD, market closed): adds R, Captured, MAE, ATR@, Post-Exit
 *     verdicts, and the full-width AI sub-rows. This is the film of the game.
 *
 * The review path is byte-identical to the pre-merge `eod/TradeList.tsx` it was
 * extracted from — capture-only behavior is gated behind `config === 'capture'`
 * so the EOD render never changes. (Session-merge Pt 13, step 1.)
 */

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Trash2, Loader2, HelpCircle, X, Columns3, Pencil, CheckSquare, Square, MinusSquare, Upload } from 'lucide-react'
import { maeHeatRatio, rMultiple, mfeMaePoints, type BarLike } from '@/lib/analytics'
import { plannedStopPrice } from '@/lib/planned-stop'
import { tradeFacts, tradeMgmt, mgmtBarGeometry, formatKept, exitKind, type TradeMgmt } from '@/lib/trade-management'
import { stopCheck } from '@/lib/exit-score'
import { symbolRoot, symbolToMultiplier } from '@/lib/futures-symbols'
import { postExitVerdict, plannedExitRead, type VerdictTrade, type VerdictTone } from '@/lib/post-exit-verdict'
import { useMfeUnit, type MfeUnit } from '@/lib/mfe-unit'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import type { Trade } from '@/lib/supabase/types'
import { GradeChip, TradeGradeDetail } from './TradeGrade'
import type { EntryRuleConfig } from '@/lib/entry-rules'
import type { RunnerRuleConfig } from '@/lib/runner-rules'
import type { TradeGrade } from '@/lib/trade-grade'
import { useTradeGrades } from '@/lib/use-trade-grades'

// Trade times read in Pacific — the app's display convention — on the server
// and in the browser alike. date-fns `format` used whichever clock ran it, so
// the server's UTC render ("2:21 PM") and the browser's ("7:21 AM") disagreed
// and React threw away the server HTML (minified error #418).
const PT_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })
const PT_CLOCK_SECONDS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
/** "7:21 AM" — assembled from parts so the space before AM/PM is a plain one
 *  (some ICU versions emit a narrow no-break space, which would make server
 *  and browser disagree all over again). */
const ptClock = (iso: string) => {
  const p = Object.fromEntries(PT_CLOCK.formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return `${p.hour}:${p.minute} ${p.dayPeriod}`
}
/** "07:21:00" */
const ptClockSeconds = (iso: string) => PT_CLOCK_SECONDS.format(new Date(iso))

type SortKey = 'time' | 'atr' | 'pnl' | 'score' | 'r' | 'mfe' | 'mae'
type SortDir = 'asc' | 'desc'

// Optional columns the user can show/hide in the Detailed (Pro) view. Core
// columns — checkbox, Time, Setup, PnL, Overview — are always shown.
// The choice is persisted per-device in localStorage.
//
// Entry is toggleable even though it looks structural. It is a price like Stop
// and TP1, and a trader reading the table for execution quality — R, MFE, MAE,
// Post-Exit — has no more use for it than for the other two. The row is still
// identifiable without it: Time and Setup are core and never hide. Capture
// (screenshot) mode forces it back on with Stop/TP1, since a shared image
// without the fill price isn't worth much.
const TOGGLEABLE_COLS = [
  { key: 'entry', label: 'Entry' },
  { key: 'stop', label: 'Stop' },
  { key: 'tp1', label: 'TP1' },
  { key: 'qty', label: 'Qty' },
  { key: 'atr', label: 'ATR@' },
  { key: 'score', label: 'Score' },
  { key: 'r', label: 'R' },
  { key: 'mae', label: 'MAE · MFE' },
  { key: 'mfe', label: 'Kept' },
  { key: 'postExit', label: 'After exit' },
] as const
type ColKey = (typeof TOGGLEABLE_COLS)[number]['key']
const COLS_STORAGE_KEY = 'eod-trade-cols-v1'
// v2: the MAE column became the wide MAE · MFE bar column and swapped places
// with Kept; a width dragged for the old narrow MAE would crush the bar.
const COL_WIDTHS_KEY = 'eod-trade-col-widths-v2'
/** Narrowest a column may be dragged. Below this the header label is unreadable
 *  and the handle becomes hard to grab back. */
const MIN_COL_PX = 44

/** Saved widths, or null when the trader has never dragged anything.
 *  Null is meaningful: it keeps the table on the browser's own auto layout,
 *  which sizes to content better than any default we could invent. Widths only
 *  come into existence on the first drag. */
function loadColWidths(): Record<string, number> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(COL_WIDTHS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, number>
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length ? parsed : null
  } catch { return null }
}

// Post-exit verdict chip → text color. See src/lib/post-exit-verdict.ts.
const VERDICT_TONE_CLASS: Record<VerdictTone, string> = {
  good: 'text-green-400',
  welltimed: 'text-green-500/70',
  left: 'text-amber-400',
  giveback: 'text-red-400',
  flat: 'text-gray-600',
}
const defaultColPrefs = (): Record<ColKey, boolean> =>
  Object.fromEntries(TOGGLEABLE_COLS.map(c => [c.key, true])) as Record<ColKey, boolean>
function loadColPrefs(): Record<ColKey, boolean> {
  const defaults = defaultColPrefs()
  if (typeof window === 'undefined') return defaults
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY)
    if (!raw) return defaults
    // Merge OVER defaults so a column added in a later version defaults to visible.
    return { ...defaults, ...(JSON.parse(raw) as Partial<Record<ColKey, boolean>>) }
  } catch { return defaults }
}

/** The "Kept" cell for one trade. Only a trade that went your way has an exit
 *  to grade; one that never did says so instead of printing 0%, which blamed
 *  the exit for an entry that never worked. */
export function keptCell(m: TradeMgmt | null): { text: string; cls: string; title: string } {
  if (m == null) return { text: '—', cls: 'text-gray-700', title: 'No price data (or no ATR and no stop) to sort this trade by yet.' }
  if (!m.went) return { text: 'N/A', cls: 'text-gray-600', title: 'Never got 1×ATR your way, so there was no exit to grade: an entry question, not an exit one.' }
  if (m.kept === 0) return { text: '0%', cls: 'text-red-400 font-bold', title: 'Went your way, then gave it all back.' }
  return { text: formatKept(m.kept), cls: 'text-gray-300', title: 'What you banked out of the best point this trade reached.' }
}

/** One excursion magnitude in the active unit, unsigned — the bar's end caps. */
export function magLabel(v: number | null | undefined, unit: MfeUnit): string {
  if (v == null) return '—'
  if (unit === 'dollars') return '$' + Math.round(v).toLocaleString('en-US')
  if (unit === 'atr') return `${v.toFixed(1)}×`
  return v.toFixed(1)
}

interface Props {
  /** `review` (default) = the full EOD table with scores/verdicts/AI, rendered
   *  byte-identical to the pre-merge TradeList. `capture` = the reduced live
   *  Intraday table (no scores, no AI) with an edit action per row. */
  config?: 'capture' | 'review'
  trades: Trade[]
  /** Chart↔row crosshair link (review). Optional so capture callers can omit. */
  hoveredTradeId?: string | null
  /** Row to spotlight briefly after a jump (chart double-click / deep-link).
   *  Distinct from hoveredTradeId — a prominent ring that persists ~5s so the
   *  user can see which trade the chart scrolled to. */
  flashTradeId?: string | null
  onHoverEnter?: (tradeId: string, e: React.MouseEvent) => void
  onHoverLeave?: () => void
  selectedIds: Set<string>
  onToggleSelect: (tradeId: string) => void
  /** Near-duplicate highlight for the merge flow (review). Optional in capture. */
  nearDuplicateIds?: Set<string>
  onDelete: (tradeId: string) => void
  deletingId: string | null
  /** Open this trade's full log in the intraday page. Row-click fallback when
   *  no onEdit is given; on EOD it moves into the drawer's "open full log". */
  onRowOpen?: (tradeId: string) => void
  /** Right-click on a data row. The caller owns the menu (position + actions);
   *  the table just reports which trade was clicked and where. Omit to leave
   *  the browser's native context menu alone. */
  onContextMenu?: (tradeId: string, e: React.MouseEvent) => void
  /** Edit this trade in place — the per-row "edit" button and the row-click.
   *  Intraday opens the inline TradeForm; EOD opens the recap edit drawer. */
  onEdit?: (tradeId: string) => void
  /** Id of the trade currently open in an editor, so its row button reads
   *  "editing…" and the row gets a subtle highlight. */
  editingId?: string | null
  /** DOM id prefix for each data row so page-level deep-link scroll can find it.
   *  Defaults to `eod-trade-` (review); Intraday passes `trade-`. */
  rowIdPrefix?: string
  /** AI 1-2 line narrative per trade id (shown in the Overview column). */
  summaries?: Record<string, string>
  /** True while summaries are being generated. */
  summariesLoading?: boolean
  /** Per-trade live ATR-10 (Wilder) in points, computed at each trade's entry_time from 1-min bars. Powers an "ATR @ entry" chip. */
  liveAtrByTradeId?: Record<string, number>
  /** The trader's "was up" multiple (Settings → ATR measurement). Sorts a trade
   *  into went-your-way / never-got-going; defaults to 1×ATR. */
  giveBackAtr?: number
  /** Per-trade post-exit continuation @30m — how much further the market went after the trade closed. Powers the "Post-Exit" column. */
  postExitByTradeId?: Record<string, import('@/lib/atr').PostExitData>
  /** 1-minute bars for the day. No longer read: Kept is measured against the
   *  trade's own best point (the stored tick extremes), the same way the Trade
   *  management card measures it, so the row and the card can't disagree.
   *  Still accepted so existing callers need no change. */
  bars?: BarLike[] | null
  /** The trader's entry and runner rules (Settings → Trading Rules) — part of
   *  each trade's Score (src/lib/trade-grade.ts). */
  entryRules?: EntryRuleConfig[]
  runnerRules?: RunnerRuleConfig[]
  /** The trader includes the order-flow Score in Entry (default on). */
  includeFlow?: boolean
  /** The trader's ATR stop setting (default 1). */
  atrStopTarget?: number
  /** Grades from the page (useTradeGrades), when it shows them elsewhere too —
   *  the table then reads none itself. */
  gradeOf?: (t: Trade) => TradeGrade | null
  /** Highlights: trades that sized up while red or right after a loss
   *  (sizeUpTradeIds). The trade Score doesn't see sizing, so without this
   *  flag a revenge size-up can read "100 Excellent". */
  pressingIds?: readonly string[] | null
  /** Highlights: trades that went your way, then closed at breakeven or worse
   *  (aggregateRoundTrips ids). */
  giveBackIds?: readonly string[] | null
}

/**
 * One trade's AI-overview / notes line: clamped to 2 lines, with a "more/less"
 * toggle that appears ONLY when the text actually overflows those 2 lines —
 * measured against the rendered width. (The old char-count guess showed the
 * toggle on ~2-line notes where clamping did nothing, so it read as a no-op.)
 * Owns its own expand state so the table doesn't track a Set of ids.
 */
function ClampedNote({ text, italic, title }: { text: string; italic: boolean; title?: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Overflow is only measurable while CLAMPED (clientHeight = 2 lines). When
    // expanded the clamp is off, so clientHeight === scrollHeight — skip
    // re-measuring then and keep the last value, so "less" never vanishes.
    const measure = () => {
      if (expanded) return
      setOverflows(el.scrollHeight > el.clientHeight + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])
  return (
    <div className="flex items-start gap-2 max-w-3xl">
      <p
        ref={ref}
        className={`text-xs font-sans leading-snug whitespace-normal text-gray-400 ${italic ? 'italic' : ''} ${expanded ? '' : 'line-clamp-2'}`}
        title={title}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
          className="text-[10px] text-gray-600 hover:text-gray-300 shrink-0 mt-0.5"
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

export default function SessionTradeTable({
  config = 'review',
  trades,
  hoveredTradeId,
  flashTradeId,
  onHoverEnter,
  onHoverLeave,
  selectedIds,
  onToggleSelect,
  nearDuplicateIds,
  onDelete,
  deletingId,
  onRowOpen,
  onContextMenu,
  onEdit,
  editingId,
  rowIdPrefix = 'eod-trade-',
  summaries = {},
  summariesLoading = false,
  liveAtrByTradeId,
  giveBackAtr = 1,
  postExitByTradeId,
  entryRules,
  runnerRules,
  includeFlow = true,
  atrStopTarget = 1,
  gradeOf: gradeOfProp,
  pressingIds,
  giveBackIds,
}: Props) {
  // Capture (live Intraday) vs review (EOD recap). Every judgment column and the
  // AI sub-rows are gated OFF in capture; the review path evaluates exactly as
  // before so its render stays byte-identical.
  const isCapture = config === 'capture'
  // Scores for trades that have none for their present fill are computed by the
  // site in the background and land here without a reload (review only).
  // The Log (capture) reads just the entry snapshots, for the rule mistake tags.
  // Each trade's Score (review only) — src/lib/use-trade-grades.ts. A page that
  // also shows grades elsewhere (the Session page's trade panel) hands its own
  // in, so the trades are read once.
  const ownGradeOf = useTradeGrades(trades, {
    capture: isCapture, entryRules, runnerRules, includeFlow, atrStopTarget, enabled: !gradeOfProp,
  })
  const gradeOf = gradeOfProp ?? ownGradeOf
  // Row-click action: edit in place when an edit handler is provided (Intraday
  // inline form, or the EOD recap drawer), else open the full log (deep-link).
  const rowAction = onEdit ?? onRowOpen
  // Effective column visibility. Capture forces Stop/TP1/Qty on and every
  // score/verdict column off, ignoring the per-device toggle. Review defers to
  // the user's saved `cols` prefs exactly as before.
  // (declared here; `cols` is initialized just below and these read it lazily)

  // Beginner renders a simple plain list (below); Pro renders the full sortable
  // table. (docs/BEGINNER_PRO_MODES.md)
  const { mode } = useUiMode()
  // Heat display unit (pts / $ / ×ATR), shared globally with the dashboard +
  // AvgMfeMaeCard via useMfeUnit. Defaults to ×ATR.
  const [mfeUnit, setMfeUnit] = useMfeUnit()
  // Sort state. Default is Time asc — preserves the existing fill-order view.
  // Click a sortable column header to toggle; clicking a different column
  // resets to that column's "natural" direction (time asc, everything else desc).
  const [sortKey, setSortKey] = useState<SortKey>('time')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const naturalDir = (k: SortKey): SortDir => (k === 'time' ? 'asc' : 'desc')
  const onSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(k)
      setSortDir(naturalDir(k))
    }
  }

  const sortedTrades = useMemo(() => {
    const sortVal = (t: Trade): number => {
      switch (sortKey) {
        case 'time':
          return t.entry_time ? Date.parse(t.entry_time) : 0
        case 'atr':
          // Cloud build has no live bars; fall back to the stored entry_atr_1m
          // (same ATR-10 1m metric, computed + persisted at import time).
          return (liveAtrByTradeId?.[t.id] ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m) ?? Number.NEGATIVE_INFINITY
        case 'pnl':
          return t.pnl ?? Number.NEGATIVE_INFINITY
        case 'score':
          return gradeOf(t)?.score ?? Number.NEGATIVE_INFINITY
        case 'r':
          return rMultiple(t, liveAtrByTradeId?.[t.id]) ?? Number.NEGATIVE_INFINITY
        case 'mfe': {
          // Kept: trades that went your way by how much they kept; the ones
          // that never got going sort below every graded exit.
          const m = tradeMgmt(t, { atr: liveAtrByTradeId?.[t.id], thresholdAtr: giveBackAtr })
          return m == null ? Number.NEGATIVE_INFINITY : m.went ? (m.kept ?? 0) : -1
        }
        case 'mae':
          return maeHeatRatio(t) ?? Number.NEGATIVE_INFINITY
      }
    }
    const copy = [...trades]
    copy.sort((a, b) => {
      const av = sortVal(a)
      const bv = sortVal(b)
      if (av === bv) {
        // Time as deterministic tiebreaker so a re-sort on equal values
        // doesn't shuffle rows.
        const at = a.entry_time ? Date.parse(a.entry_time) : 0
        const bt = b.entry_time ? Date.parse(b.entry_time) : 0
        return at - bt
      }
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return copy
  }, [trades, sortKey, sortDir, liveAtrByTradeId, giveBackAtr, gradeOf])

  // Click-to-toggle popups for the MFE % / MAE % column definitions. Same
  // dashboard-style popup pattern as the EOD header — click outside / Esc to
  // dismiss. Pinned top-right of the viewport so they don't push the table.
  const [openScoreId, setOpenScoreId] = useState<string | null>(null)
  const [mfeOpen, setMfeOpen] = useState(false)
  const [maeOpen, setMaeOpen] = useState(false)
  const mfeRef = useRef<HTMLDivElement>(null)
  const maeRef = useRef<HTMLDivElement>(null)

  // User-toggleable columns. Init to all-visible (safe for SSR), then hydrate the
  // saved per-device choice from localStorage after mount.
  const [cols, setCols] = useState<Record<ColKey, boolean>>(defaultColPrefs)
  const [colsOpen, setColsOpen] = useState(false)

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  // Widths stay null until the first drag, so the table keeps the browser's
  // auto layout — which sizes to content better than any defaults we could
  // pick — and nobody who never drags sees a change. On the first grab we
  // MEASURE every header cell and seed all of them at once, then switch to
  // `table-fixed`: seeding only the dragged column would let the others
  // redistribute and the whole row would jump under the cursor.
  const [colWidths, setColWidths] = useState<Record<string, number> | null>(null)
  const theadRef = useRef<HTMLTableSectionElement>(null)
  const dragRef = useRef<{ id: string; startX: number; startW: number } | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage isn't readable during render
    setColWidths(loadColWidths())
  }, [])

  /** Measure the rendered header and freeze today's layout as explicit widths. */
  const seedWidths = (): Record<string, number> => {
    const seeded: Record<string, number> = {}
    const cells = theadRef.current?.querySelectorAll<HTMLTableCellElement>('th[data-col]')
    cells?.forEach(th => {
      const id = th.dataset.col
      if (id) seeded[id] = Math.max(MIN_COL_PX, Math.round(th.getBoundingClientRect().width))
    })
    return seeded
  }

  const startResize = (id: string, e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    e.stopPropagation()   // never let the grab reach the header's sort button
    const base = colWidths ?? seedWidths()
    if (!colWidths) setColWidths(base)
    dragRef.current = { id, startX: e.clientX, startW: base[id] ?? MIN_COL_PX }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const next = Math.max(MIN_COL_PX, Math.round(d.startW + (ev.clientX - d.startX)))
      setColWidths(prev => ({ ...(prev ?? base), [d.id]: next }))
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // Hold the resize cursor for the whole drag, even off the 5px handle.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Persist after every change, and drop the key entirely on reset so the next
  // load returns to auto layout rather than to a stale frozen one.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (colWidths) localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(colWidths))
      else localStorage.removeItem(COL_WIDTHS_KEY)
    } catch { /* private mode */ }
  }, [colWidths])

  /** Back to auto layout. Double-clicking any handle clears ALL widths rather
   *  than just its own: once the table is fixed, resetting one column alone
   *  leaves the rest frozen at whatever they happened to measure, which reads
   *  as the reset not working. */
  const resetWidths = () => setColWidths(null)
  // Effective per-column visibility. Capture pins Stop/TP1/Qty on and hides
  // every score/verdict column; review defers to `cols` exactly as before, so
  // its output is unchanged.
  const showEntry = isCapture ? true : cols.entry
  const showStop = isCapture ? true : cols.stop
  const showTp1 = isCapture ? true : cols.tp1
  const showQty = isCapture ? true : cols.qty
  const showAtr = isCapture ? false : cols.atr
  const showScore = isCapture ? false : cols.score
  const showR = isCapture ? false : cols.r
  const showMfe = isCapture ? false : cols.mfe
  const showMae = isCapture ? false : cols.mae
  const showPostExit = isCapture ? false : cols.postExit
  // Column order for the <colgroup> that carries dragged widths. A colgroup is
  // POSITIONAL, so this has to track the header row exactly — hence it is built
  // from the very same flags, immediately below them, rather than restated.
  // One scale for every row's MAE · MFE bar, so the entry line sits at the
  // same place down the column and a long bar means a big move.
  const barScale = (() => {
    let maxMae = 0, maxMfe = 0
    for (const t of trades) {
      const f = tradeFacts(t, { atr: liveAtrByTradeId?.[t.id] })
      const mae = f?.mae[mfeUnit], mfe = f?.mfe[mfeUnit]
      if (mae != null && mae > maxMae) maxMae = mae
      if (mfe != null && mfe > maxMfe) maxMfe = mfe
    }
    return { maxMae, maxMfe }
  })()
  const visibleColIds = [
    'select', 'time', 'setup',
    ...(showEntry ? ['entry'] : []),
    ...(showStop ? ['stop'] : []),
    ...(showTp1 ? ['tp1'] : []),
    ...(showQty ? ['qty'] : []),
    ...(showAtr ? ['atr'] : []),
    'pnl',
    ...(showScore ? ['score'] : []),
    ...(showR ? ['r'] : []),
    ...(showMae ? ['mae'] : []),
    ...(showMfe ? ['mfe'] : []),
    ...(showPostExit ? ['postExit'] : []),
    'actions',
  ]

  // Select-all for the bulk tag / delete flows. Deliberately built out of the
  // existing per-row onToggleSelect rather than a new prop: both callers update
  // selection with a functional setState, so sequential toggles compose, and
  // neither has to change. Operates on the trades actually rendered.
  const allSelected = sortedTrades.length > 0 && sortedTrades.every(t => selectedIds.has(t.id))
  const someSelected = sortedTrades.some(t => selectedIds.has(t.id))
  const toggleSelectAll = () => {
    for (const t of sortedTrades) {
      // Toggle only the rows that need to change, so this lands on all-on or
      // all-off rather than inverting a partial selection.
      if (allSelected === selectedIds.has(t.id)) onToggleSelect(t.id)
    }
  }
  const selectAllTitle = allSelected
    ? `Deselect all ${sortedTrades.length}`
    : `Select all ${sortedTrades.length} trade${sortedTrades.length === 1 ? '' : 's'}`
  // Mixed-instrument day → highlight the per-row symbol chip so an ES entry at
  // 7,5xx isn't sitting unexplained among NQ 29,7xx rows.
  const mixedSymbols = useMemo(
    () => new Set(trades.map(t => (t.symbol ?? '').trim()).filter(Boolean)).size > 1,
    [trades],
  )
  const colsRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate saved column prefs from localStorage once on mount (can't read localStorage during SSR)
  useEffect(() => { setCols(loadColPrefs()) }, [])
  const toggleCol = (key: ColKey) => setCols(prev => {
    const next = { ...prev, [key]: !prev[key] }
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
    return next
  })

  useEffect(() => {
    if (!mfeOpen && !maeOpen && !colsOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (mfeOpen && mfeRef.current && !mfeRef.current.contains(t)) setMfeOpen(false)
      if (maeOpen && maeRef.current && !maeRef.current.contains(t)) setMaeOpen(false)
      if (colsOpen && colsRef.current && !colsRef.current.contains(t)) setColsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMfeOpen(false); setMaeOpen(false); setColsOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [mfeOpen, maeOpen, colsOpen])

  if (trades.length === 0) {
    return (
      // An empty day has exactly one thing worth doing, so say it as an action
      // rather than burying a link mid-sentence. The old copy read as a
      // statement of fact with "Import trade log" the same size as everything
      // around it, and the import route was easy to miss entirely.
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-gray-400 text-sm">No trades logged for this day yet.</p>
        {LOCAL_FEATURES_ENABLED ? (
          <p className="mt-1.5 text-gray-500 text-xs">
            Use the intraday tagging flow, or import a trade log, to populate it.
          </p>
        ) : (
          <>
            <div className="mt-4">
              <Link
                href="/import"
                className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md px-4 py-2 transition-colors"
              >
                <Upload className="w-4 h-4" /> Import trade log
              </Link>
            </div>
            <p className="mt-3 text-gray-500 text-xs">
              Reads a Sierra Chart <span className="font-mono">.txt</span> or a broker CSV — or log
              trades yourself with the paste box above.
            </p>
          </>
        )}
      </div>
    )
  }

  // Beginner: a simple plain list — number · direction · time · setup · score
  // (with its word) · result, the day-level flags the Score can't see, and the
  // AI overview note. No R / MFE% / MAE% / ATR / post-exit columns. The number
  // is the trade's place in the session, the same one "What happened" cites.
  if (mode === 'beginner') {
    const seqById = new Map(trades.map((t, i) => [t.id, i + 1]))
    const pressing = new Set(pressingIds ?? [])
    const gaveBack = new Set(giveBackIds ?? [])
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-3 text-sm" style={{ fontFamily: 'var(--font-display)' }}>Trades ({trades.length})</h2>
        <div className="divide-y divide-gray-800">
          {sortedTrades.map(t => {
            const setup = ((t.tags_json as unknown as { setups?: string[] } | null)?.setups ?? [])[0]
            const pnl = t.pnl
            const time = t.entry_time ? ptClock(t.entry_time) : '--'
            const summary = summaries[t.id]
            // Same fallback as the pro table: the trader's own note stands in
            // until an AI overview exists (or when it can't be generated, e.g.
            // the read-only demo account).
            const overviewText = summary ?? (t.notes?.trim() || null)
            const overviewIsNotes = !summary && !!t.notes?.trim()
            const isLong = t.direction === 'long'
            const grade = gradeOf(t)
            const flags: { label: string; cls: string; title: string }[] = []
            if (grade?.score != null && grade.score >= 70 && (pnl ?? 0) < 0) {
              flags.push({ label: 'Good loss', cls: 'text-blue-300 bg-blue-950/50 border-blue-800/60', title: 'You traded it well; the market just didn’t pay.' })
            }
            if (pressing.has(t.id)) {
              flags.push({ label: 'Sized up after a loss', cls: 'text-red-300 bg-red-950/40 border-red-800/60', title: 'Bigger than usual while red on the day or right after a loss. The trade Score doesn’t see sizing; the day’s Risk does.' })
            }
            if (gaveBack.has(t.id)) {
              flags.push({ label: 'Gave back a winner', cls: 'text-amber-300 bg-amber-950/40 border-amber-800/60', title: 'It went your way, then closed at breakeven or worse.' })
            }
            return (
              <div
                key={t.id}
                className={`py-3 ${rowAction ? 'cursor-pointer hover:bg-gray-800/40 -mx-2 px-2 rounded-lg' : ''}`}
                onClick={rowAction ? () => rowAction(t.id) : undefined}
              >
                <div className="flex items-center gap-3">
                  <span className="w-5 h-5 shrink-0 rounded-full bg-gray-800 text-gray-400 text-[10px] font-bold grid place-items-center tabular-nums" title="Trade number in the session">
                    {seqById.get(t.id)}
                  </span>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isLong ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>{isLong ? 'LONG' : 'SHORT'}</span>
                  <span className="text-sm text-gray-300 tabular-nums">{time}</span>
                  {setup && <span className="text-xs text-gray-500 truncate">{setup}</span>}
                  <span className="flex-1" />
                  {grade && grade.score != null && (
                    <GradeChip grade={grade} word open={openScoreId === t.id} onToggle={() => setOpenScoreId(openScoreId === t.id ? null : t.id)} />
                  )}
                  <span className={`text-sm font-semibold ${(pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {pnl == null ? '--' : `${pnl < 0 ? '-' : '+'}$${Math.abs(Math.round(pnl)).toLocaleString('en-US')}`}
                  </span>
                </div>
                {grade && openScoreId === t.id && <TradeGradeDetail grade={grade} neverWent={tradeMgmt(t, { thresholdAtr: giveBackAtr })?.went === false} hasStop={plannedStopPrice(t) != null} />}
                {flags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5 pl-8">
                    {flags.map(f => (
                      <span key={f.label} className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border ${f.cls}`} title={f.title}>{f.label}</span>
                    ))}
                  </div>
                )}
                {overviewText && (
                  <p
                    className={`text-xs text-gray-500 mt-1.5 pl-8 leading-snug ${overviewIsNotes ? 'italic' : ''}`}
                    title={overviewIsNotes ? 'From your own notes on this trade — AI summary not yet generated.' : undefined}
                  >
                    {overviewText}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-white text-sm">Trades ({trades.length})</h2>
        {/* Column show/hide is a review-only affordance — capture has a fixed
            column set (no scores/verdicts to toggle). */}
        {!isCapture && <div className="relative hidden md:block" ref={colsRef}>
          <button
            type="button"
            onClick={() => setColsOpen(o => !o)}
            className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors ${
              colsOpen ? 'border-blue-500 text-blue-300 bg-blue-950/30' : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'
            }`}
            title="Show / hide columns"
          >
            <Columns3 className="w-3.5 h-3.5" /> Columns
          </button>
          {colsOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 w-44 bg-gray-900 border border-gray-700 rounded-lg p-1.5 shadow-xl">
              <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-gray-600">Show columns</p>
              {TOGGLEABLE_COLS.map(c => (
                <label
                  key={c.key}
                  className="flex items-center gap-2 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 rounded cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={cols[c.key]}
                    onChange={() => toggleCol(c.key)}
                    className="accent-blue-500 w-3.5 h-3.5"
                  />
                  {c.label}
                </label>
              ))}
              {/* Only offered once widths exist. Dragging is discoverable at the
                  header edge but resetting isn't, and a layout you can get into
                  and not out of is worse than no layout control at all. */}
              {colWidths && (
                <>
                  <div className="my-1 border-t border-gray-800" />
                  <button
                    type="button"
                    onClick={() => { resetWidths(); setColsOpen(false) }}
                    className="w-full text-left px-2 py-1 text-xs text-gray-400 hover:text-gray-100 hover:bg-gray-800 rounded"
                    title="Return every column to its automatic width"
                  >
                    Reset column widths
                  </button>
                </>
              )}
            </div>
          )}
        </div>}
      </div>
      {/* Mobile: each trade as a stacked card — the wide table is unreadable on
          a phone. Shows all fields (vertical space is cheap). Desktop keeps the
          full sortable table below. */}
      <div className="md:hidden space-y-2.5">
        {/* Mobile sort control — the sortable column headers are desktop-only,
            so on a phone this is the only way to reorder the cards. Drives the
            same sortKey/sortDir the desktop table uses. */}
        <div className="flex items-center gap-2">
          <label htmlFor="mobile-trade-sort" className="text-xs text-gray-500 shrink-0">Sort by</label>
          <select
            id="mobile-trade-sort"
            value={sortKey}
            onChange={e => { const k = e.target.value as SortKey; setSortKey(k); setSortDir(naturalDir(k)) }}
            className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-gray-200"
          >
            <option value="time">Time</option>
            {!isCapture && <option value="r">R</option>}
            {!isCapture && <option value="mfe">MFE</option>}
            {!isCapture && <option value="mae">MAE</option>}
            <option value="pnl">P&amp;L</option>
            {!isCapture && <option value="score">Score</option>}
            {!isCapture && <option value="atr">ATR@</option>}
          </select>
          <button
            type="button"
            onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
            className="shrink-0 px-2.5 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-gray-300 hover:text-white transition-colors"
            aria-label={sortDir === 'asc' ? 'Ascending order — tap for descending' : 'Descending order — tap for ascending'}
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDir === 'asc' ? <ArrowUp className="w-4 h-4" /> : <ArrowDown className="w-4 h-4" />}
          </button>
          {/* Same select-all as the desktop header — the bulk tag/delete bar is
              reachable on mobile too, so it needs a way to fill it. */}
          <button
            type="button"
            onClick={toggleSelectAll}
            disabled={sortedTrades.length === 0}
            aria-label={selectAllTitle}
            title={selectAllTitle}
            className="shrink-0 px-2.5 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-gray-300 hover:text-white disabled:opacity-40 transition-colors"
          >
            {allSelected
              ? <CheckSquare className="w-4 h-4 text-blue-400" />
              : someSelected
                ? <MinusSquare className="w-4 h-4 text-blue-400/70" />
                : <Square className="w-4 h-4" />}
          </button>
        </div>
        {sortedTrades.map(t => {
          const pnl = t.pnl ?? 0
          const isSelected = selectedIds.has(t.id)
          const isLong = t.direction === 'long'
          const isShort = t.direction === 'short'
          const setup = t.tags_json?.setups?.[0]
          const time = t.entry_time ? ptClockSeconds(t.entry_time) : '--:--:--'
          const summary = summaries[t.id]
          const liveAtr = liveAtrByTradeId?.[t.id]
          const r = rMultiple(t, liveAtr)
          const rAtrBased = r != null && plannedStopPrice(t) == null
          const rCls = r == null ? 'text-gray-600' : r >= 1 ? 'text-green-400' : r >= 0 ? 'text-green-500' : r >= -0.5 ? 'text-orange-400' : 'text-red-400'
          const xc = mfeMaePoints(t)
          const maePts = xc?.mae ?? null
          const atrRef = liveAtr ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m
          const maeAtr = (maePts != null && atrRef != null && atrRef > 0) ? maePts / atrRef : null
          const maeMag = maePts == null ? '—'
            : mfeUnit === 'dollars' ? '$' + Math.round(maePts * (t.quantity ?? 1) * symbolToMultiplier(t.symbol ?? '')).toLocaleString('en-US')
            : mfeUnit === 'atr' ? (maeAtr == null ? '—' : `${maeAtr.toFixed(1)}×`)
            : maePts.toFixed(1)
          const winnerHeat = (t.pnl ?? 0) > 0 && maeAtr != null && maeAtr >= 1
          const facts = tradeFacts(t, { atr: liveAtr })
          const pastStop = stopCheck(t, facts)?.past === true
          const kept = keptCell(tradeMgmt(t, { atr: liveAtr, thresholdAtr: giveBackAtr }))
          // The plan running its course gets no verdict, only what price did
          // after; an exit made by hand gets a verdict.
          const kind = exitKind(t)
          const postVerdict = kind === 'manual' || kind == null ? postExitVerdict(t as VerdictTrade, postExitByTradeId?.[t.id]) : null
          const postLabel = kind === 'stopped' || kind === 'target'
            ? plannedExitRead(t as VerdictTrade, kind, postExitByTradeId?.[t.id]).label
            : postVerdict ? `${postVerdict.glyph} ${postVerdict.label}` : '—'
          const postCls = kind === 'stopped' || kind === 'target' ? 'text-gray-400' : postVerdict ? VERDICT_TONE_CLASS[postVerdict.tone] : 'text-gray-600'
          const grade = gradeOf(t)
          return (
            <div
              key={t.id}
              onClick={() => rowAction?.(t.id)}
              className={`rounded-xl border overflow-hidden ${isSelected ? 'border-blue-600 bg-blue-950/20' : 'border-gray-800 bg-gray-950/40'}`}
            >
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-3 py-2.5 border-b border-gray-800/70">
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onToggleSelect(t.id) }}
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 bg-gray-900'}`}
                  aria-label="Select trade"
                >
                  {isSelected ? <Check className="w-3 h-3" /> : null}
                </button>
                <span className="text-sm text-gray-300" style={{ fontVariantNumeric: 'tabular-nums' }}>{time}</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isLong ? 'bg-green-500/15 text-green-400' : isShort ? 'bg-red-500/15 text-red-400' : 'bg-gray-700 text-gray-400'}`}>
                  {isLong ? '▲ LONG' : isShort ? '▼ SHORT' : '—'}
                </span>
                <span className="flex-1" />
                {/* Score, Rules and P&L travel together: on a narrow phone with
                    both chips they drop to a second line as one group rather
                    than squeezing the side badge or pushing P&L off the card. */}
                <span className="flex items-center gap-2.5 ml-auto">
                  {grade && grade.score != null && (
                    <GradeChip grade={grade} open={openScoreId === t.id} onToggle={() => setOpenScoreId(openScoreId === t.id ? null : t.id)} />
                  )}
                  <span className={`text-base font-semibold ${pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(pnl)).toLocaleString('en-US')}
                  </span>
                </span>
              </div>
              <div className="px-3 py-2.5">
                {grade && openScoreId === t.id && <TradeGradeDetail grade={grade} neverWent={tradeMgmt(t, { atr: liveAtr, thresholdAtr: giveBackAtr })?.went === false} hasStop={plannedStopPrice(t) != null} />}
                {setup && (
                  <span className="inline-block text-[11px] text-gray-300 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded mb-2">{setup}</span>
                )}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
                  <MobileMetric label="Entry" value={t.entry_price ?? '—'} />
                  <MobileMetric label="Qty" value={t.quantity ?? '—'} />
                  <MobileMetric label="Stop" value={t.stop_price ?? '—'} />
                  {!isCapture && <MobileMetric label="ATR@" value={liveAtr != null ? liveAtr.toFixed(2) : '—'} />}
                  <MobileMetric label="TP1" value={t.tp1_price ?? '—'} />
                  {!isCapture && <MobileMetric label="R" value={r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R${rAtrBased ? '*' : ''}`} valueClass={rCls} />}
                  {!isCapture && <div className="col-span-2"><MobileMetric label="MAE · MFE" value={`${maeMag}${pastStop ? ' past stop' : ''} · ${magLabel(facts?.mfe[mfeUnit], mfeUnit)}`} valueClass={winnerHeat ? 'text-amber-400' : 'text-gray-300'} /></div>}
                  {!isCapture && <MobileMetric label="Kept" value={kept.text} valueClass={kept.cls} />}
                  {/* Post-exit verdict spans both columns — the plain-language label
                      is too long for a half-width cell. */}
                  {!isCapture && <div className="col-span-2">
                    <MobileMetric label="After exit" value={postLabel} valueClass={postCls} />
                  </div>}
                </div>
                {!isCapture && (summary || t.notes?.trim()) && (
                  <p className="mt-2.5 text-xs text-gray-400 leading-snug">{summary ?? t.notes?.trim()}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="hidden md:block overflow-x-auto">
        <table className={`w-full text-xs font-mono ${colWidths ? 'table-fixed' : ''}`}>
          {/* Present only once the trader has dragged something. Until then the
              table keeps auto layout and sizes to its own content. */}
          {colWidths && (
            <colgroup>
              {visibleColIds.map(id => (
                <col key={id} style={colWidths[id] ? { width: `${colWidths[id]}px` } : undefined} />
              ))}
            </colgroup>
          )}
          {/* Sticky header: stays pinned to the top of the viewport as the
              user scrolls through trades. bg-gray-900 (matches the card
              background) so scrolling content doesn't show through. z-20
              is one above the chip's z-10 so the header always wins. */}
          <thead ref={theadRef} className="sticky top-0 bg-gray-900 z-20">
            <tr className="text-gray-500 border-b border-gray-800">
              <th data-col="select" className="font-normal pb-2 pr-2 w-8">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  disabled={sortedTrades.length === 0}
                  aria-label={selectAllTitle}
                  title={selectAllTitle}
                  className="flex items-center justify-center text-gray-500 hover:text-blue-400 disabled:opacity-40 transition-colors"
                >
                  {allSelected
                    ? <CheckSquare className="w-3.5 h-3.5 text-blue-400" />
                    : someSelected
                      ? <MinusSquare className="w-3.5 h-3.5 text-blue-400/70" />
                      : <Square className="w-3.5 h-3.5" />}
                </button>
              </th>
              <SortableHeader label="Time" sortKey="time" align="left" current={sortKey} dir={sortDir} onSort={onSort} colId="time" onResize={startResize} onResetWidths={resetWidths} />
              {/* Setup column replaces the old Dir column. Direction is
                  shown as an inline arrow on the setup chip itself. */}
              <th data-col="setup" className="relative text-left font-normal pb-2 pr-3 whitespace-nowrap overflow-hidden">Setup<ResizeHandle id="setup" onStart={startResize} onReset={resetWidths} /></th>
              {showEntry && <th data-col="entry" className="relative text-right font-normal pb-2 pr-3 whitespace-nowrap overflow-hidden">Entry<ResizeHandle id="entry" onStart={startResize} onReset={resetWidths} /></th>}
              {showStop && <th data-col="stop" className="relative text-right font-normal pb-2 pr-3 whitespace-nowrap overflow-hidden">Stop<ResizeHandle id="stop" onStart={startResize} onReset={resetWidths} /></th>}
              {showTp1 && <th data-col="tp1" className="relative text-right font-normal pb-2 pr-3 whitespace-nowrap overflow-hidden">TP1<ResizeHandle id="tp1" onStart={startResize} onReset={resetWidths} /></th>}
              {showQty && <th data-col="qty" className="relative text-right font-normal pb-2 pr-3 whitespace-nowrap overflow-hidden">Qty<ResizeHandle id="qty" onStart={startResize} onReset={resetWidths} /></th>}
              {showAtr && <SortableHeader label="ATR@" sortKey="atr" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="Live ATR-10 (Wilder) on 1-min bars computed at the trade's entry_time. Reflects volatility at the actual moment of the trade, not the morning prep snapshot." colId="atr" onResize={startResize} onResetWidths={resetWidths} />}
              <SortableHeader label="PnL" sortKey="pnl" align="right" current={sortKey} dir={sortDir} onSort={onSort} colId="pnl" onResize={startResize} onResetWidths={resetWidths} />
              {showScore && <SortableHeader label="Score" sortKey="score" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="This trade's grade: Entry and Exit averaged. Click for every reason." colId="score" onResize={startResize} onResetWidths={resetWidths} />}
              {showR && <SortableHeader label="R" sortKey="r" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="R-multiple: realized PnL / planned risk in dollars. Includes the contract multiplier (so MNQ R is in true risk units)." colId="r" onResize={startResize} onResetWidths={resetWidths} />}
              {showMae && <th data-col="mae" className="relative text-center font-normal pb-2 pr-3 whitespace-nowrap">
                {/* The excursion column, one header centred over it (founder,
                    2026-10-15): MAE at the left end of each bar, MFE at the
                    right, the entry line between them. */}
                <span className="inline-flex items-center justify-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onSort('mae')}
                    className="inline-flex items-center gap-0.5 hover:text-gray-300 transition-colors"
                    title="Sort by MAE (heat taken)"
                  >
                    MAE · MFE <SortIcon col="mae" current={sortKey} dir={sortDir} />
                  </button>
                  <span className="inline-flex items-center gap-1">
                    <select
                      aria-label="Unit"
                      value={mfeUnit}
                      onChange={e => setMfeUnit(e.target.value as MfeUnit)}
                      onClick={e => e.stopPropagation()}
                      className="bg-gray-800 border border-gray-700 text-gray-400 text-[9px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight normal-case tracking-normal"
                      title="Display unit (shared with the Trade management card)"
                    >
                      <option value="atr">×ATR</option>
                      <option value="pts">pts</option>
                      <option value="dollars">$</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => { setMaeOpen(o => !o); setMfeOpen(false) }}
                      className={`transition-colors ${maeOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                      title="What are MAE and MFE?"
                    >
                      <HelpCircle className="w-3 h-3" />
                    </button>
                  </span>
                </span>
                {maeOpen && (
                  <div
                    ref={maeRef}
                    className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal whitespace-normal"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-white">MAE · MFE — how far against you, how far your way</p>
                      <button type="button" onClick={() => setMaeOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mb-2 text-gray-300">
                      The line is your entry. <strong>MAE</strong> (red, left) is the worst point the trade reached; <strong>MFE</strong> (green, right) is the best. The solid part is what you kept (green) or lost (red). Every row shares one scale.
                    </p>
                    <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-400">
                      <li><strong>×ATR</strong> (default): the move ÷ 1 ATR at entry — comparable across days and instruments.</li>
                      <li><strong>pts</strong>: raw price points.</li>
                      <li><strong>$</strong>: points × size × contract multiplier.</li>
                    </ul>
                    <p className="mb-2 text-gray-400">
                      On a <strong>winner</strong>, heat ≥ 1×ATR turns <strong className="text-amber-300">amber</strong> — you won despite a late/lucky entry, worth reviewing. <span className="text-emerald-400">↑</span> = never traded below entry.
                    </p>
                    <p className="text-gray-500">&ldquo;past stop&rdquo; appears when the heat went beyond your planned stop distance.</p>
                  </div>
                )}
              <ResizeHandle id="mae" onStart={startResize} onReset={resetWidths} /></th>}
              {showMfe && <th data-col="mfe" className="relative text-center font-normal pb-2 pr-3 whitespace-nowrap">
                <span className="inline-flex items-center gap-1 justify-center">
                  <button
                    type="button"
                    onClick={() => onSort('mfe')}
                    className="inline-flex items-center gap-0.5 hover:text-gray-300 transition-colors"
                    title="Sort by Kept"
                  >
                    Kept <SortIcon col="mfe" current={sortKey} dir={sortDir} />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMfeOpen(o => !o); setMaeOpen(false) }}
                    className={`transition-colors ${mfeOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                    title="What is Kept?"
                  >
                    <HelpCircle className="w-3 h-3" />
                  </button>
                </span>
                {mfeOpen && (
                  <div
                    ref={mfeRef}
                    className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal whitespace-normal"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-white">Kept (per trade)</p>
                      <button type="button" onClick={() => setMfeOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mb-2 text-gray-300">
                      <em>Of the best point this trade reached, how much did you bank?</em> Shown only for trades that <strong>went your way</strong> — up at least 1×ATR at some point.
                    </p>
                    <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-400">
                      <li><strong>100%</strong>: out at the best price it reached</li>
                      <li><strong>50%</strong>: it ran twice as far as you took</li>
                      <li><strong className="text-red-300">0%</strong>: it went your way, then you gave it all back</li>
                    </ul>
                    <p className="text-gray-500"><strong className="text-gray-400">N/A</strong> means the trade never got 1×ATR your way. There was no exit to grade: that is an entry question.</p>
                  </div>
                )}
              <ResizeHandle id="mfe" onStart={startResize} onReset={resetWidths} /></th>}
              {showPostExit && <th data-col="postExit" className="relative text-left font-normal pb-2 pr-3 whitespace-nowrap" title="What the market did in the 15 min after your last fill. 'stopped' and 'target hit' are the plan running its course, so they say what price did without a verdict. A verdict appears only when you closed the trade by hand.">After exit<ResizeHandle id="postExit" onStart={startResize} onReset={resetWidths} /></th>}
              <th data-col="actions" className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sortedTrades.map(t => {
              const pnl = t.pnl ?? 0
              const isHovered = hoveredTradeId === t.id
              const isFlashing = flashTradeId === t.id
              const isSelected = selectedIds.has(t.id)
              const isNearDup = nearDuplicateIds?.has(t.id) ?? false
              // Row whose edit drawer / inline form is currently open.
              const isEditing = editingId === t.id
              const summary = summaries[t.id]
              // AI overview (or the trader's own notes as fallback) renders as a
              // full-width sub-row under the data row — the old Overview COLUMN
              // collapsed to ~90px at normal window widths and wrapped one word
              // per line, making the flagship AI commentary unreadable.
              const overviewText = summary ?? (t.notes?.trim() || null)
              const overviewIsNotes = !summary && !!t.notes?.trim()
              // Capture (live) never mounts the AI sub-row — the data row keeps
              // its own bottom border instead.
              const hasOverviewRow = !isCapture && (overviewText != null || !!summariesLoading)
              const rowBg = isFlashing ? 'bg-blue-700/40'
                : isEditing ? 'bg-amber-950/20'
                : isSelected ? 'bg-blue-900/30'
                : isHovered ? 'bg-blue-950/30'
                : isNearDup ? 'bg-yellow-950/20'
                : ''
              // The trade's Score (order flow at the fill). Review table only; absent until scored.
              const grade = gradeOf(t)
              return (
                <Fragment key={t.id}>
                <tr
                  id={`${rowIdPrefix}${t.id}`}
                  onMouseEnter={e => onHoverEnter?.(t.id, e)}
                  onMouseLeave={onHoverLeave}
                  onClick={() => rowAction?.(t.id)}
                  // Right-click opens the per-trade menu instead of the browser's.
                  // Wired only when a handler is supplied, so surfaces that don't
                  // offer the menu keep the native one rather than swallowing the
                  // gesture and giving the trader nothing.
                  onContextMenu={onContextMenu ? e => { e.preventDefault(); onContextMenu(t.id, e) } : undefined}
                  title={onEdit ? 'Edit this trade' : "Open this trade's log in the intraday page"}
                  style={{ scrollMarginTop: 80 }}
                  className={`group ${hasOverviewRow ? '' : 'border-b'} transition-colors ${rowAction ? 'cursor-pointer' : 'cursor-default'} ${
                    // Flash spotlight takes precedence: a bright ring + fill so
                    // the jumped-to row is unmistakable, holding until it fades.
                    isFlashing
                      ? 'bg-blue-700/40 ring-2 ring-inset ring-blue-400 border-blue-700'
                      : isEditing
                      ? 'bg-amber-950/20 ring-1 ring-inset ring-amber-700/40 border-amber-900/60'
                      : isSelected
                      ? 'bg-blue-900/30 border-gray-800'
                      : isHovered
                      ? 'bg-blue-950/30 border-gray-800'
                      : isNearDup
                      ? 'bg-yellow-950/20 hover:bg-yellow-950/30 border-gray-800'
                      : 'hover:bg-gray-800/50 border-gray-800'
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
                    {t.entry_time ? ptClockSeconds(t.entry_time) : '--:--:--'}
                  </td>
                  {/* Setup cell — replaces the old Dir column. Direction is
                      encoded as a colored ▲ (long) / ▼ (short) icon at the
                      START of the chip; setup name follows, truncated at
                      ~12ch with hover-tooltip for the full text. Single
                      line. The cap keeps the column tight on the DEFAULT auto
                      layout; once the trader has dragged a width it is dropped,
                      because a fixed cap that ignores the column means widening
                      the column does nothing. */}
                  <td className={`py-1.5 pr-3 whitespace-nowrap ${colWidths ? 'overflow-hidden' : 'max-w-[150px]'}`}>
                    {(() => {
                      const setup = t.tags_json?.setups?.[0]
                      const isLong = t.direction === 'long'
                      const isShort = t.direction === 'short'
                      const arrow = isLong ? '▲' : isShort ? '▼' : '–'
                      const arrowColor = isLong ? 'text-green-400' : isShort ? 'text-red-400' : 'text-gray-500'
                      const tooltipParts = [
                        t.direction?.toUpperCase() ?? '—',
                        t.tags_json?.setups?.join(', ') || '(no setup tagged)',
                      ]
                      return (
                        <>
                          {t.symbol && (
                            <span
                              className={`inline-block align-middle mr-1 text-[9px] font-mono px-1 py-0.5 rounded border ${
                                mixedSymbols
                                  ? 'border-amber-600/70 text-amber-300 bg-amber-950/30'
                                  : 'border-gray-700 text-gray-500 bg-gray-800/60'
                              }`}
                              title={mixedSymbols ? `${t.symbol} — multiple instruments were traded this day` : t.symbol}
                            >
                              {symbolRoot(t.symbol)}
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] bg-gray-800 border border-gray-700 text-gray-300 px-1.5 py-0.5 rounded normal-case align-middle ${colWidths ? 'max-w-full' : 'max-w-[104px]'}`}
                            title={tooltipParts.join(' · ')}
                          >
                            <span className={`${arrowColor} font-bold`}>{arrow}</span>
                            <span className="truncate">{setup ?? '—'}</span>
                          </span>
                        </>
                      )
                    })()}
                  </td>
                  {/* Entry cell — back to single line (price only). Setup
                      now lives in the dedicated column to the left. */}
                  {showEntry && (
                    <td className="py-1.5 pr-3 text-right text-gray-300">
                      {t.entry_price ?? '--'}
                    </td>
                  )}
                  {showStop && <td className="py-1.5 pr-3 text-right text-gray-500">{t.stop_price ?? '--'}</td>}
                  {showTp1 && <td className="py-1.5 pr-3 text-right text-gray-500">{t.tp1_price ?? '--'}</td>}
                  {showQty && <td className="py-1.5 pr-3 text-right text-gray-300">{t.quantity ?? '--'}</td>}
                  {showAtr && (() => {
                    // Prefer live ATR from bars; on the cloud build (no bars) fall
                    // back to the stored entry_atr_1m so the column still populates.
                    const liveAtr = liveAtrByTradeId?.[t.id]
                    const atr = liveAtr ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m ?? null
                    return (
                      <td className="py-1.5 pr-3 text-right text-gray-400" title={liveAtr != null ? `Live ATR-10 (1m Wilder) at this trade's entry_time` : atr != null ? 'Stored ATR-10 (1m Wilder) at entry (bars unavailable in this view)' : 'ATR unavailable'}>
                        {atr != null ? atr.toFixed(2) : '—'}
                      </td>
                    )
                  })()}
                  <td
                    className={`py-1.5 pr-3 text-right font-bold ${
                      pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-500'
                    }`}
                  >
                    {pnl >= 0 ? '+' : ''}
                    {pnl.toFixed(2)}
                  </td>
                  {showScore && (
                    <td className="py-1.5 pr-3 text-right whitespace-nowrap">
                      {grade
                        ? <GradeChip grade={grade} open={openScoreId === t.id} onToggle={() => setOpenScoreId(openScoreId === t.id ? null : t.id)} />
                        : <span className="text-gray-700">—</span>}
                    </td>
                  )}
                  {showR && (() => {
                    const liveAtr = liveAtrByTradeId?.[t.id]
                    const r = rMultiple(t, liveAtr)
                    // Flag when R came from the no-stop/no-TP ATR fallback (R in ATR units)
                    // rather than a planned stop, so the tooltip is honest.
                    const atrBased = r != null && plannedStopPrice(t) == null
                    return (
                      <td className={`py-1.5 pr-3 text-right ${
                        r == null ? 'text-gray-700'
                        : r >= 1 ? 'text-green-400'
                        : r >= 0 ? 'text-green-500'
                        : r >= -0.5 ? 'text-orange-400'
                        : 'text-red-400'
                      }`} title={atrBased
                        ? 'R in ATR units (no stop/TP): PnL ÷ (1 ATR at entry × qty × multiplier).'
                        : 'R = PnL ÷ planned risk (|entry − stop| × qty × multiplier).'}>
                        {r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R${atrBased ? '*' : ''}`}
                      </td>
                    )
                  })()}
                  {/* MAE · MFE, then Kept — the same three facts and the same sort
                      the Trade management card uses, one trade at a time. */}
                  {(() => {
                    const liveAtr = liveAtrByTradeId?.[t.id]
                    const facts = tradeFacts(t, { atr: liveAtr })
                    const kept = keptCell(tradeMgmt(t, { atr: liveAtr, thresholdAtr: giveBackAtr }))
                    const geo = facts
                      ? mgmtBarGeometry({ mfe: facts.mfe[mfeUnit], mae: facts.mae[mfeUnit], result: facts.result[mfeUnit] }, barScale)
                      : null
                    // MAE magnitude ("heat taken"), shown in the active unit (pts / $ /
                    // ×ATR via useMfeUnit). The amber "took heat to win" flag is computed
                    // in ATR regardless of display unit (>=1 ATR on a WINNER = a late/
                    // lucky entry to review); losers stay neutral (adverse is expected
                    // when you're wrong).
                    const xc = mfeMaePoints(t)
                    const maePts = xc?.mae ?? null
                    const atrRef = liveAtr ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m
                    const maeAtr = (maePts != null && atrRef != null && atrRef > 0) ? maePts / atrRef : null
                    const maeMag = maePts == null ? '—'
                      : mfeUnit === 'dollars' ? '$' + Math.round(maePts * (t.quantity ?? 1) * symbolToMultiplier(t.symbol ?? '')).toLocaleString('en-US')
                      : mfeUnit === 'atr' ? (maeAtr == null ? '—' : `${maeAtr.toFixed(1)}×`)
                      : maePts.toFixed(1)
                    const winnerHeat = (t.pnl ?? 0) > 0 && maeAtr != null && maeAtr >= 1
                    const neverAdverse = maePts === 0
                    const pastStop = stopCheck(t, facts)?.past === true
                    return (
                      <>
                        {showMae && (
                          <td className="py-1.5 pr-3 whitespace-nowrap"
                            title={maePts == null ? 'No excursion data for this trade.'
                              : winnerHeat ? `Won but sat through ${maeAtr!.toFixed(1)}×ATR of heat — a late/lucky entry worth reviewing.`
                              : 'MAE (left): the worst point reached. MFE (right): the best. Solid = what you kept or lost.'}>
                            <span className={`flex items-center gap-2 ${colWidths ? '' : 'min-w-[220px]'}`}>
                              <span className={`flex-none w-[46px] text-right ${winnerHeat ? 'text-amber-400 font-bold' : 'text-gray-400'}`}>
                                {maeMag}
                                {neverAdverse && (
                                  <span className="ml-0.5 text-emerald-400" title="Never traded below entry — instantly favorable.">↑</span>
                                )}
                              </span>
                              <span className="relative block flex-1 min-w-0 h-[8px] rounded-[3px] bg-gray-800" aria-hidden="true">
                                {geo && (
                                  <>
                                    <span className="absolute top-0 h-[8px] bg-red-400/30" style={{ left: `${geo.maeLeft}%`, width: `${geo.maeWidth}%` }} />
                                    <span className="absolute top-0 h-[8px] bg-green-400/25" style={{ left: `${geo.zero}%`, width: `${geo.mfeWidth}%` }} />
                                    {geo.solidSide !== 'none' && (
                                      <span
                                        className={`absolute top-0 h-[8px] ${geo.solidSide === 'kept' ? 'bg-green-400' : 'bg-red-400'}`}
                                        style={{ left: `${geo.solidLeft}%`, width: `${geo.solidWidth}%` }}
                                      />
                                    )}
                                    <span className="absolute -top-[3px] h-[14px] w-[2px] bg-gray-200" style={{ left: `${geo.zero}%` }} />
                                  </>
                                )}
                              </span>
                              <span className="flex-none w-[46px] text-left text-gray-400">{magLabel(facts?.mfe[mfeUnit], mfeUnit)}</span>
                            </span>
                            {/* The one heat-vs-stop case that needs saying is the
                                breach, in words rather than a ratio. */}
                            {pastStop && (
                              <span className="block text-center text-[10px] text-red-400 font-semibold"
                                title="Peak adverse excursion went beyond your planned stop distance — the trade was held past its stop.">
                                past stop
                              </span>
                            )}
                          </td>
                        )}
                        {showMfe && (
                          <td className={`py-1.5 pr-3 text-center whitespace-nowrap ${kept.cls}`} title={kept.title}>
                            {kept.text}
                          </td>
                        )}
                      </>
                    )
                  })()}
                  {showPostExit && (() => {
                    const ext = postExitByTradeId?.[t.id]
                    // The plan running its course gets no verdict — a stop-out used
                    // to read "early — recovered…" whenever price bounced in the
                    // next 15 minutes, which it does after most exits of every
                    // kind — but it does say what price did after, in neutral
                    // grey, so there is data on where the target or stop sat
                    // (founder, 2026-10-14).
                    const kind = exitKind(t)
                    if (kind === 'stopped' || kind === 'target') {
                      const read = plannedExitRead(t as VerdictTrade, kind, ext)
                      const partialPlanned = ext != null && ext.full_window === false
                      return (
                        <td className="py-1.5 pr-3 text-left text-gray-400" title={read.title}>
                          <span className={`block truncate ${colWidths ? '' : 'max-w-[15rem]'}`}>
                            {read.label}
                            {partialPlanned && (
                              <span
                                className="ml-1.5 align-middle text-[9px] font-normal text-amber-400/80 border border-amber-700/50 rounded px-1 py-0.5"
                                title="The 15-minute window after the exit hasn't fully elapsed yet — this updates once it does."
                              >
                                partial window
                              </span>
                            )}
                          </span>
                        </td>
                      )
                    }
                    const v = postExitVerdict(t as VerdictTrade, ext)
                    if (!v) return <td className="py-1.5 pr-3 text-left text-gray-700">—</td>
                    // The 15-min post-exit window hasn't fully filled — common
                    // when the session was ended early (Pt 13 step 3). Flag the
                    // verdict as provisional rather than silently under-counting.
                    const partial = ext != null && ext.full_window === false
                    // Left-aligned and width-capped. These verdicts run long
                    // ("stop right — kept rising 181pts") and were nowrap, so the
                    // column grew to fit the longest one, pushed the table past
                    // the viewport, and stranded the header far to the right of
                    // everything else. Truncated, with the full text still in the
                    // cell's tooltip.
                    return (
                      <td className={`py-1.5 pr-3 text-left ${VERDICT_TONE_CLASS[v.tone]}`} title={v.title}>
                        <span className={`block truncate ${colWidths ? '' : 'max-w-[15rem]'}`}>
                          <span className="mr-0.5">{v.glyph}</span>{v.label}
                          {partial && (
                            <span
                              className="ml-1.5 align-middle text-[9px] font-normal text-amber-400/80 border border-amber-700/50 rounded px-1 py-0.5"
                              title="The 15-minute post-exit window hasn't fully elapsed yet — this verdict is provisional and updates once it does."
                            >
                              partial window
                            </span>
                          )}
                        </span>
                      </td>
                    )
                  })()}
                  <td className={`py-1.5 pl-2 text-right${onEdit ? ' whitespace-nowrap' : ''}`}>
                    {/* Per-row edit affordance. Capture opens the inline TradeForm;
                        review opens the recap edit drawer (step 2). Reads
                        "editing…" while this row's editor is open. */}
                    {onEdit && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onEdit(t.id) }}
                        className={`inline-flex items-center gap-1 align-middle text-[10px] border rounded px-1.5 py-0.5 mr-1 transition-colors ${
                          isEditing
                            ? 'text-amber-300 border-amber-600/60 bg-amber-950/40'
                            : 'text-gray-500 hover:text-blue-400 border-gray-700 hover:border-blue-500/60'
                        }`}
                        title="Edit this trade"
                      >
                        <Pencil className="w-3 h-3" /> {isEditing ? 'editing…' : 'edit'}
                      </button>
                    )}
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
                {grade && openScoreId === t.id && (
                  <tr className={`${hasOverviewRow ? '' : 'border-b border-gray-800'} ${rowBg}`}>
                    <td className="pr-2" />
                    <td colSpan={5 + TOGGLEABLE_COLS.filter(c => cols[c.key]).length} className="pr-2">
                      <TradeGradeDetail grade={grade} neverWent={tradeMgmt(t, { atr: liveAtrByTradeId?.[t.id], thresholdAtr: giveBackAtr })?.went === false} hasStop={plannedStopPrice(t) != null} />
                    </td>
                  </tr>
                )}
                {/* Full-width AI-overview sub-row. Mirrors the data row's hover/
                    click behavior so it reads as one unit; carries the bottom
                    border the data row gave up. */}
                {hasOverviewRow && (
                  <tr
                    onMouseEnter={e => onHoverEnter?.(t.id, e)}
                    onMouseLeave={onHoverLeave}
                    onClick={() => rowAction?.(t.id)}
                    className={`border-b border-gray-800 transition-colors ${rowAction ? 'cursor-pointer' : 'cursor-default'} ${rowBg}`}
                  >
                    <td className="pr-2" />
                    <td colSpan={5 + TOGGLEABLE_COLS.filter(c => cols[c.key]).length} className="pb-2 pt-0 pr-2">
                      {overviewText ? (
                        <ClampedNote
                          text={overviewText}
                          italic={overviewIsNotes}
                          title={overviewIsNotes ? 'From your own notes on this trade — AI summary not yet generated.' : undefined}
                        />
                      ) : (
                        <span className="text-gray-600 text-[11px] inline-flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> summarizing…
                        </span>
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
    </div>
  )
}

/** A column header that toggles sort on click; clicking a different column
 *  resets to that column's natural direction. */
/** The grab strip on a header's trailing edge. 12px of hit area, sitting INSIDE
 *  the cell — the first version was 5px and translated past the edge, which the
 *  header's own overflow-hidden promptly clipped, leaving a sliver you had to
 *  hunt for. The visible line stays hairline-thin and only appears on hover;
 *  generous target, quiet affordance. Double-click clears every width and hands
 *  the table back to auto layout. */
function ResizeHandle({ id, onStart, onReset }: {
  id: string
  onStart: (id: string, e: React.PointerEvent<HTMLSpanElement>) => void
  onReset: () => void
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize column"
      onPointerDown={e => onStart(id, e)}
      onDoubleClick={e => { e.stopPropagation(); onReset() }}
      className="group absolute top-0 right-0 h-full w-3 cursor-col-resize select-none touch-none
                 flex justify-end items-stretch z-10"
    >
      <span className="w-[3px] rounded-sm bg-transparent group-hover:bg-blue-500/60 group-active:bg-blue-500 transition-colors" />
    </span>
  )
}

function SortableHeader({
  label, sortKey, align, current, dir, onSort, title, colId, onResize, onResetWidths,
}: {
  label: string
  sortKey: SortKey
  align: 'left' | 'right'
  current: SortKey
  dir: SortDir
  onSort: (k: SortKey) => void
  title?: string
  colId: string
  onResize: (id: string, e: React.PointerEvent<HTMLSpanElement>) => void
  onResetWidths: () => void
}) {
  return (
    <th
      data-col={colId}
      className={`relative ${align === 'left' ? 'text-left' : 'text-right'} font-normal pb-2 pr-3 whitespace-nowrap overflow-hidden`}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-0.5 hover:text-gray-300 transition-colors ${align === 'right' ? 'justify-end' : ''}`}
      >
        {label}
        <SortIcon col={sortKey} current={current} dir={dir} />
      </button>
      <ResizeHandle id={colId} onStart={onResize} onReset={onResetWidths} />
    </th>
  )
}

function SortIcon({ col, current, dir }: { col: SortKey; current: SortKey; dir: SortDir }) {
  if (col !== current) {
    return <ArrowUpDown className="w-2.5 h-2.5 text-gray-700" />
  }
  return dir === 'asc'
    ? <ArrowUp className="w-2.5 h-2.5 text-blue-400" />
    : <ArrowDown className="w-2.5 h-2.5 text-blue-400" />
}

/** One label/value row inside a mobile trade card. */
function MobileMetric({ label, value, valueClass }: { label: string; value: string | number; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-gray-800/50 pb-1">
      <span className="text-gray-500 text-xs">{label}</span>
      <span className={valueClass ?? 'text-gray-300'} style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
