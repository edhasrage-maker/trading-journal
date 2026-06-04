'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Plus, Edit2, Trash2, ChevronDown, ChevronUp, Tag, X, Loader2 } from 'lucide-react'
import TradeForm from './TradeForm'
import TagSelector from './TagSelector'
import LiveChart from '@/components/charts/LiveChart'
import { deleteBlob } from '@/lib/storage'
import { captureRatio, maeHeatRatio, mfeMaePoints, isGiveBackTrade } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'
import { mergeTradeTags } from '@/lib/suggest-tags'
import type { Trade, TradeTag, TradeTags } from '@/lib/supabase/types'

interface Props {
  date: string
  initialTrades: Trade[]
  allTags: TradeTag[]
  /** Trade to auto-open + scroll to on mount (deep-link from the EOD trade list). */
  initialOpenTradeId?: string | null
  /** day_type from trading_days for this date — auto-populated on NEW trades only. */
  prepDayTypes?: string[]
  /** trading_days.eod_notes — shared with the EOD page so the trader can write
   *  during the session and the same text is there waiting at EOD. */
  initialSessionNotes?: string
}

type Mode = { type: 'list' } | { type: 'add' } | { type: 'edit'; trade: Trade }

function dirColor(d: string | null) { return d === 'long' ? 'text-green-400' : d === 'short' ? 'text-red-400' : 'text-gray-400' }
function pnlColor(p: number | null) { return p == null ? 'text-gray-400' : p > 0 ? 'text-green-400' : p < 0 ? 'text-red-400' : 'text-gray-400' }
function fmt(n: number | null) { return n == null ? '—' : n.toFixed(2) }

function rMultiple(t: Trade): string | null {
  if (!t.entry_price || !t.stop_price || !t.pnl) return null
  // R = pnl / risk_in_dollars. Risk in dollars requires the contract multiplier;
  // without it the value is off by 2× for MNQ, 20× for NQ, 50× for ES, etc.
  const mult = symbolToMultiplier(t.symbol ?? '')
  const risk = Math.abs(t.entry_price - t.stop_price) * (t.quantity ?? 1) * mult
  if (risk === 0) return null
  return (t.pnl / risk).toFixed(1) + 'R'
}

/** Display-formatted capture % — null when MFE can't be computed or was non-positive. */
function captureDisplay(t: Trade): string | null {
  const r = captureRatio(t)
  if (r == null) return null
  // Bound display at -999/+999% so a degenerate ratio doesn't blow the layout.
  const pct = Math.max(-999, Math.min(999, r * 100))
  return `${pct.toFixed(0)}%`
}

/** Display-formatted MAE Heat as a percentage. Null when no stop or no MAE.
 *  100% = MAE touched stop level; >100% = blew past it. */
function heatDisplay(t: Trade): string | null {
  const r = maeHeatRatio(t)
  if (r == null) return null
  return `${Math.round(r * 100)}%`
}

/**
 * Inline R · Capture · Heat line shown under the row's PnL in the collapsed
 * trade list. Capture and Heat each render as a small chip; gray by default,
 * red+bold only for the cross-case patterns that need review (give-back
 * loser, lucky-escape winner, heat past stop).
 */
