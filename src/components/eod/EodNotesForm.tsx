'use client'

import { useEffect, useRef, useState } from 'react'
import { Save, Loader2 } from 'lucide-react'
import MicButton from '@/components/voice/MicButton'

interface Props {
  date: string
  initialNotes: string
  initialPnl: number | null
  computedPnl: number
  /** `auto` is true for the quiet save-as-you-type, false for the Save button. */
  onSaved?: (notes: string, pnl: number | null, auto: boolean) => void
  onError?: (msg: string) => void
}

/** Save-as-you-type delay — the same as the intraday journal box. */
const AUTOSAVE_MS = 1500

/** Blank → null (use computed). Anything else must be a number; undefined
 *  means "not a number yet" (e.g. a lone "-" mid-typing). */
function parsePnl(raw: string): number | null | undefined {
  if (raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** The save body. P&L goes only when it changed: saving it re-scores the
 *  day's achievements and dashboard stats, which note typing shouldn't do. */
function saveBody(notes: string, pnl: string, savedPnl: string): { eod_notes: string; eod_pnl?: number | null } | null {
  if (pnl === savedPnl) return { eod_notes: notes }
  const parsed = parsePnl(pnl)
  return parsed === undefined ? null : { eod_notes: notes, eod_pnl: parsed }
}

export default function EodNotesForm({
  date,
  initialNotes,
  initialPnl,
  computedPnl,
  onSaved,
  onError,
}: Props) {
  const initialPnlText = initialPnl != null ? String(initialPnl) : ''
  const [notes, setNotes] = useState(initialNotes)
  const [pnl, setPnl] = useState<string>(initialPnlText)
  // What the server holds. "Unsaved" means the boxes differ from it, so text
  // typed while a save is in flight stays unsaved rather than being marked done.
  const [saved, setSaved] = useState({ notes: initialNotes, pnl: initialPnlText })
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle')
  // The server's reason when it refused a save (e.g. the read-only demo);
  // null means the request itself didn't get through.
  const [failReason, setFailReason] = useState<string | null>(null)
  const dirty = notes !== saved.notes || pnl !== saved.pnl

  /** Append a finished spoken phrase, spaced off whatever is already there. */
  const appendDictation = (text: string) => {
    setNotes(cur => (cur.trim() ? `${cur.trimEnd()} ${text}` : text))
    setStatus('idle')
  }

  const save = async (auto: boolean) => {
    const sent = { notes, pnl }
    const body = saveBody(sent.notes, sent.pnl, saved.pnl)
    if (!body) {
      // Auto-save waits for a finished number; the Save button says why.
      if (!auto) onError?.('PnL override must be a number.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/trading-days/${date}/eod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setStatus('failed')
        setFailReason(typeof err.error === 'string' ? err.error : null)
        if (!auto) onError?.(`Save failed: ${err.error ?? 'unknown error'}`)
        return
      }
      setSaved(sent)
      setStatus('saved')
      onSaved?.(sent.notes, parsePnl(sent.pnl) ?? null, auto)
    } catch (e) {
      setStatus('failed')
      setFailReason(null)
      if (!auto) onError?.(`Save failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setSaving(false)
    }
  }

  // Save as you type: AUTOSAVE_MS after the last keystroke, never two saves at
  // once (a slow early save landing last would overwrite newer text). After a
  // failure it waits for the next edit rather than retrying in a loop.
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })
  useEffect(() => {
    if (!dirty || saving || status === 'failed') return
    const timer = setTimeout(() => { void saveRef.current(true) }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [notes, pnl, dirty, saving, status])

  // Leaving the page inside that window still sends what was typed —
  // keepalive lets the request outlive the page.
  const pendingRef = useRef<ReturnType<typeof saveBody>>(null)
  useEffect(() => {
    pendingRef.current = dirty ? saveBody(notes, pnl, saved.pnl) : null
  }, [dirty, notes, pnl, saved.pnl])
  useEffect(() => () => {
    const pending = pendingRef.current
    if (!pending) return
    void fetch(`/api/trading-days/${date}/eod`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pending),
      keepalive: true,
    }).catch(() => {})
  }, [date])

  // Warn before browser close / refresh while something is unsaved.
  useEffect(() => {
    if (!dirty && !saving) return
    const handle = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [dirty, saving])

  const overrideActive = pnl.trim() !== '' && Number(pnl) !== computedPnl

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Session journal</h2>
        <div className="flex items-center gap-3">
          {saving ? (
            <span className="text-xs text-gray-500">Saving…</span>
          ) : dirty && status === 'failed' ? (
            <span className="text-xs text-red-400 font-medium text-right">Not saved — {failReason ?? 'check your connection'}</span>
          ) : dirty ? (
            <span className="text-xs text-gray-500">Not saved yet</span>
          ) : status === 'saved' ? (
            <span className="text-xs text-gray-500">Saved</span>
          ) : null}
          <button
            onClick={() => { void save(false) }}
            disabled={saving}
            className="flex items-center gap-2 font-medium px-4 py-2 rounded-lg text-sm transition-colors text-white disabled:opacity-60 bg-blue-600 hover:bg-blue-500"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-300">
            Day Notes
          </label>
          {/* The longest thing anyone types in the app, written at the end of a
              session when typing it out is the last thing you want to do. */}
          <MicButton onText={appendDictation} title="Dictate your day notes" />
        </div>
        <textarea
          value={notes}
          onChange={e => { setNotes(e.target.value); setStatus('idle') }}
          rows={8}
          placeholder="Overall day assessment, execution quality, what went well, what to fix tomorrow..."
          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Computed PnL <span className="text-xs text-gray-500">(sum of trades)</span>
          </label>
          <div
            className={`px-3 py-2 rounded-lg text-sm font-mono border ${
              computedPnl > 0
                ? 'border-green-700 bg-green-900/20 text-green-300'
                : computedPnl < 0
                ? 'border-red-700 bg-red-900/20 text-red-300'
                : 'border-gray-700 bg-gray-950 text-gray-400'
            }`}
          >
            {computedPnl >= 0 ? '+' : ''}{computedPnl.toFixed(2)}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            PnL Override <span className="text-xs text-gray-500">(optional)</span>
          </label>
          <input
            type="number"
            step="0.01"
            value={pnl}
            onChange={e => { setPnl(e.target.value); setStatus('idle') }}
            placeholder="Leave blank to use computed"
            className={`w-full bg-gray-950 border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 ${
              overrideActive ? 'border-yellow-600' : 'border-gray-700'
            }`}
          />
        </div>
      </div>
    </div>
  )
}
