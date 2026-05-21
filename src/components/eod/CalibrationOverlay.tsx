'use client'

import { useCallback, useState } from 'react'
import { X } from 'lucide-react'
import type { PriceAnchor, TimeAnchor } from '@/lib/supabase/types'

export type CalibStep = 'high' | 'low' | 'start' | 'end'

export interface CalibDraft {
  high?: PriceAnchor
  low?: PriceAnchor
  start?: TimeAnchor
  end?: TimeAnchor
}

interface Props {
  step: CalibStep
  draft: CalibDraft
  onAnchorPlaced: (
    step: CalibStep,
    pos: { x_pct: number; y_pct: number },
    value: { price: number } | { time: string },
  ) => void
  onCancel: () => void
}

const INSTRUCTIONS: Record<CalibStep, string> = {
  high: 'Click on the price axis at a known HIGH price, then type that price.',
  low: 'Click on the price axis at a known LOW price, then type that price.',
  start: 'Click on the time axis at a known time, then type the time as HH:MM.',
  end: 'Click on the time axis at a different time, then type the time as HH:MM.',
}

const STEP_ORDER: CalibStep[] = ['high', 'low', 'start', 'end']

export default function CalibrationOverlay({ step, draft, onAnchorPlaced, onCancel }: Props) {
  const [pending, setPending] = useState<{ x_pct: number; y_pct: number } | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (pending) return // already placing — ignore further clicks until confirmed
    const rect = e.currentTarget.getBoundingClientRect()
    const x_pct = ((e.clientX - rect.left) / rect.width) * 100
    const y_pct = ((e.clientY - rect.top) / rect.height) * 100
    setPending({ x_pct, y_pct })
    setInputValue('')
    setError(null)
  }, [pending])

  const cancelPending = () => {
    setPending(null)
    setInputValue('')
    setError(null)
  }

  const submitPending = () => {
    if (!pending) return
    if (step === 'high' || step === 'low') {
      const v = Number(inputValue)
      if (!Number.isFinite(v)) {
        setError('Enter a numeric price')
        return
      }
      onAnchorPlaced(step, pending, { price: v })
    } else {
      const t = inputValue.trim()
      if (!/^\d{1,2}:\d{2}$/.test(t)) {
        setError('Enter time as HH:MM (24-hour)')
        return
      }
      const [h, m] = t.split(':').map(Number)
      if (h > 23 || m > 59) {
        setError('Hours must be 0-23 and minutes 0-59')
        return
      }
      onAnchorPlaced(step, pending, { time: t.padStart(5, '0') })
    }
    setPending(null)
    setInputValue('')
    setError(null)
  }

  const placedAnchors: { step: CalibStep; x: number; y: number; index: number }[] = []
  STEP_ORDER.forEach((s, i) => {
    const a = draft[s]
    if (a) placedAnchors.push({ step: s, x: a.x_pct, y: a.y_pct, index: i + 1 })
  })

  return (
    <>
      {/* Click capture overlay */}
      <div
        onClick={handleClick}
        className="absolute inset-0 cursor-crosshair"
        style={{ zIndex: 10 }}
      >
        {/* Already-placed anchor markers */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {placedAnchors.map(p => (
            <g key={p.step}>
              <circle
                cx={`${p.x}%`}
                cy={`${p.y}%`}
                r={11}
                fill="#3b82f6"
                fillOpacity={0.85}
                stroke="white"
                strokeWidth={2}
              />
              <text
                x={`${p.x}%`}
                y={`${p.y}%`}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="10"
                fontWeight="bold"
                fill="white"
              >
                {p.index}
              </text>
            </g>
          ))}
          {pending && (
            <g>
              <circle
                cx={`${pending.x_pct}%`}
                cy={`${pending.y_pct}%`}
                r={11}
                fill="#f59e0b"
                fillOpacity={0.9}
                stroke="white"
                strokeWidth={2}
              />
              <text
                x={`${pending.x_pct}%`}
                y={`${pending.y_pct}%`}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="10"
                fontWeight="bold"
                fill="white"
              >
                ?
              </text>
            </g>
          )}
        </svg>
      </div>

      {/* Instruction banner */}
      <div
        className="absolute left-0 right-0 bottom-0 bg-blue-950/95 border-t border-blue-700 px-4 py-3 text-sm text-blue-100 flex items-center justify-between gap-4"
        style={{ zIndex: 20 }}
      >
        <div className="flex items-center gap-3">
          <span className="bg-blue-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
            {STEP_ORDER.indexOf(step) + 1}
          </span>
          <span>{INSTRUCTIONS[step]}</span>
        </div>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 text-xs text-blue-300 hover:text-white"
          title="Cancel calibration"
        >
          <X className="w-3 h-3" /> Cancel
        </button>
      </div>

      {/* Floating input — shown after click */}
      {pending && (
        <div
          className="absolute bg-gray-900 border border-blue-500 rounded-lg shadow-lg px-3 py-2"
          style={{
            zIndex: 30,
            left: `${Math.min(Math.max(pending.x_pct, 4), 70)}%`,
            top: `calc(${Math.min(pending.y_pct + 4, 85)}% + 8px)`,
          }}
        >
          <div className="text-xs text-gray-400 mb-1">
            {step === 'high' || step === 'low' ? 'Price' : 'Time (HH:MM)'}
          </div>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              type={step === 'high' || step === 'low' ? 'number' : 'text'}
              step={step === 'high' || step === 'low' ? 'any' : undefined}
              value={inputValue}
              onChange={e => { setInputValue(e.target.value); setError(null) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); submitPending() }
                if (e.key === 'Escape') { e.preventDefault(); cancelPending() }
              }}
              placeholder={step === 'high' || step === 'low' ? '21345.50' : '09:30'}
              className="bg-gray-950 border border-gray-700 rounded px-2 py-1 text-sm text-white w-32 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={submitPending}
              className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium px-3 py-1 rounded"
            >
              Set
            </button>
            <button
              onClick={cancelPending}
              className="text-gray-400 hover:text-white text-xs"
            >
              Skip
            </button>
          </div>
          {error && <div className="text-xs text-red-400 mt-1">{error}</div>}
        </div>
      )}
    </>
  )
}
