'use client'

import { useEffect, useRef, useState } from 'react'
import { Info, X } from 'lucide-react'

/**
 * Shared One-TapeScore hero primitives (Pt 13).
 *
 * The 0-100 ring, the component chip, and the band→color map are used by BOTH
 * the Detailed dashboard hero (DashboardStats) and the Highlights hero
 * (BeginnerDashboard) so the score reads identically in both modes — "one
 * score everywhere." Keep these free of period/verdict logic; each hero owns
 * its own surrounding copy.
 */

export type HeroBand = 'high' | 'mid' | 'low' | null

/**
 * In-product publication of the TapeScore formula (Pt 20 · Ticket 4b) — an info
 * popover on the score showing the exact components and weights, so the headline
 * number is fully defensible (no black box). Kept in sync with src/lib/tapescore.ts.
 * Shared by every hero that renders a TapeScore (dashboard period + EOD day).
 */
export function TapeScoreFormulaInfo() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <span className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`transition-colors ${open ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
        aria-label="How TapeScore is calculated"
        title="How TapeScore is calculated"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute z-50 top-6 left-0 w-80 bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl font-normal normal-case">
          <div className="flex items-start justify-between mb-2">
            <p className="font-semibold text-white">How TapeScore is calculated</p>
            <button type="button" onClick={() => setOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="mb-2 text-gray-400">One 0-100 score per session — a weighted blend of three layers:</p>
          <ul className="space-y-1.5 mb-2">
            <li className="flex justify-between gap-3">
              <span><strong className="text-gray-200">Risk limits kept</strong> — of the 5 account guardrails</span>
              <span className="font-mono text-gray-400 shrink-0">50%</span>
            </li>
            <li className="flex justify-between gap-3">
              <span><strong className="text-gray-200">Execution quality</strong> — entry/stop/target, capture</span>
              <span className="font-mono text-gray-400 shrink-0">35%</span>
            </li>
            <li className="flex justify-between gap-3">
              <span><strong className="text-gray-200">Prep quality</strong> — morning plan grade</span>
              <span className="font-mono text-gray-400 shrink-0">15%</span>
            </li>
          </ul>
          <p className="text-gray-500">A session that breaks 2 or more of the 5 risk rails is capped at 49 (can&apos;t read green or amber). Missing a layer re-weights the rest. A period score is the mean of its scored days.</p>
        </div>
      )}
    </span>
  )
}

/** Band → color classes shared by the ring stroke and the score text. */
export function bandColors(band: HeroBand): { stroke: string; text: string } {
  switch (band) {
    case 'high': return { stroke: '#4ade80', text: 'text-green-400' }
    case 'mid': return { stroke: '#fbbf24', text: 'text-amber-300' }
    case 'low': return { stroke: '#f87171', text: 'text-red-400' }
    default: return { stroke: '#374151', text: 'text-gray-500' }
  }
}

/** The 0-100 TapeScore ring. `score` null renders an em-dash with a grey ring. */
export function TapeScoreRing({ score, band, title }: {
  score: number | null
  band: HeroBand
  title?: string
}) {
  const colors = bandColors(band)
  const R = 40
  const CIRC = 2 * Math.PI * R
  const dash = score != null ? (score / 100) * CIRC : 0
  return (
    <div className="relative w-[92px] h-[92px] shrink-0" title={title}>
      <svg width="92" height="92" viewBox="0 0 92 92" className="-rotate-90">
        <circle cx="46" cy="46" r={R} fill="none" stroke="#1f2937" strokeWidth="7" />
        {score != null && (
          <circle
            cx="46" cy="46" r={R} fill="none"
            stroke={colors.stroke} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div className={`font-mono text-[26px] font-extrabold ${colors.text}`}>{score ?? '—'}</div>
          <div className="text-[8px] tracking-[0.14em] text-gray-500 mt-0.5">TAPESCORE</div>
        </div>
      </div>
    </div>
  )
}

/** A single component chip (Rules kept / Execution / Prep). */
export function HeroChip({ label, tone, title }: { label: string; tone: 'good' | 'mid' | 'bad'; title: string }) {
  const cls =
    tone === 'good' ? 'border-green-800/60 text-green-300 bg-green-950/40'
    : tone === 'mid' ? 'border-amber-800/60 text-amber-300 bg-amber-950/40'
    : 'border-red-800/60 text-red-300 bg-red-950/40'
  return (
    <span className={`inline-flex items-center text-[11px] px-2.5 py-0.5 rounded-full border whitespace-nowrap ${cls}`} title={title}>
      {label}
    </span>
  )
}
