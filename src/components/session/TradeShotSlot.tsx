'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Eye, Film, Loader2, Trash2, Upload } from 'lucide-react'
import PinPlacement, { type Pin, type PinType } from '@/components/intraday/PinPlacement'
import FrameNudge from '@/components/FrameNudge'
import BrowserFrameNudge from '@/components/BrowserFrameNudge'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { deleteBlob } from '@/lib/storage'
import { screenshotStoragePath } from '@/lib/storage-url'
import { aiLimitFor } from '@/lib/ai-usage'
import type { DetectedLevels, Trade } from '@/lib/supabase/types'

const PT_STAMP = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
})
/** 7,683.50 / 28,762: ticks keep two decimals, whole points none. */
const fmtLevel = (n: number): string =>
  n.toLocaleString('en-US', Number.isInteger(n) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })

type SavedRead = {
  text?: string; generated_at?: string; detected_levels?: DetectedLevels; auto_applied?: string[]
  video_file?: string; screenshot_delta_sec?: number; screenshot_source?: string
}

/**
 * The trade drawer's picture slot (founder-approved mockup 2A, 2026-11-02):
 * the screenshot sits near the top of the drawer, and a trade without one
 * shows an empty slot that pulls a frame from the recording or takes a paste /
 * upload right there — no trip through the full log.
 *
 * Frames come from the same two pickers the full log uses: on tapescore.app the
 * browser decodes the clip from the trader's recordings folder (the video never
 * uploads; only the chosen frame does), locally ffmpeg reads the OBS file. So a
 * NEW frame can only be pulled on the PC that holds the recordings; a saved
 * screenshot shows anywhere.
 *
 * Saves go straight to the row (upload, then PATCH) and hand the saved trade to
 * `onSaved`. The drawer's compact log leaves the screenshot out of its own save,
 * so the two never overwrite each other.
 *
 * "Read with the coach" (mockup 2D, 2026-11-02) sends the saved screenshot to the
 * same call the recap's recording run makes (/api/recap/commentary): one coach
 * read returns a few sentences on the trade plus the stop/target off the chart.
 * Only on a press, never on its own, and a trade already read shows its saved
 * read for free. A "high" level read fills an EMPTY Stop/TP1 by itself (the
 * route's rule); anything less certain waits for "Use this".
 */
