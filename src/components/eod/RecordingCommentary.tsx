'use client'

import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Video, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import type { Trade } from '@/lib/supabase/types'

interface VideoFile { name: string; sizeBytes: number; mtimeMs: number }
interface CommentaryResponse {
  commentary: Record<string, string>
  suggested_mistakes?: Record<string, string[]>
  skipped: Array<{ id: string; reason: string }>
  framesUsed?: number
  recordingStartIso?: string
  durationSec?: number
  note?: string
  error?: string
  hint?: string
}

interface Props {
  trades: Trade[]
  /** Called after a mistake chip is applied so the parent can re-fetch
   *  (the trade's tags_json changed on the server). */
  onTradesChanged?: () => void
}

/**
 * Stable hash over the fields that affect the AI commentary, plus the
 * selected recording. Same djb2 helper used elsewhere — kept inline so this
 * component is self-contained.
 */
function hashTradeForCommentary(t: Trade, videoFile: string): string {
  const basis = JSON.stringify({
    e: t.entry_price, x: t.exit_price, p: t.pnl, q: t.quantity, d: t.direction,
    et: t.entry_time, xt: t.exit_time, tg: t.tags_json, n: t.notes, v: videoFile,
  })
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const cacheKey = (id: string) => `recording-commentary-${id}`
const mistakeKey = (id: string) => `recording-mistakes-${id}`

/**
 * Extract the AI text from whatever shape the recording_commentary column
 * holds for this trade. Three forms have shown up in the wild:
 *
 *   1. Proper object `{ text, video_file, model, generated_at }` written by
 *      this PC's /api/video/commentary route. Validates the video_file
 *      matches the selected recording so switching videos doesn't surface
 *      mismatched commentary.
 *   2. JSON-stringified `{ text }` written by the main PC's earlier
 *      persistence experiment. No video_file present — we display
 *      unconditionally since the user clearly generated it and wants to
 *      see it regardless of which recording is loaded now.
 *   3. Plain text string (no JSON wrapper). Display as-is.
 *
 * Returns null when there's no usable text to show.
 */
function extractCommentaryText(raw: unknown, selectedVideo: string): string | null {
  if (raw == null) return null
  // Form 1: proper object
  if (typeof raw === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = raw as any
    if (typeof obj.text === 'string' && obj.text.length > 0) {
      // If video_file is recorded, only use when it matches; otherwise display.
      if (obj.video_file && obj.video_file !== selectedVideo) return null
      return obj.text
    }
    return null
  }
  // Form 2 or 3: string — could be JSON-encoded or plain text
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed) as { text?: string }
        if (typeof parsed.text === 'string' && parsed.text.length > 0) return parsed.text
      } catch { /* fall through to treat as plain text */ }
    }
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

