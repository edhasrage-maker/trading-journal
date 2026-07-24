'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { GitMerge, Trash2, ChevronDown, ChevronUp, Tag, X, Loader2, ImagePlus, Flag, ArrowRight } from 'lucide-react'
import TradeForm from './TradeForm'
import SessionTradeTable from '@/components/session/SessionTradeTable'
import AvgMfeMaeCard from '@/components/AvgMfeMaeCard'
import TagSelector from './TagSelector'
import LiveChart from '@/components/charts/LiveChart'
import { useChartInstruments } from '@/lib/use-chart-instruments'
import { useSessionClock } from '@/lib/use-session-clock'
import { deleteBlob } from '@/lib/storage'
import { mergeTradeTags } from '@/lib/suggest-tags'
import type { ScoringProfile } from '@/lib/scoring-profile'
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
  /** The trader's own onboarding scoring rules → per-user Coach Score. Null on
   *  the owner's local app (no onboarding) → default (Ruleset v1.3) rubric. */
  scoringProfile?: ScoringProfile | null
  /** trading_days.session_ended_at — set once the trader manually ends the
   *  session ("I'm done"). Drives the time-aware seam (Pt 13 step 3). */
  initialSessionEndedAt?: string | null
}

type Mode = { type: 'list' } | { type: 'add' } | { type: 'edit'; trade: Trade }

function pnlColor(p: number | null) { return p == null ? 'text-gray-400' : p > 0 ? 'text-green-400' : p < 0 ? 'text-red-400' : 'text-gray-400' }

