'use client'

import { useMemo } from 'react'
import { GraduationCap } from 'lucide-react'
import { computeCoachScore, type GradableTrade } from '@/lib/coach-score'

const SYM: Record<string, string> = { pass: '✓', fail: '✗', na: '–', unknown: '?' }

/** Banded coloring by score, mirroring the dashboard Process column bands. */
function band(score: number | null): string {
  if (score == null) return 'bg-gray-800 border-gray-700 text-gray-500'
  if (score >= 9) return 'bg-emerald-900/40 border-emerald-700 text-emerald-300'
  if (score >= 7) return 'bg-green-900/30 border-green-800 text-green-400'
  if (score >= 5) return 'bg-amber-900/30 border-amber-800 text-amber-400'
  if (score >= 3) return 'bg-orange-900/30 border-orange-800 text-orange-400'
  return 'bg-red-900/40 border-red-800 text-red-400'
}

/**
 * Compact Coach Score pill for a trade row — the deterministic 0–10 execution
 * grade with a criterion-by-criterion tooltip. The `·N?` suffix flags how many
 * criteria are still `unknown` (needing the Coach Score AI pass to resolve).
 */
export default function CoachScoreBadge({
  trade,
  setupLibrary,
}: {
  trade: GradableTrade
  setupLibrary?: Set<string>
}) {
  const cs = useMemo(() => computeCoachScore(trade, { setupLibrary }), [trade, setupLibrary])

  const lines = cs.criteria.map(c => `${SYM[c.status]} ${c.label}${c.reason ? ` (${c.reason})` : ''}`)
  const tip =
    `Coach Score ${cs.score ?? '—'}/10 — ${cs.passes}✓ ${cs.fails}✗ of ${cs.total} rated` +
    (cs.unknownCount ? `, ${cs.unknownCount} need Coach Score AI` : '') +
    `\n\n${lines.join('\n')}`

  return (
    <span
      title={tip}
      className={`inline-flex items-center gap-0.5 text-[11px] font-bold px-1.5 py-0.5 rounded border shrink-0 leading-none ${band(cs.score)}`}
    >
      <GraduationCap className="w-3 h-3 opacity-70" />
      {cs.score ?? '—'}
      {cs.unknownCount > 0 && <span className="font-normal opacity-60">·{cs.unknownCount}?</span>}
    </span>
  )
}
