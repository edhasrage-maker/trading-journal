'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Video, Loader2, AlertCircle, Film, Anchor, Upload, Info } from 'lucide-react'
import { VideoFrameGrabber, parseObsFilenameStartMs } from '@/lib/browser-frames'
import type { Trade } from '@/lib/supabase/types'

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

export default function BrowserRecap({ trades, date }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [grabber, setGrabber] = useState<VideoFrameGrabber | null>(null)
  const [duration, setDuration] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingVideo, setLoadingVideo] = useState(false)

  const [anchor, setAnchor] = useState<AnchorState | null>(null)

  // Per-trade extracted entry frames (data URLs) + extraction progress.
  const [frames, setFrames] = useState<Record<string, string>>({})
  const [extracting, setExtracting] = useState(false)
  const [extractProgress, setExtractProgress] = useState(0)

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

  // Tear down the grabber when it changes or the component unmounts.
  useEffect(() => () => { grabber?.dispose() }, [grabber])

  // Load a picked file → build a grabber, read metadata, seed/restore the anchor.
  const onPick = useCallback(async (picked: File) => {
    setLoadError(null)
    setFrames({})
    setLoadingVideo(true)
    // Dispose any previous grabber before replacing it.
    setGrabber(prev => { prev?.dispose(); return null })

    const g = new VideoFrameGrabber(picked)
    try {
      await g.ready
    } catch (e) {
      g.dispose()
      setLoadingVideo(false)
      setLoadError(e instanceof Error ? e.message : 'Could not load recording.')
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

  /** Video seconds to seek to for a trade's entry, under the current anchor. */
  const offsetForEntry = useCallback((iso: string): number => {
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

  // Extract an entry frame for every timed trade in range, sequentially.
  const extractAll = useCallback(async () => {
    if (!grabber || !anchor) return
    setExtracting(true)
    setExtractProgress(0)
    const out: Record<string, string> = {}
    let done = 0
    for (const t of timedTrades) {
      const off = offsetForEntry(t.entry_time!)
      if (Number.isFinite(off) && off >= 0 && off <= duration) {
        try { out[t.id] = await grabber.grab(off) } catch { /* skip this frame */ }
      }
      done++
      setExtractProgress(done / timedTrades.length)
    }
    setFrames(out)
    setExtracting(false)
  }, [grabber, anchor, timedTrades, offsetForEntry, duration])

  const inRangeCount = useMemo(() => {
    if (!anchor) return 0
    return timedTrades.reduce((n, t) => {
      const off = offsetForEntry(t.entry_time!)
      return n + (Number.isFinite(off) && off >= 0 && off <= duration ? 1 : 0)
    }, 0)
  }, [timedTrades, offsetForEntry, duration, anchor])

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
        <span className="text-gray-400">The video never leaves your device</span> — frames are extracted right here.
        MP4 / H.264 recordings work best. AI commentary is coming soon.
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
                  const off = first?.entry_time ? offsetForEntry(first.entry_time) : 0
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

      {/* Frame grid */}
      {Object.keys(frames).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {timedTrades.map((t, i) => {
            const frame = frames[t.id]
            if (!frame) return null
            const dir = t.direction?.toUpperCase() ?? '—'
            const dirTone = t.direction === 'long' ? 'text-green-300 bg-green-900/30 border-green-800'
              : t.direction === 'short' ? 'text-red-300 bg-red-900/30 border-red-800'
                : 'text-gray-400 bg-gray-800 border-gray-700'
            return (
              <div key={t.id} className="border border-gray-800 rounded-lg overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frame} alt={`Trade ${i + 1} entry frame`} className="w-full block bg-black" />
                <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] font-mono text-gray-400">
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