export default function IntradayClient({ date, initialTrades, allTags: initialAllTags, initialOpenTradeId, prepDayTypes, initialSessionNotes = '', initialSessionEndedAt = null }: Props) {
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
  const [highlightId, setHighlightId] = useState<string | null>(initialOpenTradeId ?? null)
  // Manual end-session state (Pt 13 step 3). Seeded from the server; set locally
  // when the trader hits "I'm done" so the seam flips without a full reload.
  const [sessionEndedAt, setSessionEndedAt] = useState<string | null>(initialSessionEndedAt)
  const [ending, setEnding] = useState(false)

  // Deep-link from the EOD trade list: open + scroll to the requested trade.
  useEffect(() => {
    if (!initialOpenTradeId) return
    const el = document.getElementById(`trade-${initialOpenTradeId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Fade the highlight after a moment.
    const t = setTimeout(() => setHighlightId(null), 2400)
    return () => clearTimeout(t)
  }, [initialOpenTradeId])
  // The capture table's per-row "edit" opens the TradeForm above the table;
  // scroll it into view so clicking edit on a lower row isn't silent.
  useEffect(() => {
    if (mode.type !== 'edit') return
    document.getElementById('intraday-edit-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [mode])
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pastedFile, setPastedFile] = useState<File | null>(null)
  const [showChart, setShowChart] = useState(true)
  // Session journal is demoted to a collapsed drawer (Pt 17, cut list) so it
  // stops competing with the paste-first hero. Closed by default.
  const [showJournal, setShowJournal] = useState(false)

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
  // does NOT change `mode`, so the user can keep editing one trade while also
  // bulk-tagging others.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [merging, setMerging] = useState(false)
  const toggleSelected = (id: string) =>
    setSelectedIds(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s })
  const clearSelection = () => setSelectedIds(new Set())

  /** Merge exactly 2 selected trades — mirrors the EOD recap flow. Use case:
   *  a manual trade logged via the intraday tagging flow (with screenshot,
   *  setup tags) and the same physical fill imported later from a Sierra log.
   *  Server picks the SC-imported one as the keeper and copies the manual
   *  trade's qualitative fields onto it; the manual row is deleted. */
  const handleMergeSelected = async () => {
    if (selectedIds.size !== 2) return
    const [idA, idB] = Array.from(selectedIds)
    const a = trades.find(t => t.id === idA)
    const b = trades.find(t => t.id === idB)
    if (!a || !b) return
    const fmtT = (t: Trade) =>
      `${t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'} ${t.direction?.toUpperCase() ?? '--'} @ ${t.entry_price ?? '--'} qty ${t.quantity ?? '--'}${t.sierra_trade_id ? ' [SC]' : ' [manual]'}`
    const proceed = confirm(
      `Merge these two trades into one?\n\n` +
        `  ${fmtT(a)}\n` +
        `  ${fmtT(b)}\n\n` +
        `The SC-imported trade keeps its fill data (time, price, qty, pnl). ` +
        `The manual trade's tags, notes, screenshot, and stop/TP levels are ` +
        `carried over. The other row is deleted.\n\n` +
        `This cannot be undone.`,
    )
    if (!proceed) return

    setMerging(true)
    try {
      const res = await fetch('/api/trades/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeIds: [idA, idB] }),
      })
      const data = await res.json() as { keeperId?: string; deletedId?: string; error?: string }
      if (!res.ok || !data.keeperId || !data.deletedId) {
        alert(`Merge failed: ${data.error ?? 'unknown error'}`)
        return
      }
      // Optimistic local update: drop the deleted row; refetch the keeper to
      // pick up the server-merged qualitative fields.
      setTrades(prev => prev.filter(t => t.id !== data.deletedId))
      const keeperId = data.keeperId
      try {
        const r = await fetch(`/api/trades/${keeperId}`)
        if (r.ok) {
          const fresh = await r.json() as Trade
          setTrades(prev => prev.map(t => t.id === keeperId ? fresh : t))
        }
      } catch { /* the row stays as-is; non-fatal */ }
      clearSelection()
    } catch (e) {
      alert(`Merge failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setMerging(false)
    }
  }

  // Open the Add form pre-seeded with an image (paste / drop / file-pick). The
  // TradeForm auto-extracts on mount when it receives this file (Pt 17 paste-first
  // magic moment). Shared by the document paste listener and the hero dropzone.
  const startFromFile = (file: File) => {
    setPastedFile(file)
    setMode({ type: 'add' })
  }
  // Open the Add form with no image — the demoted "Add manually" path.
  const startManual = () => {
    setPastedFile(null)
    setMode({ type: 'add' })
  }

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (mode.type !== 'list') return
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
      if (!item) return
      const file = item.getAsFile()
      if (file) startFromFile(file)
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

  // Mass-delete every selected trade. One confirm (destructive), then each row
  // is DELETEd; local state drops the successes and the selection clears.
  // Mirrors handleDelete's per-trade screenshot-blob cleanup.
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    const n = selectedIds.size
    if (!confirm(`Delete ${n} selected trade${n === 1 ? '' : 's'}? This cannot be undone.`)) return
    setBulkDeleting(true)
    const targets = trades.filter(t => selectedIds.has(t.id))
    const deleted = new Set<string>()
    for (const t of targets) {
      const res = await fetch(`/api/trades/${t.id}`, { method: 'DELETE' })
      if (res.ok) {
        deleted.add(t.id)
        if (t.screenshot_url) void deleteBlob(t.screenshot_url)
      }
    }
    if (deleted.size > 0) setTrades(prev => prev.filter(t => !deleted.has(t.id)))
    setBulkDeleting(false)
    clearSelection()
  }

  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const isAdding = mode.type === 'add'

  // Time-aware seam (Pt 13 step 3). Live = today, before the RTH close, not yet
  // ended by choice → offer "I'm done". Once the clock has passed the close (or
  // this is a past date, or it's been ended), the paste hero yields to a prompt
  // to run the recap. Flags are false until mount, so nothing flashes on SSR.
  const { mounted, isToday, beforeClose } = useSessionClock(date)
  const sessionLive = isToday && beforeClose && !sessionEndedAt
  const showRecapCta = mounted && !sessionLive

  const endSession = async () => {
    if (ending) return
    if (!confirm(
      'End the session now and run your recap?\n\n' +
      'You can still add a missed trade afterward, but a trade entered after this ' +
      'is flagged as re-opening the session — the tape holds you to calling it done.',
    )) return
    setEnding(true)
    try {
      const res = await fetch(`/api/trading-days/${date}/end-session`, { method: 'POST' })
      if (!res.ok) { alert('Could not end the session. Please try again.'); return }
      const data = await res.json() as { endedAt?: string }
      setSessionEndedAt(data.endedAt ?? new Date().toISOString())
      router.push(`/review/today/${date}`)
    } catch {
      alert('Could not end the session. Please try again.')
    } finally {
      setEnding(false)
    }
  }

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

  // Symbol the chart loads bars for. Falls back to NQ when the day has no traded
  // symbol (e.g. a fresh day with nothing logged yet) so the chart still renders
  // and /api/bars can snap it to the most recent session with data — instead of
  // the chart panel disappearing on an empty day.
  const effectiveChartSymbol = chartSymbol ?? 'NQ'

  // ES/NQ instrument switcher for the chart (shared hook with EOD + prep).
  const { activeSymbol: activeChartSymbol, symbolOptions, onSymbolChange, chartTrades } = useChartInstruments(effectiveChartSymbol, trades)

  return (
    <div className="space-y-4">

      {/* Header — title + day switcher (mirrors the EOD / Prep page pattern) */}
      <div className="flex flex-wrap items-start justify-between gap-3">
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
        {/* Manual end-session (Pt 13 step 3) — only while the session is live
            (today, before the RTH close, not already ended). Runs the recap on
            the trader's terms; ending early is recorded as a discipline event. */}
        {sessionLive && (
          <button
            type="button"
            onClick={endSession}
            disabled={ending}
            className="shrink-0 self-center inline-flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-amber-600/60 text-gray-200 text-sm font-medium rounded-lg px-3.5 py-2 transition-colors disabled:opacity-60"
            title="End the session now and run your end-of-day recap"
          >
            {ending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flag className="w-4 h-4 text-amber-400" />}
            I&rsquo;m done — end session
          </button>
        )}
      </div>

      {/* After-close seam (Pt 13 step 3) — the session is over (past the RTH
          close, a past date, or ended by choice), so the prominent affordance is
          "run your recap", and the paste hero shrinks to an add-missed-trade box. */}
      {mode.type === 'list' && showRecapCta && (
        <button
          type="button"
          onClick={() => router.push(`/review/today/${date}`)}
          className="group w-full text-left rounded-xl border border-amber-800/50 bg-amber-950/20 hover:border-amber-600/70 px-5 py-4 transition-colors flex items-center gap-3"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">End session → run your recap</p>
            <p className="text-[13px] text-gray-400 mt-0.5">
              The market&rsquo;s closed for this session. Head to the recap for your TapeScore, verdicts, and AI read.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-amber-400 shrink-0 group-hover:translate-x-0.5 transition-transform" />
        </button>
      )}

      {/* Paste-first hero (Pt 17, mockup 03) — the screenshot dropzone IS the
          page. Ctrl+V / drop / tap → auto-extract → prefilled form. Hidden while
          a form is open. Compact once the day already has trades (or the session
          is over) so the list / recap CTA isn't pushed down. */}
      {mode.type === 'list' && (
        <PasteDropZone
          compact={trades.length > 0 || showRecapCta}
          onFile={startFromFile}
          onManual={startManual}
        />
      )}

      {/* Summary bar — Trades / Day P&L / Wins-Losses / Avg MFE-MAE. The
          MFE/MAE column drops in inline (variant='inline') so it fits in the
          existing strip rather than living in a second row of cards below. */}
      {trades.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 flex items-center gap-6 flex-wrap">
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
          <AvgMfeMaeCard trades={trades} variant="inline" />
        </div>
      )}

      {/* Day-level chart (native bars) — collapsible. Always renders (uses the
          NQ fallback symbol on empty days) so the chart snaps to the most recent
          session with data rather than vanishing. */}
      {effectiveChartSymbol && (
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
              <LiveChart
                date={date}
                symbol={activeChartSymbol}
                symbolOptions={symbolOptions}
                onSymbolChange={onSymbolChange}
                trades={chartTrades}
                height={420}
              />
            </div>
          )}
        </div>
      )}

      {/* Trade list — the shared session table in capture configuration: no
          scores, no verdicts, no AI while the market is open. Per-row "edit"
          opens the TradeForm in place (rendered just above); every judgment
          surface lives on the EOD recap after the close (Session-merge Pt 13). */}
      {mode.type === 'edit' && (
        <div id="intraday-edit-form">
          <TradeForm key={mode.trade.id} date={date} allTags={allTags} trade={mode.trade}
            onTagCreated={addTag}
            defaultSymbol={chartSymbol}
            dayTrades={trades}
            onSave={handleSave} onCancel={() => setMode({ type: 'list' })} />
        </div>
      )}

      {trades.length > 0 && (
        <SessionTradeTable
          config="capture"
          trades={trades}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelected}
          onDelete={handleDelete}
          deletingId={deleting}
          onEdit={id => {
            const t = trades.find(x => x.id === id)
            if (t) setMode({ type: 'edit', trade: t })
          }}
          editingId={mode.type === 'edit' ? mode.trade.id : null}
          flashTradeId={highlightId}
          rowIdPrefix="trade-"
        />
      )}

      {/* Add trade form */}
      {isAdding && (
        <TradeForm date={date} allTags={allTags} initialFile={pastedFile} prepDayTypes={prepDayTypes}
          onTagCreated={addTag}
          defaultSymbol={chartSymbol}
          dayTrades={trades}
          onSave={handleSave} onCancel={() => { setMode({ type: 'list' }); setPastedFile(null) }} />
      )}

      {/* Session journal — demoted to a collapsed drawer (Pt 17, cut list) so it
          stops competing with the paste-first hero. Same trading_days.eod_notes
          field the EOD recap reads/writes, so anything jotted here is waiting in
          the EOD recap textarea later. A "· has notes" hint + the save status
          stay visible while collapsed so nothing feels hidden. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowJournal(o => !o)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-800/40 hover:bg-gray-800 transition-colors"
        >
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Session journal
            {!showJournal && sessionNotes.trim() && (
              <span className="ml-2 normal-case font-normal text-gray-600">· has notes</span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[10px] text-gray-600">
              {notesSaveStatus === 'saving' && 'Saving…'}
              {notesSaveStatus === 'saved' && 'Saved · syncs with EOD'}
              {notesSaveStatus === 'error' && <span className="text-red-400">Save failed</span>}
            </span>
            {showJournal ? <ChevronUp className="w-3.5 h-3.5 text-gray-500" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-500" />}
          </span>
        </button>
        {showJournal && (
          <div className="p-4 pt-3 space-y-1.5">
            <textarea
              rows={3}
              spellCheck
              autoCorrect="on"
              placeholder="Jot down what you're seeing — emotions, level reactions, plan deviations. Shows up in the EOD recap automatically."
              value={sessionNotes}
              onChange={e => setSessionNotes(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-y"
            />
            <p className="text-[10px] text-gray-600">Syncs with the EOD recap automatically.</p>
          </div>
        )}
      </div>

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
          {/* Merge only enabled when exactly 2 are selected — same shape as EOD. */}
          <button
            type="button"
            onClick={handleMergeSelected}
            disabled={selectedIds.size !== 2 || merging}
            className="inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white px-3 py-1 rounded-full text-xs font-medium transition-colors"
            title={selectedIds.size === 2 ? 'Merge these two rows (manual + SC dedupe)' : 'Select exactly 2 trades to merge'}
          >
            {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />}
            Merge
          </button>
          {/* Mass delete — removes every selected trade after one confirm. */}
          <button
            type="button"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-600 text-white px-3 py-1 rounded-full text-xs font-medium transition-colors"
            title={`Delete all ${selectedIds.size} selected trade${selectedIds.size === 1 ? '' : 's'}`}
          >
            {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Delete
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
 * Paste-first hero (Pt 17, mockup 03). The screenshot dropzone is the primary
 * intraday surface: Ctrl+V (via the document listener in IntradayClient), drop
 * an image, or tap/click to pick one → the parent opens the Add form pre-seeded
 * with the file, and TradeForm auto-extracts on mount. Manual entry is the
 * demoted text link underneath. `compact` shrinks the hero once the day already
 * has trades so the list isn't pushed down.
 *
 * The card is a <label> wrapping a hidden file input, so a click/tap opens the
 * native picker on every platform (mobile photo library included) while drop and
 * the global paste still work on desktop.
 */
function PasteDropZone({
  compact, onFile, onManual,
}: {
  compact: boolean
  onFile: (file: File) => void
  onManual: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const takeImage = (files: FileList | null | undefined) => {
    const file = Array.from(files ?? []).find(f => f.type.startsWith('image/'))
    if (file) onFile(file)
  }

  return (
    <div>
      <label
        onDragOver={e => { e.preventDefault(); if (!dragging) setDragging(true) }}
        onDragLeave={e => { e.preventDefault(); setDragging(false) }}
        onDrop={e => {
          e.preventDefault()
          setDragging(false)
          takeImage(e.dataTransfer?.files)
        }}
        className={`block cursor-pointer rounded-xl border border-dashed text-center transition-colors ${
          compact ? 'px-4 py-3' : 'px-6 py-8'
        } ${
          dragging
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 hover:border-gray-500 bg-gray-800/20 hover:bg-gray-800/40'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => { takeImage(e.target.files); e.currentTarget.value = '' }}
        />
        <div className={`flex items-center justify-center gap-2 ${compact ? '' : 'flex-col'}`}>
          <ImagePlus className={`text-gray-500 ${compact ? 'w-4 h-4' : 'w-7 h-7'}`} />
          <div className={compact ? 'text-left' : ''}>
            <div className={`font-semibold text-gray-200 ${compact ? 'text-sm' : 'text-base'}`}>
              Paste your chart — TapeScore reads the trade
            </div>
            {!compact && (
              <p className="text-xs text-gray-500 mt-1">
                <span className="hidden sm:inline">Ctrl + V a screenshot, drop an image, or click to pick one. </span>
                <span className="sm:hidden">Tap to add a screenshot. </span>
                Instrument, side, entry, stop and target are extracted automatically.
              </p>
            )}
          </div>
        </div>
      </label>
      <p className="text-[11px] text-gray-600 mt-1.5 px-1">
        Prefer typing?{' '}
        <button type="button" onClick={onManual} className="text-blue-500 hover:text-blue-400 underline-offset-2 hover:underline">
          Add a trade manually
        </button>
      </p>
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
