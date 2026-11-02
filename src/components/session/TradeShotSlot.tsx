'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Film, Loader2, Upload } from 'lucide-react'
import PinPlacement, { type Pin, type PinType } from '@/components/intraday/PinPlacement'
import FrameNudge from '@/components/FrameNudge'
import BrowserFrameNudge from '@/components/BrowserFrameNudge'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { deleteBlob } from '@/lib/storage'
import type { Trade } from '@/lib/supabase/types'

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
  const rec = ((): { video_file?: string; screenshot_delta_sec?: number; screenshot_source?: string } | null => {
    const raw = t.recording_commentary as unknown
    if (raw && typeof raw === 'object') return raw as { video_file?: string; screenshot_delta_sec?: number; screenshot_source?: string }
    if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return null } }
    return null
  })()
  const videoFile = rec?.video_file ?? null
  const delta = rec?.screenshot_delta_sec ?? 0
  const canNudge = !!t.entry_time && (LOCAL_FEATURES_ENABLED ? !!videoFile : true)
  const fromRecording = !!t.screenshot_url && rec?.screenshot_source === 'obs'

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

      {(actions || (t.screenshot_url && canNudge)) && (
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
          {fromRecording && !picking && (
            <span className="text-xs text-gray-500">
              Frame from your recording, {delta === 0 ? 'at entry' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)}s from entry`}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
