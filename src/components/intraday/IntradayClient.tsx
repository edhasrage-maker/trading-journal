'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Plus, Edit2, Trash2, ChevronDown, ChevronUp } from 'lucide-react'
import TradeForm from './TradeForm'
import LiveChart from '@/components/charts/LiveChart'
import { deleteBlob } from '@/lib/storage'
import { captureRatio, maeLossRatio, mfeMaePoints, isGiveBackTrade } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'
import type { Trade, TradeTag } from '@/lib/supabase/types'

interface Props {
  date: string
  initialTrades: Trade[]
  allTags: TradeTag[]
  /** Trade to auto-open + scroll to on mount (deep-link from the EOD trade list). */
  initialOpenTradeId?: string | null
  /** day_type from trading_days for this date — auto-populated on NEW trades only. */
  prepDayType?: string | null
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

/** Display-formatted MAE loss — "0.6×R" style. Null when no stop or no MAE.
 *  Note: "loss" here is % of planned stop touched as MAE, not the realized
 *  dollar loss on the trade (which is the separate PnL field). */
function lossDisplay(t: Trade): string | null {
  const r = maeLossRatio(t)
  if (r == null) return null
  return `${r.toFixed(2)}×R`
}

/**
 * Inline R · Capture · Loss line shown under the row's PnL in the collapsed
 * trade list. Capture and Loss each render as a small colored chip; cross-case
 * patterns (give-back loser, lucky-escape winner) get bold weight so they
 * stand out from a sea of normal trades when scanning the list. The bold is
 * the only extra signal — color bands match the expanded-detail view to keep
 * the visual language consistent.
 */
function CapLossInline({ trade, rDisplay }: { trade: Trade; rDisplay: string | null }) {
  const cap = captureRatio(trade)
  const loss = maeLossRatio(trade)
  if (cap == null && loss == null && !rDisplay) return null

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
  const isLuckyEscape = (trade.pnl ?? 0) > 0 && loss != null && loss > 1.0

  const capColor = cap == null
    ? 'text-gray-500'
    : cap >= 0.7 ? 'text-green-400'
      : cap >= 0.4 ? 'text-yellow-400'
      : cap >= 0 ? 'text-orange-400'
      : 'text-red-400'
  const lossColor = loss == null
    ? 'text-gray-500'
    : loss <= 0.5 ? 'text-green-400'
      : loss <= 1.0 ? 'text-yellow-400'
      : 'text-red-400'

  return (
    <div className="flex items-center justify-end gap-1.5 text-xs text-gray-500">
      {rDisplay && <span>{rDisplay}</span>}
      {cap != null && (
        <span
          className={`${capColor} ${isGiveBack ? 'font-bold' : ''}`}
          title={isGiveBack
            ? `Give-back: trade went favorable then closed negative. Capture ${captureDisplay(trade)} of MFE.`
            : `Capture: ${captureDisplay(trade)} of peak favorable excursion realized as PnL.`}
        >
          {captureDisplay(trade)}
        </span>
      )}
      {loss != null && (
        <span
          className={`${lossColor} ${isLuckyEscape ? 'font-bold' : ''}`}
          title={isLuckyEscape
            ? `Lucky escape: winner sat through ${lossDisplay(trade)} of planned risk — violated stop level.`
            : `Loss: ${lossDisplay(trade)} of planned stop distance touched as MAE.`}
        >
          {lossDisplay(trade)}
        </span>
      )}
    </div>
  )
}

export default function IntradayClient({ date, initialTrades, allTags, initialOpenTradeId, prepDayType }: Props) {
  const router = useRouter()
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
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
        // Mistakes tag slice removed — category hidden pending new tagging
        // system. tags_json.mistakes data preserved on historical trades.
        const topTags = [
          ...(trade.tags_json?.confluences ?? []).slice(0, 2),
        ]

        if (isEditing) {
          return (
            <TradeForm key={trade.id} date={date} allTags={allTags} trade={trade}
              defaultSymbol={chartSymbol}
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
                <CapLossInline trade={trade} rDisplay={r} />
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

                {/* Execution quality: capture % (how much of MFE did I take?) and
                    MAE loss (did I sit through more than my planned stop?). */}
                {(captureDisplay(trade) != null || lossDisplay(trade) != null) && (() => {
                  const xc = mfeMaePoints(trade)
                  const cap = captureDisplay(trade)
                  const loss = lossDisplay(trade)
                  const capRatio = captureRatio(trade)
                  const lossRatio = maeLossRatio(trade)
                  const capColor = capRatio == null
                    ? 'text-gray-500'
                    : capRatio >= 0.7 ? 'text-green-400'
                      : capRatio >= 0.4 ? 'text-yellow-400'
                      : capRatio >= 0 ? 'text-orange-400'
                      : 'text-red-400'
                  const lossColor = lossRatio == null
                    ? 'text-gray-500'
                    : lossRatio <= 0.5 ? 'text-green-400'
                      : lossRatio <= 1.0 ? 'text-yellow-400'
                      : 'text-red-400'
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5" title="Realized PnL / peak favorable excursion. 100% = you took the high.">
                          MFE Capture
                        </div>
                        <div className={`font-medium ${capColor}`}>{cap ?? '—'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-0.5" title="Peak adverse excursion / planned stop distance. 1.0× = MAE touched your stop level. (% of planned risk used as MAE — separate from realized PnL.)">
                          MAE Loss
                        </div>
                        <div className={`font-medium ${lossColor}`}>{loss ?? '—'}</div>
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
        <TradeForm date={date} allTags={allTags} initialFile={pastedFile} prepDayType={prepDayType}
          defaultSymbol={chartSymbol}
          onSave={handleSave} onCancel={() => { setMode({ type: 'list' }); setPastedFile(null) }} />
      )}

      {/* Add button */}
      {!isAdding && !editingId && (
        <button type="button" onClick={() => setMode({ type: 'add' })}
          className="flex items-center gap-2 w-full justify-center border border-dashed border-gray-700 hover:border-gray-500 text-gray-500 hover:text-gray-200 text-sm py-3 rounded-xl transition-colors bg-gray-800/20 hover:bg-gray-800/50"
        >
          <Plus className="w-4 h-4" /> Log Trade
        </button>
      )}

    </div>
  )
}
