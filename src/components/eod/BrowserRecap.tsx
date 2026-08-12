'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Video, Loader2, AlertCircle, Film, Anchor, Upload, Info, MessageSquare, SlidersHorizontal, Check, Copy, ChevronDown } from 'lucide-react'
import { VideoFrameGrabber, parseObsFilenameStartMs } from '@/lib/browser-frames'
import { createClient } from '@/lib/supabase/client'
import type { Trade, DetectedLevels } from '@/lib/supabase/types'

/**
 * Pull the AI text out of a `trades.recording_commentary` value, tolerant of
 * every shape that's shown up in the wild: a proper object `{ text, … }`, a
 * JSON-stringified object (legacy backfill), or a plain string. Lenient on
 * video_file — saved/transferred commentary should surface regardless of which
 * (if any) recording is loaded now. Returns null when there's no usable text.
 */
function savedCommentaryText(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw === 'object') {
    const o = raw as { text?: unknown }
    return typeof o.text === 'string' && o.text.length > 0 ? o.text : null
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const p = JSON.parse(s) as { text?: unknown }
        if (typeof p.text === 'string' && p.text.length > 0) return p.text
      } catch { /* fall through */ }
    }
    return s.length > 0 ? s : null
  }
  return null
}

/**
 * Pull the levels the coach read off the entry frame out of a
 * `trades.recording_commentary` value — same shape-tolerance as
 * savedCommentaryText, since both live in that one jsonb column. Returns null
 * for rows written before level detection existed, or when the frame showed no
 * working orders.
 */
function savedDetectedLevels(raw: unknown): DetectedLevels | null {
  if (raw == null) return null
  const read = (o: unknown): DetectedLevels | null => {
    if (!o || typeof o !== 'object') return null
    const lvl = (o as { detected_levels?: unknown }).detected_levels
    if (!lvl || typeof lvl !== 'object') return null
    if (typeof (lvl as DetectedLevels).confidence !== 'string') return null
    return lvl as DetectedLevels
  }
  if (typeof raw === 'object') return read(raw)
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('{') && s.endsWith('}')) {
      try { return read(JSON.parse(s)) } catch { return null }
    }
  }
  return null
}

/** Convert a `data:image/jpeg;base64,…` URL to a Blob for upload. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = head.match(/data:([^;]+)/)?.[1] ?? 'image/jpeg'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * BrowserRecap — Phase 1 of the cloud video recap.
 *
 * The local build reads OBS recordings via ffmpeg (`RecordingCommentary`). That
 * can't run on Vercel (no filesystem, no ffmpeg), so hosted users get this
 * instead: they pick their own recording, the browser decodes it locally
 * (`VideoFrameGrabber`), and we align a frame to each trade's entry. The video
 * file never uploads.
 *
 * The heart of Phase 1 is the ANCHOR: mapping "video position" ↔ "market clock".
 * Two ways to establish it —
 *   1. Auto: parse the OBS filename `YYYY-MM-DD HH-MM-SS` (video t=0 = that
 *      instant). Zero effort, right for un-remuxed OBS files recorded in the
 *      trader's own timezone.
 *   2. Pin to a trade (robust, timezone-free, replay-safe): scrub until a known
 *      trade's entry is on screen and pin it — the trade's real `entry_time`
 *      becomes the anchor. This is the fix for the "replay clock ≠ wall clock"
 *      caveat that the ffmpeg path never solved.
 * A ±120s fine-offset dials in the sub-minute slack from minute-rounded entry
 * times across every frame at once.
 *
 * NO AI here — Phase 1 just proves the alignment. Phase 2 uploads the aligned
 * frames and runs commentary (capped, model-tiered).
 */

interface Props {
  trades: Trade[]
  /** The EOD date (YYYY-MM-DD) — namespaces the persisted anchor. */
  date: string
  /** Called after the recap writes to a trade (a level applied, or a level the
   *  run filled in on its own) so the page re-reads the rows. */
  onTradesChanged?: () => void
}

type AnchorSource = 'filename' | 'mtime' | 'pinned'

interface AnchorState {
  /** Wall-clock instant (epoch ms) of video position 0. */
  recordingStartMs: number
  source: AnchorSource
  fineOffsetSec: number
  /** Recording the anchor was derived from — invalidates a stale saved anchor
   *  if the user loads a different file for the same day. */
  fileName: string
}

