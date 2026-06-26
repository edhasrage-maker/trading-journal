'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, X } from 'lucide-react'

/**
 * Frame-nudge scrubber. Previews the OBS recording frame at (entry_time + delta)
 * and lets the user drag a ±60s slider to land on the exact moment they entered,
 * then save it as the trade's screenshot.
 *
 * Why ±60s (not ±30): typed entry times round to the minute (9:42 → 9:42:00),
 * so the real fill is anywhere up to ~59s AFTER the logged time — a ±30 window
 * couldn't reach it. The slider is centered on the logged entry (delta 0).
 *
 * Preview frames are fetched debounced from /api/video/frame (save=false); the
 * final pick is saved server-side (save=true) which uploads + points the trade's
 * screenshot_url at it. onSaved fires with the new public URL.
 */

const RANGE = 60 // seconds either side of the logged entry

interface Props {
  videoFile: string
  entryTimeIso: string
  tradeId: string
  /** Starting delta (e.g. a previously-saved nudge), defaults to 0 = logged entry. */
  initialDelta?: number
  onSaved: (url: string) => void
  onClose?: () => void
}

export default function FrameNudge({ videoFile, entryTimeIso, tradeId, initialDelta = 0, onSaved, onClose }: Props) {
  const [delta, setDelta] = useState(initialDelta)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Token guards against out-of-order responses while dragging.
  const reqToken = useRef(0)

  const fetchPreview = useCallback(async (d: number) => {
    const token = ++reqToken.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/video/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoFile, entryTimeIso, deltaSec: d }),
      })
      const data = await res.json() as { frame?: string; error?: string }
      if (token !== reqToken.current) return // a newer request superseded this one
      if (!res.ok || !data.frame) { setError(data.error ?? 'Could not load frame'); return }
      setPreview(data.frame)
    } catch {
      if (token === reqToken.current) setError('Network error loading frame')
    } finally {
      if (token === reqToken.current) setLoading(false)
    }
  }, [videoFile, entryTimeIso])

  // Debounced preview whenever delta changes (and once on mount).
  useEffect(() => {
    const id = setTimeout(() => { void fetchPreview(delta) }, 250)
    return () => clearTimeout(id)
  }, [delta, fetchPreview])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/video/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoFile, entryTimeIso, deltaSec: delta, tradeId, save: true }),
      })
      const data = await res.json() as { url?: string; error?: string }
      if (!res.ok || !data.url) { setError(data.error ?? 'Save failed'); return }
      onSaved(data.url)
    } catch {
      setError('Network error saving frame')
    } finally {
      setSaving(false)
    }
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

      {/* Preview */}
      <div className="relative w-full rounded-md overflow-hidden bg-black/40 border border-gray-800" style={{ minHeight: 120 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && <img src={preview} alt="recording frame" className="w-full block" />}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
          </div>
        )}
        {!preview && !loading && error && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-red-400 px-3 text-center">{error}</div>
        )}
      </div>

      {/* Slider */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-gray-500 font-mono w-8 text-right">-{RANGE}s</span>
        <input
          type="range"
          min={-RANGE}
          max={RANGE}
          step={1}
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
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            Use this frame
          </button>
        </div>
      </div>
      {error && preview && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  )
}
