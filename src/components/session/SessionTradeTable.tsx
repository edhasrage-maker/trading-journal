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
import { format } from 'date-fns'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Trash2, Loader2, HelpCircle, X, Columns3, Pencil, CheckSquare, Square, MinusSquare } from 'lucide-react'
import { captureRatio, captureRatioScaled, maeHeatRatio, isGiveBackTrade, rMultiple, mfeMaePoints, formatCapturePct, exitedAtExtreme, CAPTURE_AT_EXTREME_TOOLTIP, type BarLike } from '@/lib/analytics'
import { symbolRoot, symbolToMultiplier } from '@/lib/futures-symbols'
import { postExitVerdict, type VerdictTrade, type VerdictTone } from '@/lib/post-exit-verdict'
import { useMfeUnit, type MfeUnit } from '@/lib/mfe-unit'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import type { Trade } from '@/lib/supabase/types'

type SortKey = 'time' | 'atr' | 'pnl' | 'r' | 'mfe' | 'mae'
type SortDir = 'asc' | 'desc'

// Optional columns the user can show/hide in the Detailed (Pro) view. Core
// columns — checkbox, Time, Setup, Entry, PnL, Overview — are always shown.
// The choice is persisted per-device in localStorage.
const TOGGLEABLE_COLS = [
  { key: 'stop', label: 'Stop' },
  { key: 'tp1', label: 'TP1' },
  { key: 'qty', label: 'Qty' },
  { key: 'atr', label: 'ATR@' },
  { key: 'r', label: 'R' },
  { key: 'mfe', label: 'MFE %' },
  { key: 'mae', label: 'MAE %' },
  { key: 'postExit', label: 'Post-Exit' },
] as const
type ColKey = (typeof TOGGLEABLE_COLS)[number]['key']
const COLS_STORAGE_KEY = 'eod-trade-cols-v1'

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

/** Display capture % per trade — uses the same null-handling as the intraday row.
 *  When bars are provided, prefers the per-leg scaling-aware ratio so a scaled-
 *  out trade isn't graded against an impossible-to-hold full-qty peak. */
function captureDisplay(t: Trade, bars?: BarLike[]): string | null {
  const r = (bars && bars.length > 0 ? captureRatioScaled(t, bars) : null) ?? captureRatio(t)
  // Invariant guard: bank-more-than-the-peak is impossible. A ratio past 100+ε
  // is a data mismatch — show "—", never the raw (e.g. 218%) number. An exit AT
  // the trade's own extreme gets the wider bound: that trade is PINNED at 100%
  // by definition, so a point of fill-vs-logged-price rounding was blanking the
  // best exits in the book.
  if (r != null) return formatCapturePct(r, { exitedAtExtreme: exitedAtExtreme(t) }) ?? '—'
  // Capture came back null. For a LOSS or scratch that is a real 0% captured —
  // the trade gave back whatever green it briefly showed — so "0%" beats a bare
  // "—", and it mirrors captureRatio's floor-at-0.
  //
  // A WINNER is a different case and must NOT print 0%. captureRatio also
  // returns null when MFE sits under the noise floor (< 0.5 × entry ATR), and a
  // profitable trade there did not capture zero of its move — it banked money.
  // Printing "0%" on a +$330 trade states the opposite of what happened, so it
  // falls through to "—": the ratio is unavailable, not zero.
  const hasInputs = t.pnl != null && t.quantity != null && t.entry_price != null && mfeMaePoints(t) != null
  if (hasInputs && (t.pnl ?? 0) <= 0) return '0%'
  return null
}

/** Why capture is blank, for the cell tooltip — a bare "—" should never leave
 *  the reader wondering whether the number is missing or the product is broken.
 *  Null when capture rendered a value (no explanation needed). */