const anchorKey = (date: string) => `browserrecap-anchor-${date}`
const PT_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
const fmtPT = (iso: string | null | undefined): string => {
  if (!iso) return '--:--:--'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '--:--:--'
  return PT_TIME.format(new Date(ms))
}
const fmtClock = (sec: number): string => {
  if (!Number.isFinite(sec)) return '--:--'
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`
}

export default function BrowserRecap({ trades, date, onTradesChanged }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [grabber, setGrabber] = useState<VideoFrameGrabber | null>(null)
  const [duration, setDuration] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingVideo, setLoadingVideo] = useState(false)
  // When a recording fails to decode (MKV / unsupported codec), we can't read it
  // in-browser and ffmpeg.wasm can't either (it would need to load the whole
  // multi-GB file into wasm memory → OOM). Instead we show a remux recipe: a
  // stream-copy to MP4 is instant when the video is already H.264 (OBS's usual
  // encoder), and browsers seek MP4/H.264 natively.
  const [remuxHelpFor, setRemuxHelpFor] = useState<string | null>(null)
  const [copiedRemux, setCopiedRemux] = useState(false)

  const [anchor, setAnchor] = useState<AnchorState | null>(null)

  // Per-trade extracted entry frames (data URLs) + extraction progress.
  const [frames, setFrames] = useState<Record<string, string>>({})
  // Exit frames (data URLs) for trades whose exit falls inside the recording.
  const [exitFrames, setExitFrames] = useState<Record<string, string>>({})
  // Per-trade fine nudge (seconds) applied to the entry frame — lets the user
  // re-pick the exact moment when the minute-rounded entry_time lands early.
  const [entryDelta, setEntryDelta] = useState<Record<string, number>>({})
  // Which trade's ±60s nudge panel is open (only one at a time).
  const [nudgingId, setNudgingId] = useState<string | null>(null)
  // Per-trade frames-expanded override. Undefined = use the default (open until
  // AI commentary lands, then collapse so the grid reads as a compact list).
  const [framesOpen, setFramesOpen] = useState<Record<string, boolean>>({})
  const [extracting, setExtracting] = useState(false)
  const [extractProgress, setExtractProgress] = useState(0)

  // AI commentary (Phase 2): upload frames → server AI call → per-trade text.
  const [commentary, setCommentary] = useState<Record<string, string>>({})
  const [commentaryRunning, setCommentaryRunning] = useState(false)
  const [commentaryStage, setCommentaryStage] = useState<'idle' | 'uploading' | 'thinking'>('idle')
  const [commentaryError, setCommentaryError] = useState<string | null>(null)
  const [commentaryNote, setCommentaryNote] = useState<string | null>(null)
  // Stop/target the coach read off each entry frame. Fresh from a run, or read
  // back off the trades below when the run happened in an earlier session.
  const [levels, setLevels] = useState<Record<string, DetectedLevels>>({})
  /** id → which columns the last run filled in by itself, so we can say so. */
  const [autoApplied, setAutoApplied] = useState<Record<string, string[]>>({})
  /** `${tradeId}:${field}` while an Apply is in flight. */
  const [applyingLevel, setApplyingLevel] = useState<string | null>(null)

  // Pin-to-trade scrubber state.
  const [pinning, setPinning] = useState(false)
  const [pinTradeId, setPinTradeId] = useState<string>('')
  const [scrubSec, setScrubSec] = useState(0)
  const [scrubPreview, setScrubPreview] = useState<string | null>(null)
  const [scrubLoading, setScrubLoading] = useState(false)

  // Only trades with a usable entry_time can be aligned.
  const timedTrades = useMemo(
    () => trades.filter(t => t.entry_time && Number.isFinite(Date.parse(t.entry_time))),
    [trades],
  )

  // Commentary already stored on the trades (from an earlier session on this or
  // another device, or transferred from the local app). Read straight from the
  // DB rows so it survives reload and shows without re-extracting frames.
  const savedCommentary = useMemo(() => {
    const out: Record<string, string> = {}
    for (const t of trades) {
      const txt = savedCommentaryText(t.recording_commentary)
      if (txt) out[t.id] = txt
    }
    return out
  }, [trades])

  // Same for the levels: a read from any earlier run is still worth showing, so
  // the trader can apply it without burning another AI call on the same frames.
  // A fresh run's levels (state) take precedence over what's stored.
  const savedLevels = useMemo(() => {
    const out: Record<string, DetectedLevels> = {}
    for (const t of trades) {
      const lvl = savedDetectedLevels(t.recording_commentary)
      if (lvl) out[t.id] = lvl
    }
    return out
  }, [trades])

  // Tear down the grabber when it changes or the component unmounts.
  useEffect(() => () => { grabber?.dispose() }, [grabber])

  // Load a picked file → build a grabber, read metadata, seed/restore the anchor.
  const onPick = useCallback(async (picked: File) => {
    setLoadError(null)
    setRemuxHelpFor(null)
    setCopiedRemux(false)
    setFrames({})
    setExitFrames({})
    setEntryDelta({})
    setNudgingId(null)
    setFramesOpen({})
    setLoadingVideo(true)
    // Dispose any previous grabber before replacing it.
    setGrabber(prev => { prev?.dispose(); return null })

    // These frames don't just feed the AI — /api/video/commentary auto-fills a
    // missing trade screenshot with the entry frame, so whatever resolution we
    // grab at IS the stored screenshot. The grabber's 1280 default was quietly
    // saving 1280x536 stills off a 3440x1440 capture (2.7x downscale), which is
    // unreadable the moment you zoom in; pasted screenshots land at ~3420 wide.
    // 3840 clears a 3440 ultrawide so frames save at native res (parity with
    // pasted shots); grab() only ever downscales, so it's a no-op on smaller
    // sources. This is the recap BATCH path (entry+exit per trade), so native
    // res means heavier uploads — acceptable for the crispness it buys.
    const g = new VideoFrameGrabber(picked, { maxWidth: 3840, quality: 0.95 })
    try {
      await g.ready
    } catch (e) {
      g.dispose()
      setLoadingVideo(false)
      setLoadError(e instanceof Error ? e.message : 'Could not load recording.')
      // A decode failure is almost always a container/codec the browser can't
      // play (MKV, etc.) — surface the remux recipe for this exact file.
      setRemuxHelpFor(picked.name)
      return
    }
    setFile(picked)
    setGrabber(g)
    setDuration(g.duration)
    setLoadingVideo(false)

    // Restore a saved anchor for this day IF it was derived from this same file;
    // otherwise seed a fresh one from the filename (or file mtime as fallback).
    let restored: AnchorState | null = null
    try {
      const raw = localStorage.getItem(anchorKey(date))
      if (raw) {
        const parsed = JSON.parse(raw) as AnchorState
        if (parsed && parsed.fileName === picked.name && Number.isFinite(parsed.recordingStartMs)) {
          restored = parsed
        }
      }
    } catch { /* ignore */ }

    if (restored) {
      setAnchor(restored)
    } else {
      const fromName = parseObsFilenameStartMs(picked.name)
      const start = fromName ?? (picked.lastModified - g.duration * 1000)
      setAnchor({
        recordingStartMs: start,
        source: fromName ? 'filename' : 'mtime',
        fineOffsetSec: 0,
        fileName: picked.name,
      })
    }
    setScrubSec(0)
  }, [date])

  // Persist the anchor whenever it changes.
  useEffect(() => {
    if (!anchor) return
    try { localStorage.setItem(anchorKey(date), JSON.stringify(anchor)) } catch { /* ignore */ }
  }, [anchor, date])

  /** Video seconds to seek to for a trade timestamp (entry or exit), under the
   *  current anchor. Per-trade entry nudges are applied by the caller. */
  const offsetForTime = useCallback((iso: string): number => {
    if (!anchor) return NaN
    return (Date.parse(iso) - anchor.recordingStartMs) / 1000 + anchor.fineOffsetSec
  }, [anchor])

  // Debounced live preview while dragging the pin scrubber.
  useEffect(() => {
    if (!pinning || !grabber) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show the spinner immediately while the debounced grab runs
    setScrubLoading(true)
    const id = setTimeout(() => {
      grabber.grab(scrubSec)
        .then(url => { if (!cancelled) setScrubPreview(url) })
        .catch(() => { /* ignore transient seek errors */ })
        .finally(() => { if (!cancelled) setScrubLoading(false) })
    }, 180)
    return () => { cancelled = true; clearTimeout(id) }
  }, [scrubSec, pinning, grabber])

  const confirmPin = useCallback(() => {
    const t = timedTrades.find(t => t.id === pinTradeId)
    if (!t?.entry_time || !anchor) return
    // recordingStart such that (entryMs - start)/1000 == scrubSec  ⇒
    //   start = entryMs - scrubSec*1000. Fine-offset resets: the pin IS exact.
    const recordingStartMs = Date.parse(t.entry_time) - scrubSec * 1000
    setAnchor({ recordingStartMs, source: 'pinned', fineOffsetSec: 0, fileName: anchor.fileName })
    setPinning(false)
    setScrubPreview(null)
  }, [pinTradeId, scrubSec, timedTrades, anchor])

  // Extract an entry frame (and an exit frame, when the exit falls inside the
  // recording) for every timed trade in range, sequentially.
  const extractAll = useCallback(async () => {
    if (!grabber || !anchor) return
    setExtracting(true)
    setExtractProgress(0)
    const outEntry: Record<string, string> = {}
    const outExit: Record<string, string> = {}
    let done = 0
    for (const t of timedTrades) {
      const entryOff = offsetForTime(t.entry_time!) + (entryDelta[t.id] ?? 0)
      if (Number.isFinite(entryOff) && entryOff >= 0 && entryOff <= duration) {
        try { outEntry[t.id] = await grabber.grab(entryOff) } catch { /* skip this frame */ }
        // Exit frame — only when the exit is meaningfully after entry AND still
        // inside the recording (mirrors the ffmpeg path's entry+exit pairing).
        if (t.exit_time) {
          const exitOff = offsetForTime(t.exit_time)
          if (Number.isFinite(exitOff) && exitOff > entryOff + 1 && exitOff <= duration) {
            try { outExit[t.id] = await grabber.grab(exitOff) } catch { /* skip exit only */ }
          }
        }
      }
      done++
      setExtractProgress(done / timedTrades.length)
    }
    setFrames(outEntry)
    setExitFrames(outExit)
    setExtracting(false)
    // A fresh extraction invalidates any prior commentary (new anchor/frames)
    // and resets frame-expand overrides so defaults recompute.
    setFramesOpen({})
    setCommentary({})
    setCommentaryError(null)
    setCommentaryNote(null)
  }, [grabber, anchor, timedTrades, offsetForTime, duration, entryDelta])

  // Upload the extracted entry frames to the user's own storage folder, then run
  // the server-side AI commentary (capped + model-tiered). The video itself
  // never leaves the device — only these small entry-frame JPEGs.
  const runCommentary = useCallback(async () => {
    const entries = Object.entries(frames)
    if (entries.length === 0) return
    setCommentaryRunning(true)
    setCommentaryError(null)
    setCommentaryNote(null)
    setCommentaryStage('uploading')
    try {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setCommentaryError('You must be signed in to run commentary.'); return }

      const uploaded: Array<{ id: string; path: string; exitPath?: string }> = []
      const ts = Date.now()
      for (const [tradeId, dataUrl] of entries) {
        // Unique path → always an INSERT (the screenshots bucket has no UPDATE
        // policy). Per-user folder matches the route's ownership guard + folder RLS.
        const path = `${user.id}/recap/${tradeId}-${ts}.jpg`
        const { error } = await supabase.storage.from('screenshots')
          .upload(path, dataUrlToBlob(dataUrl), { contentType: 'image/jpeg', upsert: false })
        if (error) continue
        const ref: { id: string; path: string; exitPath?: string } = { id: tradeId, path }
        // Upload the exit frame too, when we have one. Failure drops only the
        // exit — the entry frame still drives commentary.
        const exitUrl = exitFrames[tradeId]
        if (exitUrl) {
          const exitPath = `${user.id}/recap/${tradeId}-exit-${ts}.jpg`
          const { error: exErr } = await supabase.storage.from('screenshots')
            .upload(exitPath, dataUrlToBlob(exitUrl), { contentType: 'image/jpeg', upsert: false })
          if (!exErr) ref.exitPath = exitPath
        }
        uploaded.push(ref)
      }
      if (uploaded.length === 0) { setCommentaryError('Frame upload failed — check your connection and try again.'); return }

      setCommentaryStage('thinking')
      const res = await fetch('/api/recap/commentary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoFile: file?.name ?? '<unknown>', frames: uploaded }),
      })
      const data = await res.json()
      if (!res.ok) { setCommentaryError(data.error ?? 'Commentary failed'); return }
      setCommentary(prev => ({ ...prev, ...(data.commentary ?? {}) }))
      setLevels(prev => ({ ...prev, ...(data.detected_levels ?? {}) }))
      const applied = data.auto_applied ?? {}
      setAutoApplied(Object.fromEntries(
        Object.entries(applied).map(([id, fields]) => [id, Object.keys(fields as object)]),
      ))
      if (data.note) setCommentaryNote(data.note)
      // The run writes stop/target straight into the columns when it read them
      // clearly, so re-read the trades or the page keeps showing them empty.
      if (Object.keys(applied).length > 0) onTradesChanged?.()
    } catch (e) {
      setCommentaryError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setCommentaryRunning(false)
      setCommentaryStage('idle')
    }
  }, [frames, exitFrames, file, onTradesChanged])

  /** Write one read level into its column. Only offered while the column is
   *  empty — the recap never overwrites a number the trader entered. */
  const applyLevel = useCallback(async (tradeId: string, field: 'stop_price' | 'tp1_price', value: number) => {
    setApplyingLevel(`${tradeId}:${field}`)
    try {
      const res = await fetch(`/api/trades/${tradeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        setCommentaryError(`Could not save that level: ${err.error ?? res.statusText}`)
        return
      }
      onTradesChanged?.()
    } catch (e) {
      setCommentaryError(`Could not save that level: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      setApplyingLevel(null)
    }
  }, [onTradesChanged])

  const inRangeCount = useMemo(() => {
    if (!anchor) return 0
    return timedTrades.reduce((n, t) => {
      const off = offsetForTime(t.entry_time!)
      return n + (Number.isFinite(off) && off >= 0 && off <= duration ? 1 : 0)
    }, 0)
  }, [timedTrades, offsetForTime, duration, anchor])

  const anchorLabel = anchor
    ? anchor.source === 'pinned' ? 'Pinned to a trade'
      : anchor.source === 'filename' ? 'From filename timestamp'
        : 'Estimated from file date'
    : ''

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Video className="w-4 h-4 text-blue-400" />
        <h2 className="font-semibold text-white text-sm">Recording recap</h2>
        <span className="text-[10px] uppercase tracking-wider text-blue-300/70 border border-blue-900/60 rounded px-1.5 py-0.5">Beta</span>
      </div>
      <p className="text-xs text-gray-500">
        Pick your screen recording of this session. Your browser reads a frame at each trade&apos;s entry so you can see
        what was on your chart when you pulled the trigger.{' '}
        <span className="text-gray-400">Your video never leaves your device — only the individual frames you analyze are sent to our AI provider for commentary.</span> Frames are extracted right here in your browser.
        MP4 / H.264 recordings work best.
      </p>

      {/* File picker */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <label className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm rounded-lg px-4 py-2 cursor-pointer transition-colors w-fit">
          <Upload className="w-4 h-4" />
          {file ? 'Choose a different recording' : 'Select recording…'}
          <input
            type="file"
            accept="video/mp4,video/*"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void onPick(f) }}
          />
        </label>
        {loadingVideo && (
          <span className="inline-flex items-center gap-2 text-xs text-gray-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading recording…
          </span>
        )}
        {file && !loadingVideo && (
          <span className="text-xs text-gray-500 font-mono truncate">
            {file.name} · {(file.size / 1e9).toFixed(2)} GB · {fmtClock(duration)}
          </span>
        )}
      </div>

      {loadError && (
        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{loadError}</div>
        </div>
      )}

      {/* Remux recipe — shown when a recording won't decode in-browser (MKV /
          unsupported codec). A stream copy to MP4 is instant when the video is
          already H.264 and makes the file browser-readable. */}
      {remuxHelpFor && (() => {
        const base = remuxHelpFor.replace(/\.[^.]+$/, '')
        const cmd = `ffmpeg -i "${remuxHelpFor}" -c copy "${base}.mp4"`
        return (
          <div className="bg-gray-950/50 border border-gray-800 rounded-lg p-3 space-y-2.5 text-xs">
            <div className="flex items-center gap-2 text-gray-200 font-semibold">
              <Film className="w-3.5 h-3.5 text-blue-400" /> Convert this recording to MP4
            </div>
            <p className="text-gray-400 leading-relaxed">
              Browsers can only read MP4 / H.264 in-page. This file&apos;s container (e.g. MKV) can&apos;t be decoded here,
              and converting a multi-GB recording inside the browser isn&apos;t practical. Run this once on your machine —
              it just re-wraps the video (no re-encode), so it&apos;s near-instant if you recorded with H.264:
            </p>
            <div className="flex items-stretch gap-2">
              <code className="flex-1 bg-black/50 border border-gray-800 rounded px-2.5 py-2 font-mono text-[11px] text-blue-200 break-all">
                {cmd}
              </code>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(cmd).then(() => {
                    setCopiedRemux(true)
                    setTimeout(() => setCopiedRemux(false), 1500)
                  }).catch(() => { /* clipboard unavailable */ })
                }}
                className="inline-flex items-center gap-1 shrink-0 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-[11px] rounded px-2.5 transition-colors"
              >
                {copiedRemux ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedRemux ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-gray-500 leading-relaxed">
              Then pick the new <span className="font-mono text-gray-400">.mp4</span> above. To avoid this next time, set OBS →
              Settings → Output → Recording to <span className="text-gray-300">Hybrid MP4</span> with the{' '}
              <span className="text-gray-300">NVIDIA NVENC H.264</span> encoder — crash-safe AND browser-readable.
            </p>
          </div>
        )
      })()}

      {grabber && anchor && (
        <>
          {/* Anchor panel */}
          <div className="border border-gray-800 rounded-lg p-3 space-y-3 bg-gray-950/40">
            <div className="flex items-center gap-2 flex-wrap">
              <Anchor className="w-3.5 h-3.5 text-blue-400" />
              <span className="text-xs font-semibold text-gray-200">Sync to the market clock</span>
              <span className="text-[10px] rounded border border-gray-700 text-gray-400 px-1.5 py-0.5">{anchorLabel}</span>
              <span className="ml-auto text-[11px] text-gray-500">
                {inRangeCount} / {timedTrades.length} trade{timedTrades.length === 1 ? '' : 's'} inside recording
              </span>
            </div>

            {timedTrades.length > 0 && inRangeCount === 0 && (
              <div className="text-[11px] text-amber-300/80 bg-amber-950/30 border border-amber-900/50 rounded px-2 py-1.5 flex items-start gap-1.5">
                <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                No trades line up with this recording yet. Pin a trade below to sync the timeline — the filename guess is
                often off (or the file was re-muxed).
              </div>
            )}

            {/* Fine offset — nudges every frame together to absorb minute-rounded
                entry times. Hidden mid-pin to keep the panel focused. */}
            {!pinning && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500 w-10 text-right">-120s</span>
                <input
                  type="range" min={-120} max={120} step={1}
                  value={anchor.fineOffsetSec}
                  onChange={e => setAnchor(a => a ? { ...a, fineOffsetSec: Number(e.target.value) } : a)}
                  className="flex-1 accent-blue-500"
                />
                <span className="text-[10px] text-gray-500 w-10">+120s</span>
                <span className="text-[11px] font-mono text-blue-300 w-16 text-right">
                  {anchor.fineOffsetSec > 0 ? '+' : ''}{anchor.fineOffsetSec}s
                </span>
                {anchor.fineOffsetSec !== 0 && (
                  <button
                    type="button"
                    onClick={() => setAnchor(a => a ? { ...a, fineOffsetSec: 0 } : a)}
                    className="text-[10px] text-gray-400 hover:text-white"
                  >Reset</button>
                )}
              </div>
            )}

            {/* Pin-to-trade flow */}
            {!pinning ? (
              <button
                type="button"
                onClick={() => {
                  setPinning(true)
                  const first = timedTrades[0]
                  setPinTradeId(first?.id ?? '')
                  // Start the scrubber near where that trade should be.
                  const off = first?.entry_time ? offsetForTime(first.entry_time) : 0
                  setScrubSec(Number.isFinite(off) && off >= 0 && off <= duration ? off : 0)
                }}
                disabled={timedTrades.length === 0}
                className="inline-flex items-center gap-1.5 text-[11px] text-blue-300 hover:text-blue-200 disabled:opacity-40"
              >
                <Anchor className="w-3 h-3" /> Pin a trade to sync exactly
              </button>
            ) : (
              <div className="space-y-2 border-t border-gray-800 pt-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] text-gray-400">Scrub until this trade&apos;s entry is on screen:</span>
                  <select
                    value={pinTradeId}
                    onChange={e => setPinTradeId(e.target.value)}
                    className="bg-gray-800 border border-gray-700 text-gray-200 text-[11px] rounded px-2 py-1 font-mono focus:outline-none focus:border-blue-500"
                  >
                    {timedTrades.map((t, i) => (
                      <option key={t.id} value={t.id}>
                        #{i + 1} · {fmtPT(t.entry_time)} PT · {t.direction?.toUpperCase() ?? '—'} @ {t.entry_price ?? '?'}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Live preview */}
                <div className="relative w-full rounded-md overflow-hidden bg-black/40 border border-gray-800" style={{ minHeight: 140 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {scrubPreview && <img src={scrubPreview} alt="recording frame" className="w-full block" />}
                  {scrubLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                      <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
                    </div>
                  )}
                  <div className="absolute bottom-1 right-2 text-[10px] font-mono text-white/80 bg-black/50 rounded px-1.5 py-0.5">
                    {fmtClock(scrubSec)} / {fmtClock(duration)}
                  </div>
                </div>

                <input
                  type="range" min={0} max={Math.max(1, Math.floor(duration))} step={1}
                  value={scrubSec}
                  onChange={e => setScrubSec(Number(e.target.value))}
                  className="w-full accent-blue-500"
                />

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setPinning(false); setScrubPreview(null) }}
                    className="text-[11px] text-gray-400 hover:text-white px-2 py-1"
                  >Cancel</button>
                  <button
                    type="button"
                    onClick={confirmPin}
                    disabled={!pinTradeId}
                    className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium px-3 py-1 rounded-md transition-colors"
                  >
                    <Anchor className="w-3 h-3" /> Pin here
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Extract */}
          {!pinning && (
            <button
              type="button"
              onClick={extractAll}
              disabled={extracting || inRangeCount === 0}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
            >
              {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Film className="w-4 h-4" />}
              {extracting ? `Extracting… ${Math.round(extractProgress * 100)}%` : 'Extract entry frames'}
            </button>
          )}
        </>
      )}

      {/* AI commentary run bar */}
      {Object.keys(frames).length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runCommentary}
              disabled={commentaryRunning}
              className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
            >
              {commentaryRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />}
              {commentaryStage === 'uploading' ? 'Uploading frames…'
                : commentaryStage === 'thinking' ? 'Coach is reading…'
                  : Object.keys(commentary).length > 0 ? 'Re-run AI commentary' : 'Run AI commentary'}
            </button>
            <span className="text-[11px] text-gray-500">
              Uploads the {Object.keys(frames).length} extracted frame{Object.keys(frames).length === 1 ? '' : 's'} and has the coach read each entry.
            </span>
          </div>
          {commentaryError && (
            <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>{commentaryError}</div>
            </div>
          )}
          {commentaryNote && !commentaryError && (
            <div className="text-[11px] text-amber-300/80 bg-amber-950/30 border border-amber-900/50 rounded px-2 py-1.5">
              {commentaryNote}
            </div>
          )}
        </div>
      )}

      {/* Frame grid */}
      {Object.keys(frames).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {timedTrades.map((t, i) => {
            const frame = frames[t.id]
            if (!frame) return null
            const exitFrame = exitFrames[t.id]
            const delta = entryDelta[t.id] ?? 0
            const nudging = nudgingId === t.id
            // Frames collapse so the grid reads as a compact commentary list.
            // Default: open until AI commentary lands for the trade (extract →
            // verify/nudge flow needs the frames visible), then auto-collapse.
            const open = framesOpen[t.id] ?? !commentary[t.id]
            const dir = t.direction?.toUpperCase() ?? '—'
            const dirTone = t.direction === 'long' ? 'text-green-300 bg-green-900/30 border-green-800'
              : t.direction === 'short' ? 'text-red-300 bg-red-900/30 border-red-800'
                : 'text-gray-400 bg-gray-800 border-gray-700'
            return (
              <div key={t.id} className="border border-gray-800 rounded-lg overflow-hidden self-start">
                {/* Header — always visible; the whole row toggles the frames. */}
                <button
                  type="button"
                  onClick={() => setFramesOpen(prev => ({ ...prev, [t.id]: !open }))}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-mono text-gray-400 hover:bg-gray-800/40 transition-colors text-left"
                >
                  <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-gray-500 transition-transform ${open ? '' : '-rotate-90'}`} />
                  <span>#{i + 1}</span>
                  <span>{fmtPT(t.entry_time)} PT</span>
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${dirTone}`}>{dir}</span>
                  <span>{t.quantity ?? '?'} @ {t.entry_price ?? '?'}</span>
                  {!open && <Film className="w-3 h-3 text-gray-600 shrink-0" />}
                  {t.pnl != null && (
                    <span className={`ml-auto font-bold ${t.pnl > 0 ? 'text-green-400' : t.pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                      {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                    </span>
                  )}
                </button>

                {/* Collapsible frames + nudge. */}
                {open && (
                  <div className="border-t border-gray-800">
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={frame} alt={`Trade ${i + 1} entry frame`} className="w-full block bg-black" />
                      <span className="absolute top-1 left-1 text-[9px] font-bold uppercase tracking-wider text-white/90 bg-black/60 rounded px-1.5 py-0.5">
                        Entry{delta !== 0 ? ` ${delta > 0 ? '+' : ''}${delta}s` : ''}
                      </span>
                    </div>
                    {exitFrame && (
                      <div className="relative border-t border-gray-800">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={exitFrame} alt={`Trade ${i + 1} exit frame`} className="w-full block bg-black" />
                        <span className="absolute top-1 left-1 text-[9px] font-bold uppercase tracking-wider text-white/90 bg-black/60 rounded px-1.5 py-0.5">
                          Exit {fmtPT(t.exit_time)} PT
                        </span>
                      </div>
                    )}
                    {/* ±60s nudge — re-pick the exact entry frame. Client-side
                        re-grab (no server round-trip); video is decoded locally. */}
                    {grabber && anchor && (
                      nudging ? (
                        <RecapFrameNudge
                          grabber={grabber}
                          baseOffset={offsetForTime(t.entry_time!)}
                          duration={duration}
                          initialDelta={delta}
                          initialPreview={frame}
                          onPicked={(d, url) => {
                            setFrames(prev => ({ ...prev, [t.id]: url }))
                            setEntryDelta(prev => ({ ...prev, [t.id]: d }))
                            setNudgingId(null)
                          }}
                          onClose={() => setNudgingId(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setNudgingId(t.id)}
                          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-gray-400 hover:text-blue-300 border-t border-gray-800 transition-colors"
                        >
                          <SlidersHorizontal className="w-3 h-3" /> Adjust entry frame
                        </button>
                      )
                    )}
                  </div>
                )}

                {commentary[t.id] && (
                  <p className="px-2.5 pb-2.5 text-xs text-gray-200 leading-snug border-t border-gray-800 pt-2">
                    {commentary[t.id]}
                  </p>
                )}

                <ReadLevels
                  trade={t}
                  levels={levels[t.id] ?? savedLevels[t.id]}
                  autoApplied={autoApplied[t.id]}
                  applying={applyingLevel}
                  onApply={applyLevel}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* Saved commentary — text already stored on these trades (an earlier
          session, another device, or transferred from the local app). Shown
          without needing a video loaded; a trade drops out of here once it has
          fresh commentary from a run this session (it appears in the grid above). */}
      {timedTrades.some(t => savedCommentary[t.id] && !commentary[t.id]) && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-xs font-semibold text-gray-300">Saved commentary</span>
            <span className="text-[10px] text-gray-500">from earlier sessions</span>
          </div>
          {timedTrades.map((t, i) => {
            if (!savedCommentary[t.id] || commentary[t.id]) return null
            const dir = t.direction?.toUpperCase() ?? '—'
            const dirTone = t.direction === 'long' ? 'text-green-300 bg-green-900/30 border-green-800'
              : t.direction === 'short' ? 'text-red-300 bg-red-900/30 border-red-800'
                : 'text-gray-400 bg-gray-800 border-gray-700'
            return (
              <div key={t.id} className="border border-gray-800 rounded-lg p-3 text-xs">
                <div className="flex items-center gap-2 mb-1 font-mono text-gray-400">
                  <span>#{i + 1}</span>
                  <span>{fmtPT(t.entry_time)} PT</span>
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${dirTone}`}>{dir}</span>
                  <span>{t.quantity ?? '?'} @ {t.entry_price ?? '?'}</span>
                  {t.pnl != null && (
                    <span className={`ml-auto font-bold ${t.pnl > 0 ? 'text-green-400' : t.pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                      {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                    </span>
                  )}
                </div>
                <p className="text-gray-200 leading-snug">{savedCommentary[t.id]}</p>
                <ReadLevels
                  trade={t}
                  levels={savedLevels[t.id]}
                  applying={applyingLevel}
                  onApply={applyLevel}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The stop and target the coach read off this trade's entry frame, and the one
 * click that puts them in the trade.
 *
 * Reading these was always part of the recap call — they just never made it out
 * of the response, so the trader kept typing by hand what the coach had already
 * read. What shows here depends on how sure the read was:
 *
 *   clear read  — already written into the empty column by the run itself
 *   double-check — shown with a button, because it's right about two thirds of
 *                  the time and the misses are large
 *   hard to read — shown greyed with no button; better typed in by hand
 *
 * A level the trader already entered is never touched, and is flagged when it
 * disagrees with the frame — that disagreement is usually interesting (the
 * bracket got moved mid-trade), so it's surfaced rather than hidden.
 */
function ReadLevels({
  trade, levels, autoApplied, applying, onApply,
}: {
  trade: Trade
  levels: DetectedLevels | undefined
  autoApplied?: string[]
  applying: string | null
  onApply: (tradeId: string, field: 'stop_price' | 'tp1_price', value: number) => void
}) {
  if (!levels) return null
  if (levels.stop_price == null && levels.tp1_price == null && levels.tp2_price == null) return null

  const readable = levels.confidence !== 'low'
  const tone = levels.confidence === 'high'
    ? { chip: 'text-emerald-300 border-emerald-800 bg-emerald-950/40', word: 'clear read' }
    : levels.confidence === 'medium'
      ? { chip: 'text-amber-300 border-amber-800 bg-amber-950/30', word: 'worth a check' }
      : { chip: 'text-gray-400 border-gray-700 bg-gray-800/60', word: 'hard to read' }

  /** Points from entry, so a wrong level is obvious at a glance. */
  const fromEntry = (price: number): string => {
    if (trade.entry_price == null) return ''
    const away = Math.abs(price - trade.entry_price)
    return ` · ${away.toFixed(2)} pts away`
  }

  const rows: Array<{
    label: string
    read: number | null
    field: 'stop_price' | 'tp1_price' | null
    saved: number | null
  }> = [
    { label: 'Stop', read: levels.stop_price, field: 'stop_price', saved: trade.stop_price ?? null },
    { label: 'Target', read: levels.tp1_price, field: 'tp1_price', saved: trade.tp1_price ?? null },
    { label: 'Second target', read: levels.tp2_price, field: null, saved: null },
  ]

  return (
    <div className="px-2.5 pb-2.5 pt-2 border-t border-gray-800 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-blue-300/80">Levels on your chart</span>
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${tone.chip}`}>{tone.word}</span>
        {levels.reasoning && (
          <span className="text-[10px] text-gray-600 truncate" title={levels.reasoning}>hover for what it saw</span>
        )}
      </div>

      {rows.map(({ label, read, field, saved }) => {
        if (read == null) return null
        const applyKey = field ? `${trade.id}:${field}` : ''
        const wasAutoApplied = !!field && !!autoApplied?.includes(field)
        const alreadyMatches = saved != null && Math.abs(saved - read) < 1e-6
        return (
          <div key={label} className="flex items-center gap-2 text-[11px]">
            <span className="text-gray-500 w-24 shrink-0">{label}</span>
            <span className="font-mono text-gray-200">{read}</span>
            <span className="text-gray-600 truncate">{fromEntry(read)}</span>
            <span className="ml-auto shrink-0">
              {field == null ? (
                <span className="text-[10px] text-gray-600" title="There's no field for a second target — this is just for reference.">for reference</span>
              ) : wasAutoApplied || alreadyMatches ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400">
                  <Check className="w-3 h-3" /> {wasAutoApplied ? 'filled in for you' : 'saved'}
                </span>
              ) : saved != null ? (
                <span className="text-[10px] text-amber-400/80" title={`Your trade has ${saved}. The frame shows ${read} — did you move the bracket?`}>
                  yours says {saved}
                </span>
              ) : readable ? (
                <button
                  type="button"
                  disabled={applying !== null}
                  onClick={() => onApply(trade.id, field, read)}
                  className="px-2 py-0.5 rounded border border-dashed border-blue-700 text-blue-300 hover:bg-blue-900/40 disabled:opacity-50 text-[10px] transition-colors"
                >
                  {applying === applyKey ? 'Saving…' : 'Use this'}
                </button>
              ) : (
                <span className="text-[10px] text-gray-600">too blurry to trust</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Per-trade ±60s entry-frame nudge. Unlike the local FrameNudge (which round-
 * trips /api/video/frame + ffmpeg), the recording is already decoded in the
 * browser here, so this re-grabs frames client-side off the shared
 * VideoFrameGrabber. Typed entry times round to the minute, so the true fill can
 * sit up to ~59s after the logged time — a ±60s window reaches it.
 */
function RecapFrameNudge({
  grabber, baseOffset, duration, initialDelta, initialPreview, onPicked, onClose,
}: {
  grabber: VideoFrameGrabber
  baseOffset: number
  duration: number
  initialDelta: number
  initialPreview: string
  onPicked: (delta: number, dataUrl: string) => void
  onClose: () => void
}) {
  const RANGE = 60
  const [delta, setDelta] = useState(initialDelta)
  const [preview, setPreview] = useState(initialPreview)
  const [loading, setLoading] = useState(false)

  // Debounced re-grab whenever the slider moves. Skip when the target is outside
  // the recording (can't seek there). The grabber serialises seeks internally.
  useEffect(() => {
    const target = baseOffset + delta
    if (!(Number.isFinite(target) && target >= 0 && target <= duration)) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show the spinner immediately while the debounced grab runs
    setLoading(true)
    const id = setTimeout(() => {
      grabber.grab(target)
        .then(url => { if (!cancelled) setPreview(url) })
        .catch(() => { /* transient seek error */ })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 200)
    return () => { cancelled = true; clearTimeout(id) }
  }, [delta, baseOffset, duration, grabber])

  const label = delta === 0 ? 'at logged entry' : `${delta > 0 ? '+' : ''}${delta}s from entry`

  return (
    <div className="border-t border-gray-800 p-2.5 space-y-2 bg-gray-950/40">
      <div className="relative w-full rounded-md overflow-hidden bg-black/40 border border-gray-800" style={{ minHeight: 100 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview} alt="entry frame preview" className="w-full block" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Loader2 className="w-4 h-4 animate-spin text-gray-300" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-500 font-mono w-8 text-right">-{RANGE}s</span>
        <input
          type="range" min={-RANGE} max={RANGE} step={1}
          value={delta}
          onChange={e => setDelta(Number(e.target.value))}
          className="flex-1 accent-blue-500"
        />
        <span className="text-[10px] text-gray-500 font-mono w-8">+{RANGE}s</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-blue-300">{label}</span>
        <div className="flex items-center gap-2">
          {delta !== 0 && (
            <button type="button" onClick={() => setDelta(0)} className="text-[10px] text-gray-400 hover:text-white">Reset</button>
          )}
          <button type="button" onClick={onClose} className="text-[10px] text-gray-400 hover:text-white px-1">Cancel</button>
          <button
            type="button"
            onClick={() => onPicked(delta, preview)}
            disabled={loading}
            className="inline-flex items-center gap-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors"
          >
            <Check className="w-3 h-3" /> Use this frame
          </button>
        </div>
      </div>
    </div>
  )
}
