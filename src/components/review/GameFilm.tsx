'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { GhostButton } from '@/components/ui/Section'
import type { TradeVerdict } from '@/lib/supabase/types'

/**
 * Game film — the week's trade screenshots as a catalog you flip through, one
 * frame at a time, and put YOUR call on. Good / Mistake / Unsure + one line.
 *
 * Deliberately shows nothing from the coach: these verdicts are the
 * calibration set the screenshot-coach will be graded against, so they must
 * be the trader's unanchored read. The strip below the frame is the ONE place
 * the film motif is allowed to live (locked identity) — a row of stills with a
 * perforated edge, nothing more.
 */

export interface FilmFrame {
  tradeId: string
  /** Signed URL, resolved server-side. */
  src: string
  /** e.g. "Mon Aug 3" */
  day: string
  /** e.g. "06:41 PT" */
  time: string
  href: string
  symbol: string | null
  direction: 'long' | 'short' | null
  pnl: number | null
  r: number | null
  /** 0–100 or null. */
  capture: number | null
  setups: string[]
  read: string | null
  verdict: TradeVerdict | null
}

interface Props {
  frames: FilmFrame[]
  /** Trades this week that have no screenshot — stated, not hidden. */
  missing: number
  migrationPending: boolean
}

const CALL_META: Record<TradeVerdict['call'], { label: string; cls: string; dot: string }> = {
  good: { label: 'Good', cls: 'text-green-400', dot: 'bg-green-400' },
  mistake: { label: 'Mistake', cls: 'text-red-400', dot: 'bg-red-400' },
  unsure: { label: 'Unsure', cls: 'text-gray-400', dot: 'bg-gray-500' },
}

const fmtUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString()}`
const fmtR = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}R`

