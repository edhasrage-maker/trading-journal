'use client'

import { ChevronDown, ChevronUp } from 'lucide-react'
import type { TradeFlowScore } from '@/lib/supabase/types'

const DOT: Record<string, string> = {
  with: 'bg-emerald-400',
  neutral: 'bg-gray-600',
  against: 'bg-red-400',
}

/**
 * The trade's Score, out of 100, read from the tape at the fill. Just the
 * number; click to open the five reasons (ScoreDetail) under the row. It is
 * not derived from the result.
 */
export function ScoreChip({ score, open, onToggle }: { score: TradeFlowScore; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle() }}
      aria-expanded={open}
      title="Score out of 100. Click to see why."
      className="inline-flex items-center gap-1.5 text-[11px] font-bold px-1.5 py-0.5 rounded border border-gray-700 bg-gray-900 text-gray-200 hover:border-gray-500 shrink-0 leading-none align-middle"
    >
      <span className="tabular-nums">{score.total}</span>
      {open ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
    </button>
  )
}

/** The five facts behind a Score, one line each. */
export function ScoreDetail({ score }: { score: TradeFlowScore }) {
  return (
    <div className="font-sans text-xs text-gray-300 py-2 max-w-2xl">
      <div className="grid grid-cols-[10px_minmax(96px,150px)_minmax(0,1fr)_40px] gap-x-2 gap-y-1 items-baseline">
        {score.facts.map(f => (
          <div key={f.k} className="contents">
            <span className={`w-1.5 h-1.5 rounded-full self-center ${DOT[f.state] ?? DOT.neutral}`} aria-hidden="true" />
            <span className="text-gray-500">{f.label}</span>
            <span>{f.text}</span>
            <span className="text-right text-gray-500 tabular-nums">{f.pts}/{f.max}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-[11px] text-gray-600">
        Score {score.total} of {score.max}. Read from the tape at {score.read_at} PT, before the result was known.
      </div>
    </div>
  )
}
