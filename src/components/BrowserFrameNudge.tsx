'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, X, Film } from 'lucide-react'
import { VideoFrameGrabber, parseObsFilenameStartMs } from '@/lib/browser-frames'
import type { Trade } from '@/lib/supabase/types'

/**
 * Frame-nudge for the CLOUD build — the browser-decode twin of FrameNudge.
 *
 * The local nudge shells out to ffmpeg against the OBS file on the founder's
 * machine (`/api/video/frame`), which tapescore.app can't do: no filesystem, no
 * ffmpeg, and the recording is gigabytes sitting on the trader's own disk. So
 * here the trader picks the clip, and everything happens client-side with the
 * same VideoFrameGrabber that BrowserRecap uses — the video is decoded in a
 * <video> element and never uploaded. Only the single chosen JPEG goes up.
 *
 * Aligning video time to trade time needs a recording START. Best source is the
 * OBS filename (it encodes the start); otherwise we estimate from the file's
 * last-modified date minus its duration (mtime ≈ when recording stopped). The
 * estimate can drift, so the anchor source is shown and the slider is wider than
 * the local nudge's ±60s — a filename anchor is exact and only needs to absorb
 * minute-rounded entry times, but an estimated one may need real correction.
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
  /** Existing recording_commentary, preserved on save (commentary text, levels). */
  recordingCommentary?: Trade['recording_commentary']
  /** Filename recorded on a previous save — shown as a hint of which clip to pick. */
  suggestedFileName?: string | null
  /** Starting delta (a previously-saved nudge). */
  initialDelta?: number
  onSaved: (url: string) => void
  onClose?: () => void
}

export default function BrowserFrameNudge({
  tradeId, entryTimeIso, recordingCommentary, suggestedFileName, initialDelta = 0, onSaved, onClose,
}: Props) {
  const [grabber, setGrabber] = useState<VideoFrameGrabber | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [anchorMs, setAnchorMs] = useState<number | null>(null)
  const [anchorSource, setAnchorSource] = useState<'filename' | 'filedate'>('filename')
  const [delta, setDelta] = useState(initialDelta)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against out-of-order grabs while dragging the slider.
  const reqToken = useRef(0)

  // Tear the grabber down when it's replaced or the component unmounts —
  // it holds an object URL and a detached <video>.
  useEffect(() => () => { grabber?.dispose() }, [grabber])

  const entryMs = Date.parse(entryTimeIso)
  // Where in the video the trade's entry falls, plus the user's nudge.
  const offsetSec = anchorMs != null && Number.isFinite(entryMs)
    ? (entryMs - anchorMs) / 1000 + delta
    : null
  const inRange = offsetSec != null && offsetSec >= 0 && offsetSec <= duration

  const pickFile = async (picked: File) => {
    setError(null)
    setPreview(null)
    setGrabber(prev => { prev?.dispose(); return null })
    setFileName(picked.name)
    // maxWidth well above a typical 1080p/1440p capture so the SAVED frame keeps
    // its native detail — the grabber's 1280 default would quietly downscale the
    // screenshot and make it mush the moment anyone zoomed in.
    const g = new VideoFrameGrabber(picked, { maxWidth: 2560, quality: 0.92 })
    setLoading(true)
    try {
      await g.ready
    } catch {
      setError('Could not decode that file. OBS .mkv often needs remuxing to .mp4 — the browser can only play what it has a codec for.')
      setLoading(false)
      g.dispose()
      return
    }
    setDuration(g.duration)
    // Prefer the OBS filename's embedded start; fall back to (file date − duration).
    const fromName = parseObsFilenameStartMs(picked.name)
    setAnchorMs(fromName ?? picked.lastModified - g.duration * 1000)
    setAnchorSource(fromName ? 'filename' : 'filedate')
    setGrabber(g)
    setLoading(false)
  }

  const grabAt = useCallback(async (sec: number) => {
    if (!grabber) return
    const token = ++reqToken.current
    setLoading(true)
    setError(null)
    try {
      const url = await grabber.grab(sec)
      if (token !== reqToken.current) return
      setPreview(url)
    } catch {
      if (token === reqToken.current) setError('Could not read that moment of the video.')
    } finally {
      if (token === reqToken.current) setLoading(false)
    }
  }, [grabber])

  // Debounced preview as the slider moves (and once the clip is loaded).
  useEffect(() => {
    if (!grabber || offsetSec == null || !inRange) return
    const id = setTimeout(() => { void grabAt(offsetSec) }, 200)
    return () => clearTimeout(id)
  }, [grabber, offsetSec, inRange, grabAt])

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
      // later open restores the slider where you left it. recording_commentary is
      // jsonb but legacy rows (from the localStorage backfill) can come back as a
      // JSON *string* — tolerate both, exactly as TradeForm does when reading it.
      const rc = ((): Record<string, unknown> => {
        const raw = recordingCommentary as unknown
        if (raw && typeof raw === 'object') return raw as unknown as Record<string, unknown>
        if (typeof raw === 'string') {
          try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
        }
        return {}
      })()
      const res = await fetch(`/api/trades/${tradeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          screenshot_url: upData.url,
          recording_commentary: {
            ...rc,
            video_file: fileName ?? (rc.video_file as string | undefined) ?? null,
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
        <span className="text-[11px] font-semibold text-gray-300">Adjust entry frame</span>
        {onClose && (
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {!grabber ? (
        <div className="space-y-1.5">
          <label className="flex flex-col items-center gap-1.5 border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg px-3 py-4 cursor-pointer transition-colors text-center">
            <Film className="w-4 h-4 text-gray-500" />
            <span className="text-[11px] text-gray-300 font-medium">Pick your screen recording</span>
            <span className="text-[10px] text-gray-600">
              Stays on your machine — only the frame you choose is uploaded.
            </span>
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.currentTarget.value = '' }}
            />
          </label>
          {suggestedFileName && (
            <p className="text-[10px] text-gray-600">Last used: <span className="font-mono text-gray-500">{suggestedFileName}</span></p>
          )}
          {loading && (
            <p className="text-[10px] text-gray-400 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Reading the clip…</p>
          )}
          {error && <p className="text-[10px] text-red-400">{error}</p>}
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
                This trade lands outside the clip ({fmtClock(offsetSec ?? 0)} of {fmtClock(duration)}) — wrong recording, or the start estimate is off.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 font-mono w-9 text-right">-{RANGE}s</span>
            <input
              type="range"
              min={-RANGE}
              max={RANGE}
              step={1}
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
            <span className="font-mono text-gray-500">{fileName}</span> · start{' '}
            {anchorSource === 'filename'
              ? 'read from the filename'
              : 'estimated from the file date — nudge further if the frame looks off'}
          </p>
          {error && <p className="text-[10px] text-red-400">{error}</p>}
        </>
      )}
    </div>
  )
}
