'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, X, Film, RotateCcw } from 'lucide-react'
import {
  useRecording, supportsFsAccess, pickRecordingViaHandle, ingestFile, reopenSavedRecording,
} from '@/lib/recording-store'
import type { Trade } from '@/lib/supabase/types'

/**
 * Frame-nudge for the CLOUD build — the browser-decode twin of FrameNudge.
 *
 * The local nudge shells out to ffmpeg against the OBS file on the founder's
 * machine (`/api/video/frame`); tapescore.app has neither the file nor ffmpeg.
 * Here the trader picks the clip once and it's decoded client-side — the video
 * never uploads, only the single chosen JPEG does.
 *
 * The picked recording lives in a page-level store (`useRecording`), so it's
 * picked ONCE and reused for every trade you adjust; on Chromium the file
 * handle persists across visits (one-click re-open, no dialog). This component
 * owns only the per-trade bits: which second to grab and saving that frame.
 */

/** Seconds either side of the computed entry moment. */
const RANGE = 120

/** `data:image/jpeg;base64,…` → Blob for upload. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/jpeg'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

interface Props {
  tradeId: string
  entryTimeIso: string
  /** The trade's exit, when it has one. Lets the scrubber jump to how the trade
   *  actually resolved rather than only to the moment you committed. */
  exitTimeIso?: string | null
  /** Existing recording_commentary, preserved on save (commentary text, levels). */
  recordingCommentary?: Trade['recording_commentary']
  /** Filename recorded on a previous save — a hint of which clip to pick. */
  suggestedFileName?: string | null
  /** Starting delta (a previously-saved nudge). */
  initialDelta?: number
  onSaved: (url: string) => void
  onClose?: () => void
}