export default function TradeShotSlot({
  trade: t, date, pins, onZoom, onSaved, actions,
}: {
  trade: Trade
  date: string
  pins: Partial<Record<PinType, Pin>>
  onZoom: (url: string) => void
  onSaved: (trade: Trade) => void
  /** Replay link and the replay verdict — they sit in the row under the slot. */
  actions?: ReactNode
}) {
  const [picking, setPicking] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // recording_commentary is jsonb, but legacy rows can come back as a JSON
  // string — tolerate both (as TradeForm does).
  const rec = ((): SavedRead | null => {
    const raw = t.recording_commentary as unknown
    if (raw && typeof raw === 'object') return raw as SavedRead
    if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return null } }
    return null
  })()
  const videoFile = rec?.video_file ?? null
  const delta = rec?.screenshot_delta_sec ?? 0
  const canNudge = !!t.entry_time && (LOCAL_FEATURES_ENABLED ? !!videoFile : true)
  const fromRecording = !!t.screenshot_url && rec?.screenshot_source === 'obs'

  // The coach read works off the saved screenshot's storage path (the hosted
  // bucket is private; the route reads it back server-side).
  const shotPath = !LOCAL_FEATURES_ENABLED ? screenshotStoragePath(t.screenshot_url) : null
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [applying, setApplying] = useState<'stop_price' | 'tp1_price' | null>(null)

  const readWithCoach = useCallback(async () => {
    if (!shotPath) return
    setReading(true)
    setReadError(null)
    try {
      const res = await fetch('/api/recap/commentary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'screenshot', frames: [{ id: t.id, path: shotPath }] }),
      })
      const data = await res.json().catch(() => ({})) as {
        error?: string
        commentary?: Record<string, string>
        detected_levels?: Record<string, DetectedLevels>
        auto_applied?: Record<string, Partial<{ stop_price: number; tp1_price: number }>>
        model?: string
      }
      if (!res.ok) { setReadError(data.error ?? 'The coach could not read this screenshot.'); return }
      const text = data.commentary?.[t.id]
      if (!text) { setReadError('The coach could not read this screenshot.'); return }
      const applied = data.auto_applied?.[t.id] ?? {}
      // The route saved all of this to the row; mirror it so the drawer shows it now.
      onSaved({
        ...t,
        ...applied,
        recording_commentary: {
          ...(rec ?? {}),
          text,
          model: data.model,
          generated_at: new Date().toISOString(),
          detected_levels: data.detected_levels?.[t.id],
          auto_applied: Object.keys(applied).length ? Object.keys(applied) : undefined,
        } as Trade['recording_commentary'],
      })
    } catch {
      setReadError('Network error reading the screenshot')
    } finally {
      setReading(false)
    }
  }, [shotPath, t, rec, onSaved])

  const applyLevel = useCallback(async (field: 'stop_price' | 'tp1_price', value: number) => {
    setApplying(field)
    setReadError(null)
    try {
      const res = await fetch(`/api/trades/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      const saved = await res.json().catch(() => ({})) as Trade & { error?: string }
      if (!res.ok) { setReadError(saved.error ?? 'Could not save that level'); return }
      onSaved(saved)
    } catch {
      setReadError('Network error saving the level')
    } finally {
      setApplying(null)
    }
  }, [t.id, onSaved])

  // Take the picture off the trade (founder, 2026-11-02: a pasted screenshot of
  // the trades table landed in a slot, with no way to undo it from the drawer).
  // The pins sat on that image and the coach's read was of it, so both go; the
  // recording's file name and frame offset stay, so "Pull frame" still works.
  const [removing, setRemoving] = useState(false)
  const removeShot = useCallback(async () => {
    if (!t.screenshot_url) return
    if (!window.confirm(`Remove this screenshot from the trade?${rec?.text ? "\n\nThe coach's read of it goes too." : ''}`)) return
    setRemoving(true)
    setError(null)
    try {
      const keep = rec ? { video_file: rec.video_file, screenshot_delta_sec: rec.screenshot_delta_sec } : null
      const res = await fetch(`/api/trades/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screenshot_url: null,
          entry_pin_x: null, entry_pin_y: null, stop_pin_x: null, stop_pin_y: null, tp1_pin_x: null, tp1_pin_y: null,
          ...(rec ? { recording_commentary: keep?.video_file ? keep : null } : {}),
        }),
      })
      const saved = await res.json().catch(() => ({})) as Trade & { error?: string }
      if (!res.ok) { setError(saved.error ?? 'Could not remove the screenshot'); return }
      void deleteBlob(t.screenshot_url)
      onSaved(saved)
    } catch {
      setError('Network error removing the screenshot')
    } finally {
      setRemoving(false)
    }
  }, [t.id, t.screenshot_url, rec, onSaved])

  const frameSaved = useCallback((url: string) => {
    if (t.screenshot_url && t.screenshot_url !== url) void deleteBlob(t.screenshot_url)
    setPicking(false)
    onSaved({ ...t, screenshot_url: url })
  }, [t, onSaved])

  const upload = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('bucket', 'screenshots')
      fd.append('path', `trades/${date}-${Date.now()}.${file.name.split('.').pop() || 'png'}`)
      const up = await fetch('/api/screenshots', { method: 'POST', body: fd })
      const upData = await up.json().catch(() => ({})) as { url?: string; error?: string }
      if (!up.ok || !upData.url) { setError(upData.error ?? 'Upload failed'); return }
      const res = await fetch(`/api/trades/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenshot_url: upData.url }),
      })
      const saved = await res.json().catch(() => ({})) as Trade & { error?: string }
      if (!res.ok) { setError(saved.error ?? 'Could not attach the screenshot to this trade'); return }
      onSaved(saved)
    } catch {
      setError('Network error saving the screenshot')
    } finally {
      setUploading(false)
    }
  }, [date, t.id, onSaved])

  // Ctrl+V anywhere in the open drawer drops a copied image into an empty slot.
  // Text pastes (the notes box) are left alone: only an image item counts.
  useEffect(() => {
    if (t.screenshot_url || picking) return
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (!file) return
      e.preventDefault()
      void upload(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [t.screenshot_url, picking, upload])

  const nudge = picking && t.entry_time && (LOCAL_FEATURES_ENABLED ? (
    <FrameNudge
      videoFile={videoFile!}
      entryTimeIso={t.entry_time}
      tradeId={t.id}
      initialDelta={delta}
      onSaved={frameSaved}
      onClose={() => setPicking(false)}
    />
  ) : (
    <BrowserFrameNudge
      tradeId={t.id}
      entryTimeIso={t.entry_time}
      exitTimeIso={t.exit_time ?? null}
      recordingCommentary={t.recording_commentary}
      suggestedFileName={videoFile}
      initialDelta={delta}
      onSaved={frameSaved}
      onClose={() => setPicking(false)}
    />
  ))

  const btn = 'inline-flex items-center gap-1.5 text-[12.5px] font-semibold rounded-md px-3 min-h-9 transition-colors'

  return (
    <section aria-label="Chart" className="space-y-2">
      {t.screenshot_url ? (
        <div className="relative">
          <PinPlacement imageUrl={t.screenshot_url} pins={pins} onZoom={() => onZoom(t.screenshot_url!)} />
          <span className="pointer-events-none absolute right-2 bottom-2 rounded bg-gray-950/80 px-1.5 py-0.5 text-[11px] text-gray-100">
            Click to enlarge
          </span>
        </div>
      ) : !picking && (
        <div
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void upload(f) }}
          onDragOver={e => e.preventDefault()}
          className="border-2 border-dashed border-gray-700 rounded-[10px] bg-gray-800/30 min-h-[200px] flex flex-col items-center justify-center gap-3 px-4 py-6 text-center"
        >
          <p className="text-sm font-semibold text-gray-300">No screenshot for this trade yet</p>
          <div className="flex flex-wrap justify-center gap-2">
            {canNudge && (
              <button type="button" onClick={() => setPicking(true)} className={`${btn} bg-purple-600 hover:bg-purple-500 text-white min-h-10 text-[13px]`}>
                <Film className="w-4 h-4" /> Pull frame from recording
              </button>
            )}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className={`${btn} bg-gray-900 border border-gray-700 text-gray-200 hover:bg-gray-800 min-h-10 text-[13px] disabled:opacity-60`}
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {uploading ? 'Saving…' : 'Paste or upload'}
            </button>
          </div>
          <p className="text-xs text-gray-500">Or press Ctrl+V while this drawer is open</p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.currentTarget.value = '' }}
          />
        </div>
      )}

      {nudge}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {(actions || t.screenshot_url || shotPath) && (
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {t.screenshot_url && canNudge && !picking && (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className={`${btn} bg-gray-900 border border-gray-700 text-gray-200 hover:bg-gray-800`}
              title="Pick a different frame from your recording"
            >
              <Film className="w-3.5 h-3.5" /> Recording
            </button>
          )}
          {shotPath && rec?.text && !picking && (
            <button
              type="button"
              onClick={() => void readWithCoach()}
              disabled={reading}
              className={`${btn} disabled:opacity-60 bg-gray-900 border border-gray-700 text-gray-200 hover:bg-gray-800`}
            >
              {reading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
              {reading ? 'Reading…' : 'Read again'}
            </button>
          )}
          {fromRecording && !picking && !shotPath && (
            <span className="text-xs text-gray-500">
              Frame from your recording, {delta === 0 ? 'at entry' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)}s from entry`}
            </span>
          )}
          {t.screenshot_url && !picking && (
            <button
              type="button"
              onClick={() => void removeShot()}
              disabled={removing}
              className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-400 rounded-md px-2 min-h-9 transition-colors disabled:opacity-60"
              title="Take this screenshot off the trade"
            >
              {removing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {removing ? 'Removing…' : 'Remove'}
            </button>
          )}
        </div>
      )}

      {/* Before a first read the coach gets its own labelled card rather than a
          bare button: "Read with the coach" alone didn't say what it does or
          what it costs (founder, 2026-11-02). */}
      {shotPath && !rec?.text && !picking && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border border-gray-800 rounded-[10px] bg-gray-900/60 px-3.5 py-3">
          <div className="flex-1 min-w-[220px]">
            <div className="text-[13.5px] font-semibold text-gray-100">Have the coach read this chart</div>
            <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
              It reads your stop and target off the screenshot, checks them against your log, and says what it sees in the trade.
              Uses 1 of your {aiLimitFor('recap_commentary')} coach reads a day.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void readWithCoach()}
            disabled={reading}
            className={`${btn} disabled:opacity-60 bg-blue-600 hover:bg-blue-500 text-white`}
          >
            {reading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            {reading ? 'Reading…' : 'Read my chart'}
          </button>
        </div>
      )}
      {readError && <p className="text-xs text-red-400">{readError}</p>}

      {rec?.text && (
        <CoachRead trade={t} read={rec} applying={applying} onUse={applyLevel} />
      )}
    </section>
  )
}