export default function RecordingCommentary({ trades, onTradesChanged }: Props) {
  const [files, setFiles] = useState<VideoFile[]>([])
  const [dir, setDir] = useState<string>('')
  const [filesError, setFilesError] = useState<string | null>(null)
  const [videoFile, setVideoFile] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CommentaryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [commentary, setCommentary] = useState<Record<string, string>>({})
  const [suggestedMistakes, setSuggestedMistakes] = useState<Record<string, string[]>>({})
  const [applyingFor, setApplyingFor] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Record<string, Set<string>>>({})

  // Load available recordings on mount.
  useEffect(() => {
    fetch('/api/video/list')
      .then(r => r.json())
      .then((d: { files?: VideoFile[]; dir?: string; error?: string }) => {
        setFiles(d.files ?? [])
        if (d.dir) setDir(d.dir)
        if (d.error) setFilesError(d.error)
      })
      .catch(() => setFilesError('Failed to list recordings.'))
  }, [])

  // Hydrate cached commentaries + mistake suggestions whenever the selected
  // video or trades change. Priority order:
  //   1. trades[].recording_commentary (Supabase-backed, cross-PC). The
  //      extractCommentaryText() helper above handles the two known shapes
  //      (new typed object vs. legacy stringified-JSON from the main PC's
  //      earlier persistence experiment) so both paths surface.
  //   2. localStorage (per-PC speed cache, also hash-checked).
  // Mistake suggestions are localStorage-only for now — they haven't been
  // migrated into the DB column yet.
  useEffect(() => {
    if (!videoFile || trades.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing cached commentaries when no recording is selected
      setCommentary({})
      setSuggestedMistakes({})
      return
    }
    const cached: Record<string, string> = {}
    const cachedMistakes: Record<string, string[]> = {}
    for (const t of trades) {
      const text = extractCommentaryText(t.recording_commentary, videoFile)
      if (text) { cached[t.id] = text; continue }
      // localStorage fallback (legacy path / fresh-DB users)
      try {
        const raw = localStorage.getItem(cacheKey(t.id))
        if (raw) {
          const c = JSON.parse(raw) as { h: string; s: string }
          if (c.h === hashTradeForCommentary(t, videoFile) && c.s) cached[t.id] = c.s
        }
        const rawM = localStorage.getItem(mistakeKey(t.id))
        if (rawM) {
          const m = JSON.parse(rawM) as { h: string; m: string[] }
          if (m.h === hashTradeForCommentary(t, videoFile) && Array.isArray(m.m) && m.m.length > 0) {
            cachedMistakes[t.id] = m.m
          }
        }
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating commentary cache from server + local sources
    setCommentary(cached)
    setSuggestedMistakes(cachedMistakes)
  }, [videoFile, trades])

  const run = useCallback(async () => {
    if (!videoFile || trades.length === 0) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/video/commentary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoFile,
          trades: trades.map(t => ({
            id: t.id, direction: t.direction, entry_price: t.entry_price, exit_price: t.exit_price,
            quantity: t.quantity, pnl: t.pnl, entry_time: t.entry_time, exit_time: t.exit_time,
            tags_json: t.tags_json, notes: t.notes,
          })),
        }),
      })
      const data = (await res.json()) as CommentaryResponse
      if (!res.ok) {
        setError(data.error ?? 'Commentary failed')
        return
      }
      setResult(data)
      const got = data.commentary ?? {}
      const gotMistakes = data.suggested_mistakes ?? {}
      setCommentary(prev => ({ ...prev, ...got }))
      setSuggestedMistakes(prev => ({ ...prev, ...gotMistakes }))
      for (const t of trades) {
        if (got[t.id]) {
          try { localStorage.setItem(cacheKey(t.id), JSON.stringify({ h: hashTradeForCommentary(t, videoFile), s: got[t.id] })) } catch { /* ignore */ }
        }
        if (gotMistakes[t.id]?.length) {
          try { localStorage.setItem(mistakeKey(t.id), JSON.stringify({ h: hashTradeForCommentary(t, videoFile), m: gotMistakes[t.id] })) } catch { /* ignore */ }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
    } finally {
      setRunning(false)
    }
  }, [videoFile, trades])

  const canRun = !!videoFile && trades.length > 0 && !running
  const skippedById = new Map((result?.skipped ?? []).map(s => [s.id, s.reason]))

  const applyMistake = async (trade: Trade, label: string) => {
    const key = `${trade.id}:${label}`
    setApplyingFor(key)
    try {
      const tj = trade.tags_json ?? {}
      const current: string[] = Array.isArray(tj.mistakes) ? tj.mistakes : []
      if (current.includes(label)) return // already applied — no-op
      const nextTags = { ...tj, mistakes: [...current, label] }
      const res = await fetch(`/api/trades/${trade.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags_json: nextTags }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        setError(`Apply failed: ${err.error ?? res.statusText}`)
        return
      }
      onTradesChanged?.()
    } catch (e) {
      setError(`Apply failed: ${e instanceof Error ? e.message : 'unknown'}`)
    } finally {
      setApplyingFor(null)
    }
  }

  const dismissMistake = (tradeId: string, label: string) => {
    setDismissed(prev => {
      const next = new Set(prev[tradeId] ?? [])
      next.add(label)
      return { ...prev, [tradeId]: next }
    })
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Video className="w-4 h-4 text-blue-400" />
        <h2 className="font-semibold text-white text-sm">Recording commentary</h2>
      </div>
      <p className="text-xs text-gray-500">
        Pick an OBS recording of this session. The AI coach pulls a frame at each trade&apos;s entry (and exit) and
        commentates on what was on screen vs. what you did. Frames stay on this machine.
        {dir && <span className="block mt-1 font-mono text-gray-600">{dir}</span>}
      </p>

      {files.length === 0 ? (
        <div className="text-xs text-yellow-300/80 bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-3">
          {filesError ?? 'No recordings found. Set '}<code className="text-yellow-200">OBS_RECORDINGS_DIR</code>{' in .env.local if your OBS output lives elsewhere.'}
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <label className="block text-xs text-gray-400 mb-1">Recording</label>
            <select
              value={videoFile}
              onChange={e => setVideoFile(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
            >
              <option value="">Select a recording…</option>
              {files.map(f => (
                <option key={f.name} value={f.name}>
                  {f.name} ({(f.sizeBytes / 1e9).toFixed(2)} GB · {format(new Date(f.mtimeMs), 'MMM d HH:mm')})
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={!canRun}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Video className="w-4 h-4" />}
            {running ? 'Reading frames…' : 'Run commentary'}
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {result && !error && (
        <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-xs text-green-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            Used {result.framesUsed ?? 0} frame{result.framesUsed === 1 ? '' : 's'} across {Object.keys(result.commentary ?? {}).length} trade{Object.keys(result.commentary ?? {}).length === 1 ? '' : 's'}
            {result.recordingStartIso && (
              <span className="text-green-300/80"> · recording started {format(new Date(result.recordingStartIso), 'HH:mm:ss')}</span>
            )}
            {result.skipped && result.skipped.length > 0 && (
              <span className="text-yellow-300/80"> · {result.skipped.length} trade{result.skipped.length === 1 ? '' : 's'} skipped</span>
            )}
            {result.note && <div className="mt-1 text-green-300/80">{result.note}</div>}
          </div>
        </div>
      )}

      {Object.keys(commentary).length > 0 || skippedById.size > 0 ? (
        <div className="space-y-2 pt-1">
          {trades.map(t => {
            const c = commentary[t.id]
            const skip = skippedById.get(t.id)
            if (!c && !skip) return null
            const dir = t.direction?.toUpperCase() ?? '—'
            const dirTone = t.direction === 'long' ? 'text-green-300 bg-green-900/30 border-green-800'
              : t.direction === 'short' ? 'text-red-300 bg-red-900/30 border-red-800'
                : 'text-gray-400 bg-gray-800 border-gray-700'
            // Surface suggestions only if they're not already on the trade and
            // haven't been dismissed in this session — keeps the UI quiet once
            // the user has triaged them.
            const alreadyOnTrade = new Set(
              Array.isArray(t.tags_json?.mistakes) ? (t.tags_json.mistakes as string[]) : [],
            )
            const dismissedForTrade = dismissed[t.id] ?? new Set<string>()
            const liveSuggestions = (suggestedMistakes[t.id] ?? []).filter(
              m => !alreadyOnTrade.has(m) && !dismissedForTrade.has(m),
            )
            return (
              <div key={t.id} className="border border-gray-800 rounded-lg p-3 text-xs">
                <div className="flex items-center gap-2 mb-1 font-mono text-gray-400">
                  <span>{t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '—'}</span>
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${dirTone}`}>{dir}</span>
                  <span>{t.quantity ?? '?'} @ {t.entry_price ?? '?'}</span>
                  {t.pnl != null && (
                    <span className={`ml-auto font-bold ${t.pnl > 0 ? 'text-green-400' : t.pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                      {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                    </span>
                  )}
                </div>
                {c ? (
                  <p className="text-gray-200 leading-snug">{c}</p>
                ) : (
                  <p className="text-gray-600 italic">Skipped: {skip}</p>
                )}
                {liveSuggestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500 mr-1">Suggested mistakes:</span>
                    {liveSuggestions.map(m => {
                      const isApplying = applyingFor === `${t.id}:${m}`
                      return (
                        <span key={m} className="inline-flex items-center gap-0.5">
                          <button
                            type="button"
                            disabled={isApplying || applyingFor !== null}
                            onClick={() => void applyMistake(t, m)}
                            className="px-2 py-0.5 rounded-full text-[11px] font-medium border border-dashed border-red-700/70 text-red-300 hover:bg-red-900/30 hover:border-red-500 disabled:opacity-50 transition-colors"
                            title={`Add "${m}" to this trade's mistakes`}
                          >
                            {isApplying ? '…' : `+ ${m}`}
                          </button>
                          <button
                            type="button"
                            onClick={() => dismissMistake(t.id, m)}
                            className="text-gray-600 hover:text-gray-400 text-[10px] px-0.5"
                            title="Dismiss this suggestion (session only)"
                          >
                            ✕
                          </button>
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