function CapHeatInline({ trade, rDisplay }: { trade: Trade; rDisplay: string | null }) {
  const cap = captureRatio(trade)
  const heat = maeHeatRatio(trade)
  if (cap == null && heat == null && !rDisplay) return null

  // Cross-case detection. These are the trades you most want to NOT miss on
  // review — surfaced visibly so they don't blend into the row average.
  //
  // Give-back: had MFE >= 1R favorable AND closed at a loss. A negative
  // capture alone isn't enough — a +0.2R MFE that turned into a small loss is
  // just a normal small loss, not a "winner I gave back". 1R = the threshold
  // for what the trader's own R-multiple framework considers a real winner.
  //
  // Lucky escape: a winning trade whose MAE exceeded the planned stop. Got
  // bailed out by the trade reversing — a discipline lesson hiding in a W.
  const isGiveBack = isGiveBackTrade(trade)
  const isLuckyEscape = (trade.pnl ?? 0) > 0 && heat != null && heat > 1.0
  // Also flag heat > 100% on losers (you blew through your planned stop).
  const heatStandout = isLuckyEscape || (heat != null && heat > 1.0)

  const capCls = isGiveBack ? 'text-red-400 font-bold' : 'text-gray-400'
  const heatCls = heatStandout ? 'text-red-400 font-bold' : 'text-gray-400'

  // Layout: R inline next to nothing (compact), then MFE Realized % stacked
  // over MAE Heat % so the pair reads as a vertical unit. Each chip shows
  // just the number; the labels live in the hover tooltips to keep the row
  // compact. Gray default, red+bold on standout cases (give-back, lucky
  // escape, heat past stop).
  return (
    <div className="flex flex-col items-end text-xs text-gray-500 leading-tight">
      {rDisplay && <span>{rDisplay}</span>}
      {cap != null && (
        <span
          className={capCls}
          title={isGiveBack
            ? `MFE Realized %: ${captureDisplay(trade)} — give-back (trade went favorable then closed negative).`
            : `MFE Realized %: ${captureDisplay(trade)} of peak favorable excursion realized as PnL.`}
        >
          {captureDisplay(trade)}
        </span>
      )}
      {heat != null && (
        <span
          className={heatCls}
          title={isLuckyEscape
            ? `MAE Heat %: ${heatDisplay(trade)} — lucky escape (winner that violated planned stop).`
            : `MAE Heat %: ${heatDisplay(trade)} of planned stop distance touched as MAE.`}
        >
          {heatDisplay(trade)}
        </span>
      )}
    </div>
  )
}