export default function GameFilm({ frames, missing, migrationPending }: Props) {
  const [idx, setIdx] = useState(0)
  const [verdicts, setVerdicts] = useState<Record<string, TradeVerdict | null>>(
    () => Object.fromEntries(frames.map(f => [f.tradeId, f.verdict])),
  )
  const containerRef = useRef<HTMLDivElement>(null)

  const n = frames.length
  const go = useCallback((d: number) => setIdx(i => (n === 0 ? 0 : (i + d + n) % n)), [n])

  // Arrow keys flip frames while the catalog is on screen and focus isn't in
  // a text field — the note input needs its own arrows.
  useEffect(() => {
    if (n < 2) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const el = containerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const onScreen = r.bottom > 0 && r.top < window.innerHeight
      if (!onScreen) return
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, n])

  if (n === 0) {
    return (
      <p className="text-[13px] text-gray-500 max-w-[62ch]">
        No screenshots this week{missing > 0 ? ` — ${missing} trade${missing === 1 ? '' : 's'} logged without one` : ''}.
        Attach a chart capture to a trade and it shows up here to review.
      </p>
    )
  }

  const f = frames[Math.min(idx, n - 1)]
  const labelled = frames.filter(fr => verdicts[fr.tradeId]).length

  return (
    <div ref={containerRef}>
      {/* Frame header — where you are, what the trade was */}
      <div className="flex items-baseline justify-between gap-4 flex-wrap mb-2.5">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[13.5px] font-semibold text-gray-100 whitespace-nowrap">
            {f.day} <span className="text-gray-500 font-normal">{f.time}</span>
          </span>
          {(f.symbol || f.direction) && (
            <span className="text-[12.5px] text-gray-400 whitespace-nowrap">
              {f.direction === 'long' ? 'Long' : f.direction === 'short' ? 'Short' : ''}{f.symbol ? ` ${f.symbol}` : ''}
            </span>
          )}
          {f.setups.length > 0 && (
            <span className="text-[12.5px] text-gray-400 truncate">{f.setups.join(' · ')}</span>
          )}
        </div>
        <div className="flex items-baseline gap-4 text-[13px] tabular-nums whitespace-nowrap">
          {f.pnl != null && <span className={f.pnl > 0 ? 'text-green-400' : f.pnl < 0 ? 'text-red-400' : 'text-gray-400'}>{fmtUsd(f.pnl)}</span>}
          {f.r != null && <span className={f.r > 0 ? 'text-green-400' : f.r < 0 ? 'text-red-400' : 'text-gray-400'}>{fmtR(f.r)}</span>}
          {f.capture != null && <span className="text-gray-300">{f.capture}% <span className="text-gray-600">kept</span></span>}
          <span className="text-gray-600">{idx + 1} / {n}</span>
        </div>
      </div>

      {/* The frame */}
      <div className="relative bg-gray-950 border border-gray-800 rounded overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL, arbitrary size; next/image needs a fixed remote pattern */}
        <img
          src={f.src}
          alt={`${f.day} ${f.time} trade screenshot`}
          className="block w-full max-h-[70vh] object-contain mx-auto"
          draggable={false}
        />
        {n > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous trade"
              onClick={() => go(-1)}
              className="absolute left-0 top-0 bottom-0 w-14 text-gray-500 hover:text-gray-100 hover:bg-gray-950/50 transition-colors text-2xl"
            >‹</button>
            <button
              type="button"
              aria-label="Next trade"
              onClick={() => go(1)}
              className="absolute right-0 top-0 bottom-0 w-14 text-gray-500 hover:text-gray-100 hover:bg-gray-950/50 transition-colors text-2xl"
            >›</button>
          </>
        )}
      </div>

      {/* Verdict — the one affordance */}
      <VerdictRow
        key={f.tradeId}
        tradeId={f.tradeId}
        value={verdicts[f.tradeId] ?? null}
        migrationPending={migrationPending}
        onSaved={v => setVerdicts(prev => ({ ...prev, [f.tradeId]: v }))}
        onNext={n > 1 ? () => go(1) : undefined}
      />

      {/* The strip — stills with one perforated edge */}
      <div className="mt-4 relative">
        <div
          className="flex gap-1.5 overflow-x-auto pb-2.5"
          style={{
            // The single film nod: a row of sprocket holes under the stills.
            backgroundImage: 'radial-gradient(circle, var(--color-surface-3) 1.2px, transparent 1.4px)',
            backgroundSize: '10px 6px',
            backgroundRepeat: 'repeat-x',
            backgroundPosition: '0 100%',
          }}
        >
          {frames.map((fr, i) => {
            const v = verdicts[fr.tradeId]
            return (
              <button
                key={fr.tradeId}
                type="button"
                onClick={() => setIdx(i)}
                aria-label={`${fr.day} ${fr.time}`}
                aria-current={i === idx ? 'true' : undefined}
                className={cn(
                  'relative flex-shrink-0 w-[92px] h-[56px] border overflow-hidden bg-gray-950 transition-colors',
                  i === idx ? 'border-blue-400' : 'border-gray-800 hover:border-gray-600',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fr.src} alt="" className="w-full h-full object-cover opacity-90" loading="lazy" draggable={false} />
                {v && <span className={cn('absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full', CALL_META[v.call].dot)} />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-baseline gap-4 mt-2 text-[12px] text-gray-600">
        <span>{labelled} of {n} reviewed</span>
        {missing > 0 && <span>{missing} trade{missing === 1 ? '' : 's'} this week without a screenshot</span>}
        {n > 1 && <span className="ml-auto">← → to flip</span>}
      </div>
    </div>
  )
}

function VerdictRow({ tradeId, value, migrationPending, onSaved, onNext }: {
  tradeId: string
  value: TradeVerdict | null
  migrationPending: boolean
  onSaved: (v: TradeVerdict | null) => void
  onNext?: () => void
}) {
  const [call, setCall] = useState<TradeVerdict['call'] | null>(value?.call ?? null)
  const [note, setNote] = useState(value?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const dirty = call !== (value?.call ?? null) || note !== (value?.note ?? '')

  const save = async () => {
    if (!call) return
    setSaving(true)
    setStatus(null)
    try {
      const res = await fetch(`/api/trades/${tradeId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: { call, note } }),
      })
      const data = await res.json()
      if (!res.ok) { setStatus(data.error ?? `Save failed (${res.status})`); return }
      onSaved(data.review?.verdict ?? { call, note, at: new Date().toISOString() })
      setStatus('Saved')
      onNext?.()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 flex items-center gap-3 flex-wrap">
      <span className="text-[12.5px] text-gray-500 whitespace-nowrap">Your call</span>
      <div className="inline-flex border border-gray-700 rounded overflow-hidden text-[12.5px]">
        {(Object.keys(CALL_META) as TradeVerdict['call'][]).map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setCall(k)}
            aria-pressed={call === k}
            className={cn(
              'px-3 py-1 border-r border-gray-700 last:border-r-0 transition-colors',
              call === k
                ? cn('bg-gray-800 shadow-[inset_0_-2px_0_currentColor]', CALL_META[k].cls)
                : 'text-gray-500 hover:text-gray-300',
            )}
          >
            {CALL_META[k].label}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={note}
        onChange={e => { setNote(e.target.value); setStatus(null) }}
        onKeyDown={e => { if (e.key === 'Enter' && call && dirty && !saving) save() }}
        placeholder="One line — what you see in hindsight"
        maxLength={500}
        className="flex-1 min-w-[220px] bg-gray-900 border border-gray-800 text-gray-200 rounded px-3 py-1.5 text-[13px] placeholder-gray-600 focus:outline-none focus:border-gray-600"
      />
      <GhostButton onClick={save} disabled={!call || !dirty || saving}>{saving ? 'Saving…' : 'Save'}</GhostButton>
      {status && <span className={cn('text-[12px]', status === 'Saved' ? 'text-green-400' : 'text-red-400')}>{status}</span>}
      {value && !dirty && !status && (
        <span className="text-[12px] text-gray-600">Reviewed</span>
      )}
      {migrationPending && <span className="text-[12px] text-gray-600">review_json column missing on this DB — apply 20260814_trade_review.sql to save.</span>}
    </div>
  )
}
