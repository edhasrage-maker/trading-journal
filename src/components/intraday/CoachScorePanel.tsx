'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, GraduationCap, Loader2, Sparkles } from 'lucide-react'
import { computeCoachScore, applyAiResolutions, type GradableTrade, type CriterionStatus } from '@/lib/coach-score'

const SYM: Record<CriterionStatus, string> = { pass: '✓', fail: '✗', na: '–', unknown: '?' }
const STATUS_COLOR: Record<CriterionStatus, string> = {
  pass: 'text-emerald-400', fail: 'text-red-400', na: 'text-gray-500', unknown: 'text-amber-400',
}
function band(score: number | null): string {
  if (score == null) return 'text-gray-500'
  if (score >= 9) return 'text-emerald-300'
  if (score >= 7) return 'text-green-400'
  if (score >= 5) return 'text-amber-400'
  if (score >= 3) return 'text-orange-400'
  return 'text-red-400'
}

type Resolutions = Record<string, { status: 'pass' | 'fail' | 'na'; reason?: string }>

/**
 * Coach Score panel for a trade's expanded detail — the deterministic 0–10 grade
 * with a full criterion breakdown, plus the on-demand "Coach Score" AI button
 * that resolves the remaining `unknown` (judgment) criteria from the notes.
 * AI resolutions are held in local state (ephemeral) and folded in with
 * applyAiResolutions so the score refines live.
 *
 * Compact by default: only the header (score + pass/fail summary) shows; the
 * per-criterion breakdown is folded behind a click on all viewports so it
 * doesn't dominate the expanded trade row.
 */
export default function CoachScorePanel({
  trade,
  notes,
  setupLibrary,
  instrumentHasBars,
}: {
  trade: GradableTrade
  notes?: string | null
  setupLibrary?: Set<string>
  instrumentHasBars?: boolean
}) {
  const base = useMemo(() => computeCoachScore(trade, { setupLibrary, instrumentHasBars }), [trade, setupLibrary, instrumentHasBars])
  const [ai, setAi] = useState<Resolutions>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const cs = useMemo(() => applyAiResolutions(base, ai), [base, ai])
  const remaining = cs.unknownCount

  const askCoach = async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/trades/coach-score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade: { ...trade, notes: notes ?? '' } }),
      })
      const data = await res.json() as { resolutions?: Resolutions; error?: string }
      if (!res.ok) { setError(data.error ?? 'Coach Score failed'); return }
      setAi(prev => ({ ...prev, ...(data.resolutions ?? {}) }))
    } catch {
      setError('Coach Score request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Hide criterion breakdown' : 'Show criterion breakdown'}
          className="flex items-center gap-1.5 text-sm font-semibold text-gray-200 flex-wrap flex-1 min-w-0 text-left"
        >
          <ChevronDown className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          <GraduationCap className="w-4 h-4 text-gray-400" />
          Coach Score
          <span className={`ml-1 text-base font-bold ${band(cs.score)}`}>
            {cs.score ?? '—'}<span className="text-xs text-gray-500">/10</span>
          </span>
          <span className="text-[11px] text-gray-500">({cs.passes}✓ {cs.fails}✗ of {cs.total} rated)</span>
        </button>
        {remaining > 0 && (
          <button
            type="button"
            onClick={askCoach}
            disabled={loading}
            title={`Have the AI resolve ${remaining} judgment criterion${remaining === 1 ? '' : 'a'} from your notes`}
            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded border bg-amber-900/20 border-amber-800 text-amber-300 hover:bg-amber-900/40 disabled:opacity-50 shrink-0"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            Coach Score ({remaining})
          </button>
        )}
      </div>
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
      {open && (
        <ul className="space-y-0.5 text-xs mt-2">
          {cs.criteria.map(c => (
            <li key={c.key} className="flex items-start gap-2">
              <span className={`font-bold ${STATUS_COLOR[c.status]}`}>{SYM[c.status]}</span>
              <span className="text-gray-300">{c.label}</span>
              {c.reason && <span className="text-gray-500">— {c.reason}</span>}
              {c.source === 'ai' && <span className="text-[10px] text-amber-500/80 uppercase mt-0.5">ai</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
