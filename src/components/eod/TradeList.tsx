'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Trash2, Loader2, HelpCircle, X, Columns3 } from 'lucide-react'
import { captureRatio, captureRatioScaled, maeHeatRatio, isGiveBackTrade, rMultiple, mfeMaePoints, type BarLike } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'
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
  if (r == null) return null
  return `${Math.max(-999, Math.min(999, r * 100)).toFixed(0)}%`
}

interface Props {
  trades: Trade[]
  hoveredTradeId: string | null
  /** Row to spotlight briefly after a jump (chart double-click / deep-link).
   *  Distinct from hoveredTradeId — a prominent ring that persists ~2s so the
   *  user can see which trade the chart scrolled to. */
  flashTradeId?: string | null
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
  /** 1-minute bars for the day. When provided, the per-row MFE Realized %
   *  uses the scaling-aware capture calc (walks exits_json + finds the
   *  per-leg peak between scale-outs). When omitted, falls back to the
   *  simple peak × full-qty formula so the column still renders. */
  bars?: BarLike[] | null
}

export default function TradeList({
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
  summaries = {},
  summariesLoading = false,
  liveAtrByTradeId,
  postExitByTradeId,
  bars,
}: Props) {
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
            const isLong = t.direction === 'long'
            return (
              <div
                key={t.id}
                className={`py-3 ${onRowOpen ? 'cursor-pointer hover:bg-gray-800/40 -mx-2 px-2 rounded-lg' : ''}`}
                onClick={onRowOpen ? () => onRowOpen(t.id) : undefined}
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
                {summary && <p className="text-xs text-gray-500 mt-1.5 leading-snug">{summary}</p>}
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
        <div className="relative hidden md:block" ref={colsRef}>
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
        </div>
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
            <option value="r">R</option>
            <option value="mfe">MFE</option>
            <option value="mae">MAE</option>
            <option value="pnl">P&amp;L</option>
            <option value="atr">ATR@</option>
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
          const ext = postExitByTradeId?.[t.id]
          let postLabel = '—'
          let postCls = 'text-gray-600'
          if (ext) {
            const capturedPts = (t.entry_price != null && t.exit_price != null)
              ? (isLong ? t.exit_price - t.entry_price : t.entry_price - t.exit_price) : null
            const cont = ext.continued_favorable_pts
            const against = ext.continued_against_pts
            if (cont > against) {
              const pct = (capturedPts != null && capturedPts > 0) ? Math.round((cont / capturedPts) * 100) : null
              postLabel = `+${cont.toFixed(1)} pts${pct != null ? ` (${pct}%)` : ''}`
              postCls = cont >= 3 ? 'text-green-400' : 'text-yellow-400'
            } else if (against > 0.1) {
              postLabel = `−${against.toFixed(1)} pts`
              postCls = 'text-red-400'
            }
          }
          return (
            <div
              key={t.id}
              onClick={() => onRowOpen?.(t.id)}
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
                  <MobileMetric label="ATR@" value={liveAtr != null ? liveAtr.toFixed(2) : '—'} />
                  <MobileMetric label="TP1" value={t.tp1_price ?? '—'} />
                  <MobileMetric label="R" value={r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R${rAtrBased ? '*' : ''}`} valueClass={rCls} />
                  <MobileMetric label="MFE" value={captureDisplay(t, bars ?? undefined) ?? '—'} />
                  <MobileMetric label="MAE" value={maeMag + (stopHeat != null ? ` · ${Math.round(Math.max(0, stopHeat) * 100)}%` : '')} valueClass={winnerHeat ? 'text-amber-400' : 'text-gray-300'} />
                  <MobileMetric label="Post-Exit" value={postLabel} valueClass={postCls} />
                </div>
                {(summary || t.notes?.trim()) && (
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
          <thead className="sticky top-0 bg-gray-900 z-20">
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="font-normal pb-2 pr-2 w-8" />
              <SortableHeader label="Time" sortKey="time" align="left" current={sortKey} dir={sortDir} onSort={onSort} />
              {/* Setup column replaces the old Dir column. Direction is
                  shown as an inline arrow on the setup chip itself. */}
              <th className="text-left font-normal pb-2 pr-3 whitespace-nowrap">Setup</th>
              <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">Entry</th>
              {cols.stop && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">Stop</th>}
              {cols.tp1 && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">TP1</th>}
              {cols.qty && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">Qty</th>}
              {cols.atr && <SortableHeader label="ATR@" sortKey="atr" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="Live ATR-10 (Wilder) on 1-min bars computed at the trade's entry_time. Reflects volatility at the actual moment of the trade, not the morning prep snapshot." />}
              <SortableHeader label="PnL" sortKey="pnl" align="right" current={sortKey} dir={sortDir} onSort={onSort} />
              {cols.r && <SortableHeader label="R" sortKey="r" align="right" current={sortKey} dir={sortDir} onSort={onSort} title="R-multiple: realized PnL / planned risk in dollars. Includes the contract multiplier (so MNQ R is in true risk units)." />}
              {cols.mfe && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">
                <span className="inline-flex items-center gap-1 justify-end">
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
              {cols.mae && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap">
                <span className="inline-flex items-center gap-1 justify-end">
                  <button
                    type="button"
                    onClick={() => onSort('mae')}
                    className="inline-flex items-center gap-0.5 hover:text-gray-300 transition-colors"
                    title="Sort by MAE (heat taken)"
                  >
                    MAE <SortIcon col="mae" current={sortKey} dir={sortDir} />
                  </button>
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
                  <button
                    type="button"
                    onClick={() => { setMaeOpen(o => !o); setMfeOpen(false) }}
                    className={`transition-colors ${maeOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                    title="What is MAE?"
                  >
                    <HelpCircle className="w-3 h-3" />
                  </button>
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
              {cols.postExit && <th className="text-right font-normal pb-2 pr-3 whitespace-nowrap" title="Post-Exit Continuation @30m: how much further the market moved in your trade direction in the 30 minutes after your exit. Format: '+8 pts (18%)' = 8 pts of further favorable move, which is 18% of what you captured. Positive numbers mean you could have ridden it longer; em-dash means the move reversed against you after exit.">Post-Exit</th>}
              <th className="text-left font-normal pb-2 whitespace-nowrap">Overview</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {sortedTrades.map(t => {
              const pnl = t.pnl ?? 0
              const isHovered = hoveredTradeId === t.id
              const isFlashing = flashTradeId === t.id
              const isSelected = selectedIds.has(t.id)
              const isNearDup = nearDuplicateIds.has(t.id)
              const summary = summaries[t.id]
              return (
                <tr
                  key={t.id}
                  id={`eod-trade-${t.id}`}
                  onMouseEnter={e => onHoverEnter(t.id, e)}
                  onMouseLeave={onHoverLeave}
                  onClick={() => onRowOpen?.(t.id)}
                  title="Open this trade's log in the intraday page"
                  style={{ scrollMarginTop: 80 }}
                  className={`group border-b transition-colors ${onRowOpen ? 'cursor-pointer' : 'cursor-default'} ${
                    // Flash spotlight takes precedence: a bright ring + fill so
                    // the jumped-to row is unmistakable, holding until it fades.
                    isFlashing
                      ? 'bg-blue-700/40 ring-2 ring-inset ring-blue-400 border-blue-700'
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
                  <td className="py-1.5 pr-3 max-w-[120px]">
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
                        <span
                          className="inline-flex items-center gap-1 text-[10px] bg-gray-800 border border-gray-700 text-gray-300 px-1.5 py-0.5 rounded normal-case max-w-full"
                          title={tooltipParts.join(' · ')}
                        >
                          <span className={`${arrowColor} font-bold`}>{arrow}</span>
                          <span className="truncate">{setup ?? '—'}</span>
                        </span>
                      )
                    })()}
                  </td>
                  {/* Entry cell — back to single line (price only). Setup
                      now lives in the dedicated column to the left. */}
                  <td className="py-1.5 pr-3 text-right text-gray-300">
                    {t.entry_price ?? '--'}
                  </td>
                  {cols.stop && <td className="py-1.5 pr-3 text-right text-gray-500">{t.stop_price ?? '--'}</td>}
                  {cols.tp1 && <td className="py-1.5 pr-3 text-right text-gray-500">{t.tp1_price ?? '--'}</td>}
                  {cols.qty && <td className="py-1.5 pr-3 text-right text-gray-300">{t.quantity ?? '--'}</td>}
                  {cols.atr && (() => {
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
                  {cols.r && (() => {
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
                        {cols.mfe && (
                          <td className={`py-1.5 pr-3 text-right ${capCls}`}
                            title={isGiveBack ? 'Give-back: trade had MFE >= 1R favorable then closed at a loss.' : undefined}>
                            {captureDisplay(t, bars ?? undefined) ?? '—'}
                          </td>
                        )}
                        {cols.mae && (
                          <td className="py-1.5 pr-3 text-right whitespace-nowrap"
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
                  {cols.postExit && (() => {
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
                    {/* Overview column priority:
                          1. AI-generated summary if /api/trades/summary
                             produced one for this trade.
                          2. Trader's own typed notes (t.notes) — fallback so
                             the cell isn't blank when the AI summary is
                             missing. Notes are the most authoritative source
                             anyway; better to show them than render "—"
                             while the trader's actual context sits unused.
                          3. "summarizing…" indicator while AI is still
                             running on the rest of the trades.
                          4. "—" only when there's neither AI summary nor
                             typed notes. */}
                    {summary ? (
                      <span className="text-gray-300 font-sans whitespace-normal leading-snug">{summary}</span>
                    ) : t.notes?.trim() ? (
                      <span
                        className="text-gray-300 font-sans whitespace-normal leading-snug italic"
                        title="From the trader's own notes on this trade — AI summary not yet generated."
                      >
                        {t.notes.trim()}
                      </span>
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
