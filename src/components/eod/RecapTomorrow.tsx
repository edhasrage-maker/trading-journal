'use client'

import { Loader2, Brain } from 'lucide-react'
import type { EodAiAnalysis } from '@/lib/supabase/types'
import { plainRuleCodes } from '@/lib/plain-rule-codes'

/**
 * Highlights' "For tomorrow" — the coach's Tomorrow lines, moved from the foot
 * of the page to second place under the score (founder, 2026-10-29;
 * docs/tapescore-recap-highlights-mockup-r1.html). The same lines show at the
 * top of the next session's Prep.
 *
 * On a day that hasn't been graded it is where the Grade button lives, so a
 * new trader's one next step is near the top, not under the notes.
 */
export default function RecapTomorrow({
  analysis,
  loading,
  onAnalyze,
  disabled,
  hasTrades,
}: {
  analysis: EodAiAnalysis | null
  loading: boolean
  onAnalyze: () => void
  disabled?: boolean
  hasTrades: boolean
}) {
  const focus = (analysis?.next_session_focus ?? []).filter(t => t?.trim()).map(plainRuleCodes)

  if (!analysis) {
    if (!hasTrades && !loading) return null
    return (
      <div className="rounded-xl border p-5" style={{ background: 'rgba(224,163,60,0.08)', borderColor: 'rgba(224,163,60,0.35)' }}>
        <p className="text-sm font-semibold text-amber-300 mb-1">Grade this session</p>
        <p className="text-sm text-gray-200 leading-relaxed">
          You get its TapeScore, what went well, what cost you, and the one or two things to do tomorrow.
        </p>
        <button
          type="button"
          onClick={onAnalyze}
          disabled={loading || disabled}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-400 disabled:opacity-60 disabled:cursor-not-allowed px-3.5 py-2 text-sm font-semibold text-gray-950 transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
          {loading ? 'Grading…' : 'Grade this session'}
        </button>
      </div>
    )
  }
  if (!focus.length) return null

  return (
    <div className="bg-gray-900 border border-gray-800 border-l-[3px] border-l-blue-500 rounded-xl p-5">
      <h2 className="flex items-baseline justify-between gap-3 mb-3">
        <span className="font-semibold text-white text-sm" style={{ fontFamily: 'var(--font-display)' }}>For tomorrow</span>
        <span className="text-[11px] text-gray-500">from the coach&rsquo;s read · also on your next Prep</span>
      </h2>
      <ol className="space-y-2">
        {focus.map((f, i) => (
          <li key={i} className="flex gap-2.5 text-[15px] text-gray-100 leading-snug">
            <span className="w-[22px] h-[22px] shrink-0 rounded-full bg-blue-950 text-blue-300 text-[12px] font-bold grid place-items-center" aria-hidden="true">
              {i + 1}
            </span>
            <span className="pt-px">{f}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