/** "The coach's read" box (mockup 2D): the saved comment, then the levels the
 *  coach read off the chart against what the log holds. */
function CoachRead({
  trade: t, read, applying, onUse,
}: {
  trade: Trade
  read: SavedRead
  applying: 'stop_price' | 'tp1_price' | null
  onUse: (field: 'stop_price' | 'tp1_price', value: number) => void
}) {
  const when = read.generated_at && Number.isFinite(Date.parse(read.generated_at))
    ? PT_STAMP.format(new Date(read.generated_at)) : null
  // A frame cut from the recording (older reads lost screenshot_source, but kept
  // the recording's file name).
  const from = read.screenshot_source === 'obs' || read.video_file ? 'from your entry frame' : 'from your screenshot'
  const lv = read.detected_levels
  const rows: Array<{ label: string; field: 'stop_price' | 'tp1_price'; read: number | null; saved: number | null; order: string; sign: string }> = lv ? [
    { label: 'Stop', field: 'stop_price', read: lv.stop_price, saved: t.stop_price ?? null, order: 'stop', sign: '−' },
    { label: 'Target', field: 'tp1_price', read: lv.tp1_price, saved: t.tp1_price ?? null, order: 'target', sign: '+' },
  ] : []
  const away = (price: number, sign: string) =>
    t.entry_price == null ? '' : ` (${sign}${fmtLevel(Math.abs(price - t.entry_price))} pts)`

  return (
    <div className="border border-gray-800 rounded-[10px] bg-gray-900/60 px-3.5 py-3 space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>The coach&apos;s read</h3>
        {when && <span className="text-[11.5px] text-gray-500">{when} · {from}</span>}
      </div>
      <p className="text-[13.5px] leading-relaxed text-gray-200">{read.text}</p>
      {rows.length > 0 && (
        <div className="border-t border-gray-800 pt-2.5 space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Levels on your chart</div>
          <div className="grid grid-cols-[70px_100px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 items-center text-[13px]">
            {rows.map(r => {
              const matches = r.read != null && r.saved != null && Math.abs(r.read - r.saved) < 1e-6
              const filled = matches && !!read.auto_applied?.includes(r.field)
              const status = r.read == null ? (
                <span className="text-gray-400">
                  not readable on this frame · {r.saved != null ? `your log has ${fmtLevel(r.saved)}` : 'nothing in your log'}
                </span>
              ) : matches ? (
                <span className="text-green-400 inline-flex items-center gap-1">
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  {filled ? 'filled into your log' : 'in your log'} · read from your {r.order} order{away(r.read, r.sign)}
                </span>
              ) : r.saved != null ? (
                <span className="text-amber-300">your log has {fmtLevel(r.saved)} · did you move the bracket?</span>
              ) : lv?.confidence === 'low' ? (
                <span className="text-gray-400">too blurry to trust</span>
              ) : (
                <span className="inline-flex flex-wrap items-center gap-2 text-gray-400">
                  <button
                    type="button"
                    disabled={applying != null}
                    onClick={() => onUse(r.field, r.read as number)}
                    className="px-2.5 min-h-8 rounded-md border border-blue-700 text-blue-300 hover:bg-blue-900/40 text-xs font-semibold disabled:opacity-50"
                  >
                    {applying === r.field ? 'Saving…' : 'Use this'}
                  </button>
                  read from your {r.order} order{away(r.read, r.sign)}
                </span>
              )
              return (
                <div key={r.field} className="contents">
                  <span className="text-gray-400">{r.label}</span>
                  <span className={`font-mono ${r.read == null ? 'text-gray-500' : 'text-gray-100'}`}>{r.read == null ? '—' : fmtLevel(r.read)}</span>
                  {status}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