export default function IntradayClient({ date, initialTrades, allTags: initialAllTags, initialOpenTradeId, prepDayTypes, initialSessionNotes = '' }: Props) {
  const router = useRouter()
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
  // Tags are local so newly-created custom tags appear across every TradeForm
  // on the page (existing edit-mode forms + the "new" form) without a full
  // page refresh.
  const [allTags, setAllTags] = useState<TradeTag[]>(initialAllTags)
  const addTag = (tag: TradeTag) => {
    setAllTags(prev => prev.some(t => t.id === tag.id) ? prev : [...prev, tag])
  }
  const [mode, setMode] = useState<Mode>({ type: 'list' })
  const [expanded, setExpanded] = useState<Set<string>>(
    () => (initialOpenTradeId ? new Set([initialOpenTradeId]) : new Set()),
  )
  const [highlightId, setHighlightId] = useState<string | null>(initialOpenTradeId ?? null)

  // Deep-link from the EOD trade list: open + scroll to the requested trade.
  useEffect(() => {
    if (!initialOpenTradeId) return
    const el = document.getElementById(`trade-${initialOpenTradeId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Fade the highlight after a moment.
    const t = setTimeout(() => setHighlightId(null), 2400)
    return () => clearTimeout(t)
  }, [initialOpenTradeId])
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pastedFile, setPastedFile] = useState<File | null>(null)
  const [showChart, setShowChart] = useState(true)

  // Session journal — shared with EOD recap via trading_days.eod_notes.
  // The trader writes during the session; the same text is there waiting at
  // EOD time. Debounced auto-save (1.5s) to keep the wire quiet while typing.
  const [sessionNotes, setSessionNotes] = useState(initialSessionNotes)
  const [notesSaveStatus, setNotesSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const lastSavedNotesRef = useRef(initialSessionNotes)
  const notesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (sessionNotes === lastSavedNotesRef.current) return
    if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current)
    notesSaveTimerRef.current = setTimeout(async () => {
      setNotesSaveStatus('saving')
      try {
        const res = await fetch(`/api/trading-days/${date}/eod`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eod_notes: sessionNotes }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        lastSavedNotesRef.current = sessionNotes
        setNotesSaveStatus('saved')
      } catch {
        setNotesSaveStatus('error')
      }
    }, 1500)
    return () => {
      if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current)
    }
  }, [sessionNotes, date])

  // Bulk multi-select for tag-apply. Checkbox per row toggles membership;
  // a floating bar appears when 1+ trades are selected. Selecting trades
  // does NOT change `expanded` / `mode`, so the user can keep editing one
  // trade while also bulk-tagging others.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const toggleSelected = (id: string) =>
    setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  const clearSelection = () => setSelectedIds(new Set())

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (mode.type !== 'list') return
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
      if (!item) return
      const file = item.getAsFile()
      if (file) {
        setPastedFile(file)
        setMode({ type: 'add' })
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [mode.type])

  const handleSave = (saved: Trade) => {
    setTrades(prev => {
      const exists = prev.find(t => t.id === saved.id)
      return exists ? prev.map(t => t.id === saved.id ? saved : t) : [...prev, saved]
    })
    setMode({ type: 'list' })
    setPastedFile(null)
  }

  // Bulk-apply tags: for each selected trade, PATCH /api/trades/[id] with the
  // merged tags_json (additive — never replaces existing tags). Updates local
  // state in place so the UI reflects the change without a full reload.
  const handleBulkApplyTags = async (toAdd: TradeTags) => {
    if (selectedIds.size === 0) return
    setBulkApplying(true)
    const targetTrades = trades.filter(t => selectedIds.has(t.id))
    const updated: Trade[] = []
    for (const t of targetTrades) {
      const next = mergeTradeTags(t.tags_json as TradeTags | undefined, toAdd)
      const res = await fetch(`/api/trades/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags_json: next }),
      })
      if (res.ok) {
        const saved = await res.json() as Trade
        updated.push(saved)
      }
    }
    if (updated.length > 0) {
      const byId = new Map(updated.map(t => [t.id, t]))
      setTrades(prev => prev.map(t => byId.get(t.id) ?? t))
    }
    setBulkApplying(false)
    setBulkTagOpen(false)
    clearSelection()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this trade?')) return
    setDeleting(id)
    const trade = trades.find(t => t.id === id)
    await fetch(`/api/trades/${id}`, { method: 'DELETE' })
    setTrades(prev => prev.filter(t => t.id !== id))
    if (trade?.screenshot_url) void deleteBlob(trade.screenshot_url)
    setDeleting(null)
  }

  const toggle = (id: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const isAdding = mode.type === 'add'
  const editingId = mode.type === 'edit' ? mode.trade.id : null

  // Most-common trade symbol for the day-level LiveChart (same derivation as
  // the EOD page). Null when no trades have a symbol.
  const chartSymbol = useMemo<string | null>(() => {
    const counts = new Map<string, number>()
    for (const t of trades) {
      if (t.symbol) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [sym, c] of counts) {
      if (c > bestCount) { best = sym; bestCount = c }
    }
    return best
  }, [trades])

  return (
    <div className="space-y-4">

      {/* Header — title + day switcher (mirrors the EOD / Prep page pattern) */}
      <div>
        <h1 className="text-2xl font-bold text-white">Intraday</h1>
        <div className="flex items-center gap-3 mt-1">
          <input
            type="date"
            value={date}
            onChange={e => {
              const next = e.target.value
              if (next && next !== date) router.push(`/intraday/${next}`)
            }}
            className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-md px-2 py-1 font-mono focus:outline-none focus:border-blue-500"
            title="Switch to a different day"
          />
          <span className="text-gray-400 text-sm">{format(new Date(date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')}</span>
        </div>
      </div>

      {/* Summary bar */}
      {trades.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 flex items-center gap-6">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Trades</div>
            <div className="text-lg font-bold text-white">{trades.length}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Day P&L</div>
            <div className={`text-lg font-bold ${pnlColor(totalPnl)}`}>
              {`${totalPnl >= 0 ? '+' : '−'}$${Math.abs(totalPnl).toFixed(2)}`}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Wins / Losses</div>
            <div className="text-lg font-bold text-white">
              <span className="text-green-400">{trades.filter(t => (t.pnl ?? 0) > 0).length}</span>
              <span className="text-gray-600"> / </span>
              <span className="text-red-400">{trades.filter(t => (t.pnl ?? 0) < 0).length}</span>
            </div>
          </div>
        </div>
      )}

      {/* Day-level chart (native bars) — collapsible. Renders only when the
          day has trades with a symbol; otherwise there's nothing to anchor
          the bars query to. */}
      {chartSymbol && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowChart(o => !o)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-800/40 hover:bg-gray-800 transition-colors"
          >
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chart</span>
            {showChart ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
          </button>
          {showChart && (
            <div className="p-3">
              <LiveChart date={date} symbol={chartSymbol} trades={trades} height={420} />
            </div>
          )}
        </div>
      )}

      {/* Trade list */}
      {trades.map(trade => {
        const isOpen = expanded.has(trade.id)
        const isEditing = editingId === trade.id
        const r = rMultiple(trade)
        const setupTag = trade.tags_json?.setups?.[0]
        const topTags = [
          ...(trade.tags_json?.confluences ?? []).slice(0, 2),
          ...(trade.tags_json?.mistakes ?? []).slice(0, 1),
        ]

        if (isEditing) {
          return (
            <TradeForm key={trade.id} date={date} allTags={allTags} trade={trade}
              onTagCreated={addTag}
              defaultSymbol={chartSymbol}
              dayTrades={trades}
              onSave={handleSave} onCancel={() => setMode({ type: 'list' })} />
          )
        }

        return (
          <div
            key={trade.id}
            id={`trade-${trade.id}`}
            className={`bg-gray-900 border rounded-xl overflow-hidden transition-colors ${
              highlightId === trade.id ? 'border-blue-500 ring-1 ring-blue-500/60' : 'border-gray-800'
            }`}
          >
            {/* Trade header row */}
            <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/40 transition-colors select-none"
              onClick={() => toggle(trade.id)}>
              {/* Multi-select checkbox — clicking it doesn't toggle the row open */}
              <input
                type="checkbox"
                checked={selectedIds.has(trade.id)}
                onChange={() => toggleSelected(trade.id)}
                onClick={e => e.stopPropagation()}
                className="accent-blue-600 cursor-pointer shrink-0"
                title="Select for bulk tag-apply"
              />
              {/* Direction badge */}
              <span className={`text-xs font-bold px-2 py-0.5 rounded border shrink-0 ${
                trade.direction === 'long' ? 'bg-green-900/40 border-green-700 text-green-400' : 'bg-red-900/40 border-red-700 text-red-400'
              }`}>
                {trade.direction === 'long' ? '▲ L' : '▼ S'}
              </span>

              {/* Time */}
              <span className="text-xs text-gray-500 shrink-0">
                {trade.entry_time ? new Date(trade.entry_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}
              </span>

              {/* Setup */}
              <span className="text-sm font-medium text-white flex-1 truncate">{setupTag ?? 'No setup tagged'}</span>

              {/* Top tags */}
              <div className="hidden sm:flex gap-1 shrink-0">
                {topTags.slice(0, 2).map(tag => (
                  <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-400">{tag}</span>
                ))}
              </div>

              {/* P&L · R · Capture % · Loss ×R. Capture and loss are bolded when
                  the trade matches a high-signal cross-case pattern:
                    - "Give-back" = loser that went green first (negative capture)
                    - "Lucky escape" = winner that violated the planned stop (loss > 1×R) */}
              <div className="text-right shrink-0">
                <div className={`text-sm font-bold ${pnlColor(trade.pnl)}`}>
                  {trade.pnl == null ? '—' : `${trade.pnl >= 0 ? '+' : '−'}$${Math.abs(trade.pnl).toFixed(0)}`}
                </div>
                <CapHeatInline trade={trade} rDisplay={r} />
              </div>

              {isOpen ? <ChevronUp className="w-4 h-4 text-gray-600 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-600 shrink-0" />}
            </div>

            {/* Expanded detail */}
            {isOpen && (
              <div className="border-t border-gray-800 px-4 py-4 space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
                  {[
                    { label: 'Entry', value: fmt(trade.entry_price) },
                    { label: 'Stop', value: fmt(trade.stop_price) },
                    { label: 'TP1', value: fmt(trade.tp1_price) },
                    { label: 'Qty', value: trade.quantity?.toString() ?? '—' },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
                      <div className="text-white font-medium">{value}</div>
                    </div>
                  ))}
                </div>

                {/* Execution quality: Capture % (how much of MFE did I take?) and
                    Heat % (did I sit through more than my planned stop?). */}
                {(captureDisplay(trade) != null || heatDisplay(trade) != null) && (() => {
                  const xc = mfeMaePoints(trade)
                  const cap = captureDisplay(trade)
                  const heat = heatDisplay(trade)
                  const capRatio = captureRatio(trade)
                  const heatRatio = maeHeatRatio(trade)
                  // Gray default; red+bold only for standout cases (negative
                  // capture = give-back, heat > 100% = past stop).
                  const capCls = capRatio != null && capRatio < 0 ? 'text-red-400 font-bold' : 'text-gray-300'
                  const heatCls = heatRatio != null && heatRatio > 1.0 ? 'text-red-400 font-bold' : 'text-gray-300'
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5" title="MFE Realized %: realized PnL / peak favorable excursion DURING the position. 100% = you took the high.">
                          MFE Realized %
                        </div>
                        <div className={`font-medium ${capCls}`}>{cap ?? '—'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5" title="MAE Heat %: peak adverse excursion / planned stop distance. 100% = MAE touched your stop level. Red bold means past stop (you blew through or got slipped).">
                          MAE Heat %
                        </div>
                        <div className={`font-medium ${heatCls}`}>{heat ?? '—'}</div>
                      </div>
                      <div className="hidden sm:block">
                        <div className="text-xs text-gray-500 mb-0.5" title="Raw MFE in points">Peak MFE</div>
                        <div className="text-gray-300 font-mono">{xc ? `+${xc.mfe.toFixed(2)}` : '—'}</div>
                      </div>
                      <div className="hidden sm:block">
                        <div className="text-xs text-gray-500 mb-0.5" title="Raw MAE in points">Peak MAE</div>
                        <div className="text-gray-300 font-mono">{xc ? `−${xc.mae.toFixed(2)}` : '—'}</div>
                      </div>
                    </div>
                  )
                })()}

                {/* Screenshot with pins */}
                {trade.screenshot_url && (
                  <div className="relative rounded-lg overflow-hidden border border-gray-700 bg-gray-950">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={trade.screenshot_url} alt="Trade" className="w-full object-contain max-h-80" />
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
                      {([
                        { key: 'entry', x: trade.entry_pin_x, y: trade.entry_pin_y, color: '#22c55e', short: 'E' },
                        { key: 'stop',  x: trade.stop_pin_x,  y: trade.stop_pin_y,  color: '#ef4444', short: 'S' },
                        { key: 'tp1',   x: trade.tp1_pin_x,   y: trade.tp1_pin_y,   color: '#eab308', short: 'T' },
                      ] as const).map(p => p.x != null && p.y != null ? (
                        <g key={p.key}>
                          <circle cx={`${p.x}%`} cy={`${p.y}%`} r="10" fill={p.color} fillOpacity="0.85" stroke="white" strokeWidth="2" />
                          <text x={`${p.x}%`} y={`${p.y}%`} textAnchor="middle" dominantBaseline="central" fill="white" fontSize="9" fontWeight="bold">{p.short}</text>
                        </g>
                      ) : null)}
                    </svg>
                  </div>
                )}

                {/* All tags */}
                {Object.keys(trade.tags_json ?? {}).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(trade.tags_json ?? {}).flatMap(([cat, val]) => {
                      const items = Array.isArray(val) ? val : val ? [val] : []
                      return items.map((tag: string) => (
                        <span key={`${cat}-${tag}`}
                          className={`text-xs px-2 py-0.5 rounded-full border ${
                            cat === 'mistakes' ? 'bg-red-900/30 border-red-700 text-red-400'
                            : cat === 'emotions' ? 'bg-purple-900/30 border-purple-700 text-purple-400'
                            : 'bg-gray-800 border-gray-700 text-gray-300'
                          }`}>{tag}</span>
                      ))
                    })}
                  </div>
                )}

                {trade.notes && (
                  <p className="text-sm text-gray-400 italic">{trade.notes}</p>
                )}

                {/* Actions */}
                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={() => setMode({ type: 'edit', trade })}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-400 transition-colors">
                    <Edit2 className="w-3 h-3" /> Edit
                  </button>
                  <button type="button" onClick={() => handleDelete(trade.id)} disabled={deleting === trade.id}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50">
                    <Trash2 className="w-3 h-3" /> {deleting === trade.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* Add trade form */}
      {isAdding && (
        <TradeForm date={date} allTags={allTags} initialFile={pastedFile} prepDayTypes={prepDayTypes}
          onTagCreated={addTag}
          defaultSymbol={chartSymbol}
          dayTrades={trades}
          onSave={handleSave} onCancel={() => { setMode({ type: 'list' }); setPastedFile(null) }} />
      )}

      {/* Session journal — shared with the EOD recap. This is the same
          trading_days.eod_notes field both pages read/write, so anything the
          trader jots down here is waiting in the EOD recap textarea later. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            Session journal
          </label>
          <span className="text-[10px] text-gray-600">
            {notesSaveStatus === 'saving' && 'Saving…'}
            {notesSaveStatus === 'saved' && 'Saved · syncs with EOD recap'}
            {notesSaveStatus === 'error' && <span className="text-red-400">Save failed — will retry on next edit</span>}
            {notesSaveStatus === 'idle' && 'Syncs with EOD recap'}
          </span>
        </div>
        <textarea
          rows={3}
          spellCheck
          autoCorrect="on"
          placeholder="Jot down what you're seeing — emotions, level reactions, plan deviations. Shows up in the EOD recap automatically."
          value={sessionNotes}
          onChange={e => setSessionNotes(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-y"
        />
      </div>

      {/* Add button */}
      {!isAdding && !editingId && (
        <button type="button" onClick={() => setMode({ type: 'add' })}
          className="flex items-center gap-2 w-full justify-center border border-dashed border-gray-700 hover:border-gray-500 text-gray-500 hover:text-gray-200 text-sm py-3 rounded-xl transition-colors bg-gray-800/20 hover:bg-gray-800/50"
        >
          <Plus className="w-4 h-4" /> Log Trade
        </button>
      )}

      {/* Floating bulk-action bar — appears when 1+ trades are selected. */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-gray-900 border border-gray-700 rounded-full shadow-2xl px-4 py-2 flex items-center gap-3 text-sm">
          <span className="text-gray-300 font-medium">
            <strong>{selectedIds.size}</strong> trade{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <span className="text-gray-700">·</span>
          <button
            type="button"
            onClick={() => setBulkTagOpen(true)}
            className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-full text-xs font-medium transition-colors"
          >
            <Tag className="w-3 h-3" /> Add tags
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-gray-500 hover:text-white transition-colors"
            title="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Bulk tag-apply modal */}
      {bulkTagOpen && (
        <BulkTagModal
          count={selectedIds.size}
          allTags={allTags}
          applying={bulkApplying}
          onCancel={() => setBulkTagOpen(false)}
          onApply={handleBulkApplyTags}
        />
      )}

    </div>
  )
}

/**
 * Modal for applying tags to N selected trades at once. Starts with empty
 * selection (we don't know which tags are shared across the picked trades —
 * keeping it empty makes the action explicitly "add THESE tags"). Disabled
 * until at least one tag is chosen. Always additive — never replaces tags
 * already on the target trades.
 */
function BulkTagModal({
  count, allTags, applying, onCancel, onApply,
}: {
  count: number
  allTags: TradeTag[]
  applying: boolean
  onCancel: () => void
  onApply: (tags: TradeTags) => void
}) {
  const [picked, setPicked] = useState<TradeTags>({})
  const tagCount = Object.values(picked).reduce(
    (n, v) => n + (Array.isArray(v) ? v.length : v ? 1 : 0),
    0,
  )
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">Add tags to {count} trade{count === 1 ? '' : 's'}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Pick the tags to add. Existing tags on each trade are preserved.</p>
          </div>
          <button type="button" onClick={onCancel} className="text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-y-auto p-4 flex-1">
          <TagSelector tags={allTags} selected={picked} onChange={setPicked} />
        </div>
        <div className="flex items-center justify-between p-4 border-t border-gray-800 gap-3">
          <span className="text-xs text-gray-500">{tagCount} tag{tagCount === 1 ? '' : 's'} picked</span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onApply(picked)}
              disabled={tagCount === 0 || applying}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded transition-colors"
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Tag className="w-3.5 h-3.5" />}
              {applying ? 'Applying…' : `Apply to ${count}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