export default function BrowserFrameNudge({
  tradeId, entryTimeIso, exitTimeIso, recordingCommentary, suggestedFileName, initialDelta = 0, onSaved, onClose,
}: Props) {
  const rec = useRecording()
  const [delta, setDelta] = useState(initialDelta)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against out-of-order grabs while dragging the slider.
  const reqToken = useRef(0)

  const entryMs = Date.parse(entryTimeIso)
  const exitMs = exitTimeIso ? Date.parse(exitTimeIso) : NaN
  const hasExit = Number.isFinite(exitMs) && exitMs > entryMs
  // Which moment the scrubber is anchored to. Entry answers "what did I see when
  // I committed"; exit answers "how did it actually play out", which is the
  // question you are really asking in review and which the frame grabber could
  // always have answered — the offset is arithmetic on a timestamp the trade
  // already carries. `delta` still nudges around whichever anchor is chosen.
  const [anchorAt, setAnchorAt] = useState<'entry' | 'exit'>('entry')
  const baseMs = anchorAt === 'exit' && hasExit ? exitMs : entryMs
  const ready = rec.status === 'ready' && rec.grabber != null && rec.anchorMs != null
  // Where in the shared recording that moment falls, plus the user's nudge.
  const offsetSec = ready && Number.isFinite(baseMs)
    ? (baseMs - rec.anchorMs!) / 1000 + delta
    : null
  const inRange = offsetSec != null && offsetSec >= 0 && offsetSec <= rec.duration

  const grabAt = useCallback(async (sec: number) => {
    if (!rec.grabber) return
    const token = ++reqToken.current
    setLoading(true)
    setError(null)
    try {
      const url = await rec.grabber.grab(sec)
      if (token !== reqToken.current) return
      setPreview(url)
    } catch {
      if (token === reqToken.current) setError('Could not read that moment of the video.')
    } finally {
      if (token === reqToken.current) setLoading(false)
    }
  }, [rec.grabber])

  // Debounced preview as the slider moves (and when a recording becomes ready).
  useEffect(() => {
    if (!ready || offsetSec == null || !inRange) return
    const id = setTimeout(() => { void grabAt(offsetSec) }, 200)
    return () => clearTimeout(id)
  }, [ready, offsetSec, inRange, grabAt])

  const save = async () => {
    if (!preview) return
    setSaving(true)
    setError(null)
    try {
      const stamp = Date.now()
      const fd = new FormData()
      fd.append('file', dataUrlToBlob(preview), `obs-${tradeId}-${stamp}.jpg`)
      fd.append('bucket', 'screenshots')
      // Unique path every save — the screenshots bucket has no UPDATE policy, so
      // overwriting a stable name fails RLS. Matches the manual uploader.
      fd.append('path', `trades/obs-${tradeId}-${stamp}.jpg`)
      const up = await fetch('/api/screenshots', { method: 'POST', body: fd })
      const upData = await up.json() as { url?: string; error?: string }
      if (!up.ok || !upData.url) { setError(upData.error ?? 'Upload failed'); return }

      // Keep any existing commentary/levels; flag the source + chosen nudge so a
      // later open restores the slider. recording_commentary is jsonb but legacy
      // rows can come back as a JSON string — tolerate both (as TradeForm does).
      const rcRaw = recordingCommentary as unknown
      const rcObj: Record<string, unknown> =
        rcRaw && typeof rcRaw === 'object' ? (rcRaw as Record<string, unknown>)
          : typeof rcRaw === 'string' ? (() => { try { return JSON.parse(rcRaw) } catch { return {} } })()
            : {}
      const res = await fetch(`/api/trades/${tradeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screenshot_url: upData.url,
          recording_commentary: {
            ...rcObj,
            video_file: rec.name ?? (rcObj.video_file as string | undefined) ?? null,
            screenshot_source: 'obs',
            screenshot_delta_sec: delta,
          },
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string }
        setError(d.error ?? 'Could not attach the frame to this trade')
        return
      }
      onSaved(upData.url)
    } catch {
      setError('Network error saving the frame')
    } finally {
      setSaving(false)
    }
  }

  // FS Access picker on Chromium; the hidden <input> everywhere else.
  const openPicker = () => {
    if (supportsFsAccess()) void pickRecordingViaHandle()
    else inputRef.current?.click()
  }

  const fmtClock = (s: number) => {
    if (!Number.isFinite(s)) return '--:--'
    const sign = s < 0 ? '-' : ''
    const a = Math.abs(Math.round(s))
    return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
  }
  const label = delta === 0 ? 'at logged entry' : `${delta > 0 ? '+' : ''}${delta}s from entry`

  return (
    <div className="bg-gray-950/60 border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-gray-300">
            Adjust {anchorAt === 'exit' ? 'exit' : 'entry'} frame
          </span>
          {/* Only offered when the trade actually closed. On an open position
              there is no exit to seek to, and a dead toggle is worse than none. */}
          {hasExit && (
            <div className="flex items-center rounded border border-gray-700 overflow-hidden">
              {(['entry', 'exit'] as const).map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setAnchorAt(k); setDelta(0) }}
                  aria-pressed={anchorAt === k}
                  title={k === 'entry'
                    ? 'The moment you committed'
                    : 'How the trade actually resolved'}
                  className={`px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                    anchorAt === k ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
                  }`}
                >{k}</button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ready && (
            <button
              type="button"
              onClick={openPicker}
              className="text-[10px] text-gray-500 hover:text-gray-300 inline-flex items-center gap-1"
              title="Use a different recording"
            >
              <RotateCcw className="w-3 h-3" /> Change clip
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Hidden fallback picker for browsers without the File System Access API. */}
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void ingestFile(f); e.currentTarget.value = '' }}
      />

      {!ready ? (
        <div className="space-y-1.5">
          {rec.status === 'loading' ? (
            <p className="text-[11px] text-gray-400 inline-flex items-center gap-1.5 py-3 px-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading <span className="font-mono text-gray-500">{rec.name}</span>…
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={openPicker}
                className="w-full flex flex-col items-center gap-1.5 border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg px-3 py-4 cursor-pointer transition-colors text-center"
              >
                <Film className="w-4 h-4 text-gray-500" />
                <span className="text-[11px] text-gray-300 font-medium">Pick your screen recording</span>
                <span className="text-[10px] text-gray-600">
                  Stays on your machine — only the frame you choose is uploaded. Picked once, reused for every trade.
                </span>
              </button>
              {/* One-click re-open of a previously-used clip (Chromium). */}
              {rec.savedHandleName && (
                <button
                  type="button"
                  onClick={() => void reopenSavedRecording()}
                  className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] text-blue-300 hover:text-blue-200 border border-blue-900/60 hover:border-blue-700 rounded-md py-1.5 transition-colors"
                >
                  <RotateCcw className="w-3 h-3" /> Re-open <span className="font-mono">{rec.savedHandleName}</span>
                </button>
              )}
              {!rec.savedHandleName && suggestedFileName && (
                <p className="text-[10px] text-gray-600">Last used: <span className="font-mono text-gray-500">{suggestedFileName}</span></p>
              )}
            </>
          )}
          {rec.error && <p className="text-[10px] text-red-400">{rec.error}</p>}
        </div>
      ) : (
        <>
          <div className="relative w-full rounded-md overflow-hidden bg-black/40 border border-gray-800" style={{ minHeight: 120 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {preview && <img src={preview} alt="recording frame" className="w-full block" />}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
              </div>
            )}
            {!inRange && !loading && (
              <div className="absolute inset-0 flex items-center justify-center text-[11px] text-amber-300 px-3 text-center">
                This trade lands outside the clip ({fmtClock(offsetSec ?? 0)} of {fmtClock(rec.duration)}) — wrong recording, or the start estimate is off.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 font-mono w-9 text-right">-{RANGE}s</span>
            <input
              type="range" min={-RANGE} max={RANGE} step={1}
              value={delta}
              onChange={e => setDelta(Number(e.target.value))}
              className="flex-1 accent-blue-500"
            />
            <span className="text-[10px] text-gray-500 font-mono w-9">+{RANGE}s</span>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[11px] font-mono text-blue-300">
              {label} <span className="text-gray-600">· {fmtClock(offsetSec ?? 0)} into clip</span>
            </span>
            <div className="flex items-center gap-2">
              {delta !== 0 && (
                <button type="button" onClick={() => setDelta(0)} className="text-[10px] text-gray-400 hover:text-white">Reset</button>
              )}
              <button
                type="button"
                onClick={save}
                disabled={saving || loading || !preview}
                className="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                Use this frame
              </button>
            </div>
          </div>

          <p className="text-[10px] text-gray-600">
            <span className="font-mono text-gray-500">{rec.name}</span> · start{' '}
            {rec.anchorSource === 'filename'
              ? 'read from the filename'
              : 'estimated from the file date — nudge further if the frame looks off'}
          </p>
          {error && <p className="text-[10px] text-red-400">{error}</p>}
        </>
      )}
    </div>
  )
}