function captureBlankReason(t: Trade, bars?: BarLike[]): string | null {
  const shown = captureDisplay(t, bars)
  if (shown != null && shown !== '—') return null
  // Ratio computed but out of bounds. This is the one blank that points at a
  // DATA problem rather than a metric that doesn't apply, so name it — banking
  // more than the move ever offered is impossible, and the usual cause is a
  // wrong entry price or a mis-stamped entry time.
  const r = (bars && bars.length > 0 ? captureRatioScaled(t, bars) : null) ?? captureRatio(t)
  if (r != null) {
    return `Capture came out at ${Math.round(r * 100)}%, which can't happen — you can't bank more than the best the move offered. Your P&L and the market data for this trade disagree, usually a wrong entry price or an entry time stamped to the minute.`
  }
  if (t.pnl == null || t.quantity == null || t.entry_price == null) {
    return 'Capture needs entry price, quantity and P&L on this trade.'
  }
  const xc = mfeMaePoints(t)
  if (xc == null) return 'No MFE/MAE data for this trade yet, so capture can\'t be computed.'
  const atr = (t as Trade & { entry_atr_1m?: number | null }).entry_atr_1m
  if (atr != null && atr > 0 && xc.mfe < atr * 0.5) {
    return `The move never cleared half an ATR (${xc.mfe.toFixed(2)} pts vs ${(atr * 0.5).toFixed(2)}), so a capture ratio here would be noise rather than a read on your exit.`
  }
  return 'Capture is unavailable for this trade.'
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
  /** Per-trade post-exit continuation @30m — how much further the market went after the trade closed. Powers the "Post-Exit" column. */
  postExitByTradeId?: Record<string, import('@/lib/atr').PostExitData>
  /** 1-minute bars for the day. When provided, the per-row MFE Realized %
   *  uses the scaling-aware capture calc (walks exits_json + finds the
   *  per-leg peak between scale-outs). When omitted, falls back to the
   *  simple peak × full-qty formula so the column still renders. */
  bars?: BarLike[] | null
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
  postExitByTradeId,
  bars,
}: Props) {
  // Capture (live Intraday) vs review (EOD recap). Every judgment column and the
  // AI sub-rows are gated OFF in capture; the review path evaluates exactly as
  // before so its render stays byte-identical.
  const isCapture = config === 'capture'
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
        case 'r':
          return rMultiple(t, liveAtrByTradeId?.[t.id]) ?? Number.NEGATIVE_INFINITY
        case 'mfe':
          return ((bars && bars.length > 0 ? captureRatioScaled(t, bars) : null) ?? captureRatio(t)) ?? Number.NEGATIVE_INFINITY
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
  }, [trades, sortKey, sortDir, liveAtrByTradeId, bars])

  // Click-to-toggle popups for the MFE % / MAE % column definitions. Same
  // dashboard-style popup pattern as the EOD header — click outside / Esc to
  // dismiss. Pinned top-right of the viewport so they don't push the table.
  const [mfeOpen, setMfeOpen] = useState(false)
  const [maeOpen, setMaeOpen] = useState(false)
  const mfeRef = useRef<HTMLDivElement>(null)
  const maeRef = useRef<HTMLDivElement>(null)

  // User-toggleable columns. Init to all-visible (safe for SSR), then hydrate the
  // saved per-device choice from localStorage after mount.
  const [cols, setCols] = useState<Record<ColKey, boolean>>(defaultColPrefs)
  const [colsOpen, setColsOpen] = useState(false)
  // Effective per-column visibility. Capture pins Stop/TP1/Qty on and hides
  // every score/verdict column; review defers to `cols` exactly as before, so
  // its output is unchanged.
  const showStop = isCapture ? true : cols.stop
  const showTp1 = isCapture ? true : cols.tp1
  const showQty = isCapture ? true : cols.qty
  const showAtr = isCapture ? false : cols.atr
  const showR = isCapture ? false : cols.r
  const showMfe = isCapture ? false : cols.mfe
  const showMae = isCapture ? false : cols.mae
  const showPostExit = isCapture ? false : cols.postExit

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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
        {LOCAL_FEATURES_ENABLED ? (
          'No trades yet. Use the intraday tagging flow or import a trade log to populate this day.'
        ) : (
          <>
            No trades yet.{' '}
            <Link href="/import" className="text-blue-400 hover:underline">Import trade log</Link>
            {' '}or log one on the Intraday page to populate this day.
          </>
        )}
      </div>
    )
  }

  // Beginner: a simple plain list — time · direction · setup · result, with the
  // AI overview note. No R / MFE% / MAE% / ATR / post-exit columns.
  if (mode === 'beginner') {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-3 text-sm" style={{ fontFamily: 'var(--font-display)' }}>Trades ({trades.length})</h2>
        <div className="divide-y divide-gray-800">
          {sortedTrades.map(t => {
            const setup = ((t.tags_json as unknown as { setups?: string[] } | null)?.setups ?? [])[0]
            const pnl = t.pnl
            const time = t.entry_time ? format(new Date(t.entry_time), 'h:mm a') : '--'
            const summary = summaries[t.id]
            // Same fallback as the pro table: the trader's own note stands in
            // until an AI overview exists (or when it can't be generated, e.g.
            // the read-only demo account).
            const overviewText = summary ?? (t.notes?.trim() || null)
            const overviewIsNotes = !summary && !!t.notes?.trim()
            const isLong = t.direction === 'long'
            return (
              <div
                key={t.id}
                className={`py-3 ${rowAction ? 'cursor-pointer hover:bg-gray-800/40 -mx-2 px-2 rounded-lg' : ''}`}
                onClick={rowAction ? () => rowAction(t.id) : undefined}
              >
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isLong ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>{isLong ? 'LONG' : 'SHORT'}</span>
                  <span className="text-sm text-gray-300 tabular-nums">{time}</span>
                  {setup && <span className="text-xs text-gray-500 truncate">{setup}</span>}
                  <span className="flex-1" />
                  <span className={`text-sm font-semibold ${(pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {pnl == null ? '--' : `${pnl < 0 ? '-' : '+'}$${Math.abs(Math.round(pnl)).toLocaleString()}`}
                  </span>
                </div>
                {overviewText && (
                  <p
                    className={`text-xs text-gray-500 mt-1.5 leading-snug ${overviewIsNotes ? 'italic' : ''}`}
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
          const time = t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'
          const summary = summaries[t.id]
          const liveAtr = liveAtrByTradeId?.[t.id]
          const r = rMultiple(t, liveAtr)
          const rAtrBased = r != null && t.stop_price == null
          const rCls = r == null ? 'text-gray-600' : r >= 1 ? 'text-green-400' : r >= 0 ? 'text-green-500' : r >= -0.5 ? 'text-orange-400' : 'text-red-400'
          const xc = mfeMaePoints(t)
          const maePts = xc?.mae ?? null
          const atrRef = liveAtr ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m
          const maeAtr = (maePts != null && atrRef != null && atrRef > 0) ? maePts / atrRef : null
          const maeMag = maePts == null ? '—'
            : mfeUnit === 'dollars' ? '$' + Math.round(maePts * (t.quantity ?? 1) * symbolToMultiplier(t.symbol ?? '')).toLocaleString()
            : mfeUnit === 'atr' ? (maeAtr == null ? '—' : `${maeAtr.toFixed(1)}×`)
            : maePts.toFixed(1)
          const winnerHeat = (t.pnl ?? 0) > 0 && maeAtr != null && maeAtr >= 1
          const stopHeat = t.stop_price != null ? maeHeatRatio(t) : null
          const postVerdict = postExitVerdict(t as VerdictTrade, postExitByTradeId?.[t.id])
          const postLabel = postVerdict ? `${postVerdict.glyph} ${postVerdict.label}` : '—'
          const postCls = postVerdict ? VERDICT_TONE_CLASS[postVerdict.tone] : 'text-gray-600'
          return (
            <div
              key={t.id}
              onClick={() => rowAction?.(t.id)}
              className={`rounded-xl border overflow-hidden ${isSelected ? 'border-blue-600 bg-blue-950/20' : 'border-gray-800 bg-gray-950/40'}`}
            >
              <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-gray-800/70">
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
                <span className={`text-base font-semibold ${pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {pnl >= 0 ? '+' : '−'}${Math.abs(Math.round(pnl)).toLocaleString()}
                </span>
              </div>
              <div className="px-3 py-2.5">
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
                  {!isCapture && <MobileMetric label="MFE" value={captureDisplay(t, bars ?? undefined) ?? '—'} />}
                  {!isCapture && <MobileMetric label="MAE" value={maeMag + (stopHeat != null ? ` · ${Math.round(Math.max(0, stopHeat) * 100)}%` : '')} valueClass={winnerHeat ? 'text-amber-400' : 'text-gray-300'} />}
                  {/* Post-exit verdict spans both columns — the plain-language label
                      is too long for a half-width cell. */}
                  {!isCapture && <div className="col-span-2">
                    <MobileMetric label="Post-Exit" value={postLabel} valueClass={postCls} />
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
        <table className="w-full text-xs font-mono">
          {/* Sticky header: stays pinned to the top of the viewport as the
              user scrolls through trades. bg-gray-900 (matches the card
              background) so scrolling content doesn't show through. z-20
              is one above the chip's z-10 so the header always wins. */}
          {/* top comes from --eod-sticky-h so this rests just under the EOD
              recap bar when that is pinned. Defaults to 0 everywhere else
              (Intraday sets no variable), preserving the old behaviour. */}
          <thead className="sticky bg-gray-900 z-20" style={{ top: 'var(--eod-sticky-h, 0px)' }}>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="font-normal pb-2 pr-2 w-8">
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
              <SortableHeader label="Time" sortKey="time" align="left" current={sortKey} dir={sortDir} onSort={onSort} />
              {/* Setup column replaces the old Dir column. Direction is
                  shown as an inline arrow on the setup chip itself. */}
              <th className="text-left font-normal pb-2 pr-3 whitespace-nowrap">Setup</th>
              <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">Entry</th>
              {showStop && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">Stop</th>}
              {showTp1 && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">TP1</th>}
              {showQty && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">Qty</th>}
              {showAtr && <SortableHeader label="ATR@" sortKey="atr" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="Live ATR-10 (Wilder) on 1-min bars computed at the trade's entry_time. Reflects volatility at the actual moment of the trade, not the morning prep snapshot." />}
              <SortableHeader label="PnL" sortKey="pnl" align="right" current={sortKey} dir={sortDir} onSort={onSort} />
              {showR && <SortableHeader label="R" sortKey="r" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="R-multiple: realized PnL / planned risk in dollars. Includes the contract multiplier (so MNQ R is in true risk units)." />}
              {showMfe && <th className="text-center font-normal pb-2 pr-3 whitespace-nowrap">
                {/* Centered rather than right-aligned: the header carries a sort
                    control and an info icon, so right-aligning parked the short
                    values ("0%", "100%") under the icon instead of under the
                    label they belong to. */}
                <span className="inline-flex items-center gap-1 justify-center">
                  <button
                    type="button"
                    onClick={() => onSort('mfe')}
                    className="inline-flex items-center gap-0.5 hover:text-gray-300 transition-colors"
                    title="Sort by MFE %"
                  >
                    MFE % <SortIcon col="mfe" current={sortKey} dir={sortDir} />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMfeOpen(o => !o); setMaeOpen(false) }}
                    className={`transition-colors ${mfeOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                    title="What is MFE %?"
                  >
                    <HelpCircle className="w-3 h-3" />
                  </button>
                </span>
                {mfeOpen && (
                  <div
                    ref={mfeRef}
                    className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-white">MFE % (per-trade)</p>
                      <button type="button" onClick={() => setMfeOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mb-2 text-gray-300">
                      <em>How much of the favorable move did you actually book on this trade?</em>
                    </p>
                    <p className="mb-2 text-gray-400">
                      = realized PnL ÷ peak favorable excursion (in $) — bounded by entry → exit, so it measures execution <em>while you held</em>.
                    </p>
                    <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-400">
                      <li><strong>100%</strong>: exited at the high — perfect timing</li>
                      <li><strong>50%</strong>: trade ran +2R, you took +1R — cut a runner</li>
                      <li><strong>0% or negative</strong>: <strong className="text-red-300">give-back</strong> — went green then closed at a loss</li>
                    </ul>
                    <p className="text-gray-500">Bolded when the trade was a give-back (MFE ≥ 1R favorable then closed red).</p>
                  </div>
                )}
              </th>}
              {showMae && <th className="text-center font-normal pb-2 pr-3 whitespace-nowrap">
                {/* Unit dropdown stacked ABOVE the MAE label so the column stays
                    narrow (was a single wide inline row: MAE · ×ATR · ?).
                    Centered to match MFE % — both are short numeric columns
                    under headers wide enough that right-aligning parked the
                    values under the controls instead of under the labels. */}
                <span className="inline-flex flex-col items-center gap-0.5">
                  <select
                    value={mfeUnit}
                    onChange={e => setMfeUnit(e.target.value as MfeUnit)}
                    onClick={e => e.stopPropagation()}
                    className="bg-gray-800 border border-gray-700 text-gray-400 text-[9px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight normal-case tracking-normal"
                    title="Heat display unit (shared with the dashboard)"
                  >
                    <option value="atr">×ATR</option>
                    <option value="pts">pts</option>
                    <option value="dollars">$</option>
                  </select>
                  <span className="inline-flex items-center gap-1 justify-center">
                    <button
                      type="button"
                      onClick={() => onSort('mae')}
                      className="inline-flex items-center gap-0.5 hover:text-gray-300 transition-colors"
                      title="Sort by MAE (heat taken)"
                    >
                      MAE <SortIcon col="mae" current={sortKey} dir={sortDir} />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMaeOpen(o => !o); setMfeOpen(false) }}
                      className={`transition-colors ${maeOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                      title="What is MAE?"
                    >
                      <HelpCircle className="w-3 h-3" />
                    </button>
                  </span>
                </span>
                {maeOpen && (
                  <div
                    ref={maeRef}
                    className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-white">MAE — heat taken</p>
                      <button type="button" onClick={() => setMaeOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="mb-2 text-gray-300">
                      <em>How far did the trade go against you before it resolved?</em> Peak adverse excursion from entry, in your chosen unit:
                    </p>
                    <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-400">
                      <li><strong>×ATR</strong> (default): heat ÷ 1 ATR at entry — comparable across days and instruments. 1.7× = you sat through 1.7 ATRs of heat.</li>
                      <li><strong>pts</strong>: raw price points against you.</li>
                      <li><strong>$</strong>: points × size × contract multiplier.</li>
                    </ul>
                    <p className="mb-2 text-gray-400">
                      On a <strong>winner</strong>, heat ≥ 1×ATR turns <strong className="text-amber-300">amber</strong> — you won despite a late/lucky entry, worth reviewing. Losers stay neutral (adverse movement is expected when you&apos;re wrong). <span className="text-emerald-400">↑</span> = never traded below entry.
                    </p>
                    <p className="text-gray-500">If the trade has a planned stop, a small <span className="text-gray-400">· NN%</span> shows heat as a % of that stop — over 100% means you held past it.</p>
                  </div>
                )}
              </th>}
              {showPostExit && <th className="text-left font-normal pb-2 pr-3 whitespace-nowrap" title="Was your exit well-timed? A plain-language verdict from what the market did in the 30 min after you were out — 'exit right' (it reversed once you left), 'early' (it kept running your way — money left on the table), 'stop right' (a loss that kept going against you), or 'gave it back' (you had a real winner before it turned red).">Post-Exit</th>}
              <th className="w-8" />
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
                    {t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'}
                  </td>
                  {/* Setup cell — replaces the old Dir column. Direction is
                      encoded as a colored ▲ (long) / ▼ (short) icon at the
                      START of the chip; setup name follows, truncated at
                      ~12ch with hover-tooltip for the full text. Single
                      line, max-w-[120px] to keep the column tight so the
                      Overview column has room to breathe. */}
                  <td className="py-1.5 pr-3 max-w-[150px] whitespace-nowrap">
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
                            className="inline-flex items-center gap-1 text-[10px] bg-gray-800 border border-gray-700 text-gray-300 px-1.5 py-0.5 rounded normal-case max-w-[104px] align-middle"
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
                  <td className="py-1.5 pr-3 text-right text-gray-300">
                    {t.entry_price ?? '--'}
                  </td>
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
                  {showR && (() => {
                    const liveAtr = liveAtrByTradeId?.[t.id]
                    const r = rMultiple(t, liveAtr)
                    // Flag when R came from the no-stop/no-TP ATR fallback (R in ATR units)
                    // rather than a planned stop, so the tooltip is honest.
                    const atrBased = r != null && t.stop_price == null
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
                  {/* Cap and Loss render first, then Post-Exit Continuation. Post-Exit
                      asks "after I exited, how much further did the move keep going in my
                      direction?" — compared to what you captured, expressed as a % "extra
                      leg" you could have taken. */}
                  {/* Cap and Loss: same per-trade math as the intraday row chip.
                      Bold marks high-signal cross-cases that deserve attention
                      on review (give-back loser, lucky-escape winner). */}
                  {(() => {
                    const isGiveBack = isGiveBackTrade(t)
                    const capCls = isGiveBack ? 'text-red-400 font-bold' : 'text-gray-400'
                    // MAE magnitude ("heat taken"), shown in the active unit (pts / $ /
                    // ×ATR via useMfeUnit). The amber "took heat to win" flag is computed
                    // in ATR regardless of display unit (>=1 ATR on a WINNER = a late/
                    // lucky entry to review); losers stay neutral (adverse is expected
                    // when you're wrong). When a planned stop exists we ALSO append heat
                    // as % of that stop (answers "held past my stop?"; red over 100%).
                    const xc = mfeMaePoints(t)
                    const maePts = xc?.mae ?? null
                    const atrRef = liveAtrByTradeId?.[t.id] ?? (t as { entry_atr_1m?: number | null }).entry_atr_1m
                    const maeAtr = (maePts != null && atrRef != null && atrRef > 0) ? maePts / atrRef : null
                    const maeMag = maePts == null ? '—'
                      : mfeUnit === 'dollars' ? '$' + Math.round(maePts * (t.quantity ?? 1) * symbolToMultiplier(t.symbol ?? '')).toLocaleString()
                      : mfeUnit === 'atr' ? (maeAtr == null ? '—' : `${maeAtr.toFixed(1)}×`)
                      : maePts.toFixed(1)
                    const winnerHeat = (t.pnl ?? 0) > 0 && maeAtr != null && maeAtr >= 1
                    const neverAdverse = maePts === 0
                    const stopHeat = t.stop_price != null ? maeHeatRatio(t) : null
                    return (
                      <>
                        {showMfe && (
                          <td className={`py-1.5 pr-3 text-center ${capCls}`}
                            title={
                              isGiveBack ? 'Give-back: trade had MFE >= 1R favorable then closed at a loss.'
                                // A perfect exit reads 100% only because it's clamped there —
                                // say so, or it looks like a suspiciously round number.
                                : exitedAtExtreme(t) ? CAPTURE_AT_EXTREME_TOOLTIP
                                // Say WHY the cell is blank — an unexplained em-dash
                                // reads as a broken product rather than a metric
                                // that honestly doesn't apply to this trade.
                                : captureBlankReason(t, bars ?? undefined) ?? undefined
                            }>
                            {captureDisplay(t, bars ?? undefined) ?? '—'}
                          </td>
                        )}
                        {showMae && (
                          <td className="py-1.5 pr-3 text-center whitespace-nowrap"
                            title={maePts == null ? 'Heat unavailable — no excursion data for this trade.'
                              : winnerHeat ? `Won but sat through ${maeAtr!.toFixed(1)}×ATR of heat — a late/lucky entry worth reviewing.`
                              : `Max adverse excursion (heat taken).${(t.pnl ?? 0) <= 0 ? ' Adverse movement is expected on a losing trade.' : ''}`}>
                            <span className={winnerHeat ? 'text-amber-400 font-bold' : 'text-gray-400'}>{maeMag}</span>
                            {neverAdverse && (
                              <span className="ml-1 text-emerald-400" title="Never traded below entry — instantly favorable.">↑</span>
                            )}
                            {stopHeat != null && (
                              <span className={`ml-1 text-[10px] ${stopHeat > 1 ? 'text-red-400 font-semibold' : 'text-gray-600'}`}
                                title="Peak adverse as % of your planned stop distance. Over 100% = you held past your stop.">
                                · {Math.round(Math.max(0, stopHeat) * 100)}%
                              </span>
                            )}
                          </td>
                        )}
                      </>
                    )
                  })()}
                  {showPostExit && (() => {
                    const ext = postExitByTradeId?.[t.id]
                    const v = postExitVerdict(t as VerdictTrade, ext)
                    if (!v) return <td className="py-1.5 pr-3 text-left text-gray-700">—</td>
                    // The 30-min post-exit window hasn't fully filled — common
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
                        <span className="block max-w-[15rem] truncate">
                          <span className="mr-0.5">{v.glyph}</span>{v.label}
                          {partial && (
                            <span
                              className="ml-1.5 align-middle text-[9px] font-normal text-amber-400/80 border border-amber-700/50 rounded px-1 py-0.5"
                              title="The 30-minute post-exit window hasn't fully elapsed yet — this verdict is provisional and updates once it does."
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
function SortableHeader({
  label, sortKey, align, current, dir, onSort, title,
}: {
  label: string
  sortKey: SortKey
  align: 'left' | 'right'
  current: SortKey
  dir: SortDir
  onSort: (k: SortKey) => void
  title?: string
}) {
  return (
    <th
      className={`${align === 'left' ? 'text-left' : 'text-right'} font-normal pb-2 pr-3 whitespace-nowrap`}
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
