'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, GraduationCap, Loader2, Sparkles } from 'lucide-react'
import { computeCoachScore, applyAiResolutions, type GradableTrade, type CriterionStatus } from '@/lib/coach-score'
import type { ScoringProfile } from '@/lib/scoring-profile'
import AiDisclaimer from '@/components/AiDisclaimer'

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
type AxisResult = { score: number | null; reason?: string } | null

/**
 * Coach Score panel for a trade's expanded detail. The 0–10 grade blends three
 * axes (Pt 11 reweight): Execution / rule-compliance (deterministic, free),
 * Market read, and Setup quality vs playbook (both AI-judged). Weights are
 * 60/20/20 with a playbook, 75/25 without (setup-quality dropped). Before the AI
 * pass only Execution is scored, so the header reads "partial" until you press
 * Grade with AI — which resolves the judgment criteria AND grades the two axes.
 */
export default function CoachScorePanel({
  trade,
  notes,
  setupLibrary,
  instrumentHasBars,
  scoringProfile,
}: {
  trade: GradableTrade
  notes?: string | null
  setupLibrary?: Set<string>
  instrumentHasBars?: boolean
  scoringProfile?: ScoringProfile | null
}) {
  const base = useMemo(() => computeCoachScore(trade, { setupLibrary, instrumentHasBars, scoringProfile }), [trade, setupLibrary, instrumentHasBars, scoringProfile])
  const [ai, setAi] = useState<{ resolutions: Resolutions; marketRead?: AxisResult; setupQuality?: AxisResult; graded: boolean }>({ resolutions: {}, graded: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const cs = useMemo(() => applyAiResolutions(
    base,
    ai.resolutions,
    ai.graded ? {
      marketRead: ai.marketRead?.score != null ? ai.marketRead.score / 10 : null,
      marketReadReason: ai.marketRead?.reason,
      setupQuality: ai.setupQuality?.score != null ? ai.setupQuality.score / 10 : null,
      setupQualityReason: ai.setupQuality?.reason,
    } : undefined,
  ), [base, ai])

  // Show the grade button until the AI axes have been graded once (or if the
  // last pass left criteria unresolved — allow a retry).
  const needsAi = !ai.graded || cs.unknownCount > 0

  const askCoach = async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/trades/coach-score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade: { ...trade, notes: notes ?? '' } }),
      })
      const data = await res.json() as { resolutions?: Resolutions; market_read?: AxisResult; setup_quality?: AxisResult; error?: string }
      if (!res.ok) { setError(data.error ?? 'Coach Score failed'); return }
      setAi(prev => ({
        resolutions: { ...prev.resolutions, ...(data.resolutions ?? {}) },
        marketRead: data.market_read ?? prev.marketRead,
        setupQuality: data.setup_quality ?? prev.setupQuality,
        graded: true,
      }))
    } catch {
      setError('Coach Score request failed')
    } finally {
      setLoading(false)
    }
  }

  const w = cs.axes.hasPlaybook ? { exec: 60, read: 20, setup: 20 } : { exec: 75, read: 25, setup: 0 }
  const to10 = (v: number | null) => (v == null ? null : Math.round(v * 10))

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Hide breakdown' : 'Show axis + criterion breakdown'}
          className="flex items-center gap-1.5 text-sm font-semibold text-gray-200 flex-wrap flex-1 min-w-0 text-left"
        >
          <ChevronDown className={`w-4 h-4 text-gray-500 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          <GraduationCap className="w-4 h-4 text-gray-400" />
          Coach Score
          <span className={`ml-1 text-base font-bold ${band(cs.score)}`}>
            {cs.score ?? '—'}<span className="text-xs text-gray-500">/10</span>
          </span>
          {!ai.graded
            ? <span className="text-[10px] text-amber-500/80 uppercase tracking-wide">partial · execution only</span>
            : <span className="text-[11px] text-gray-500">({cs.passes}✓ {cs.fails}✗ of {cs.total} rated)</span>}
        </button>
        {needsAi && (
          <button
            type="button"
            onClick={askCoach}
            disabled={loading}
            title="Grade the market read + setup quality (and resolve judgment criteria) with the AI"
            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded border bg-amber-900/20 border-amber-800 text-amber-300 hover:bg-amber-900/40 disabled:opacity-50 shrink-0"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {ai.graded ? `Coach Score (${cs.unknownCount})` : 'Grade with AI'}
          </button>
        )}
      </div>
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
      {open && (
        <div className="mt-3 space-y-2">
          {/* Execution axis + its 9 criteria */}
          <AxisRow
            label="Execution"
            weight={w.exec}
            value10={cs.executionScore}
            detail={`${cs.passes}✓ ${cs.fails}✗ of ${cs.total} rules`}
          />
          <ul className="space-y-0.5 text-xs pl-4 border-l border-gray-800 ml-1">
            {cs.criteria.map(c => (
              <li key={c.key} className="flex items-start gap-2">
                <span className={`font-bold ${STATUS_COLOR[c.status]}`}>{SYM[c.status]}</span>
                <span className="text-gray-300">{c.label}</span>
                {c.reason && <span className="text-gray-500">— {c.reason}</span>}
                {c.source === 'ai' && <span className="text-[10px] text-amber-500/80 uppercase mt-0.5">ai</span>}
              </li>
            ))}
          </ul>

          {/* Market read axis */}
          <AxisRow
            label="Market read"
            weight={w.read}
            value10={ai.graded ? to10(cs.axes.marketRead) : null}
            ungraded={!ai.graded}
            reason={cs.axes.marketReadReason}
          />

          {/* Setup quality axis — only with a playbook */}
          {cs.axes.hasPlaybook && (
            <AxisRow
              label="Setup quality"
              weight={w.setup}
              value10={ai.graded ? to10(cs.axes.setupQuality) : null}
              ungraded={!ai.graded}
              reason={cs.axes.setupQualityReason}
            />
          )}
          {!cs.axes.hasPlaybook && (
            <p className="text-[10px] text-gray-600 pl-1">No playbook set — setup-quality axis off; weights are 75% execution / 25% market read.</p>
          )}
          <AiDisclaimer className="pt-1" />
        </div>
      )}
    </div>
  )
}

/** One weighted axis row: label · weight% · N/10 (or an ungraded / n/a hint). */
function AxisRow({ label, weight, value10, detail, ungraded, reason }: {
  label: string
  weight: number
  value10: number | null
  detail?: string
  ungraded?: boolean
  reason?: string
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-300 font-medium w-24 shrink-0">{label}</span>
      <span className="text-[10px] text-gray-600 w-8 shrink-0">{weight}%</span>
      {ungraded ? (
        <span className="text-amber-500/70">— press Grade with AI</span>
      ) : value10 == null ? (
        <span className="text-gray-500">n/a</span>
      ) : (
        <span className={`font-bold ${band(value10)}`}>{value10}<span className="text-gray-500 font-normal">/10</span></span>
      )}
      {detail && <span className="text-gray-500">{detail}</span>}
      {reason && !ungraded && <span className="text-gray-500 truncate">— {reason}</span>}
    </div>
  )
}
