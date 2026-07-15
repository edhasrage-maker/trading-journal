'use client'

import type { ReactNode } from 'react'
import { Target, ChevronRight } from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'
import type { TapeScorePeriod } from '@/lib/tapescore'
import { TapeScoreRing, HeroChip } from './TapeScoreHeroParts'
import RecentDaysList, { type DayRowData } from './RecentDaysList'

/**
 * Beginner ("Highlights") dashboard — a coach REPORT, not a lighter journal.
 * Leads with the One TapeScore (the same 0-100 ring + component chips Detailed
 * shows) beside a plain-English verdict sentence, with net P&L demoted to the
 * sub-line. Then the single focus (the prescription), a calm row of clean stat
 * chips, the equity curve, a lean Recent Days table, and a seam into Detailed
 * Tape. Same engine as Pro, translated to plain English — one score everywhere
 * (docs/BEGINNER_PRO_MODES.md, docs highlights-redesign).
 */
type Props = {
  pnl: number
  winRate: number | null
  capturePct: number | null
  greenDays: number
  tradedDays: number
  bestDay: number | null
  focus: string
  /** 30-day One TapeScore aggregate — same object the Detailed hero renders. */
  tape: TapeScorePeriod
  /** Recent day rows for the lean Highlights table (Tape / Trades / Win % / P&L). */
  days: DayRowData[]
  // Performance charts (equity curve), rendered below the stat chips.
  charts?: ReactNode
}

function money(n: number | null): string {
  if (n == null) return '—'
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`
}

// Deterministic period verdict — the one-line "how am I doing + the pattern"
// read. Derived from the same signals the focus line uses; this is the
// DIAGNOSIS, the "Your one focus" card carries the PRESCRIPTION, so they
// complement rather than repeat. No AI call — instant and reproducible.
function periodVerdict(opts: { pnl: number; capturePct: number | null; winRate: number | null; tradedDays: number }):
  { tone: 'good' | 'watch' | 'down'; label: string; text: string } {
  const { pnl, capturePct, winRate, tradedDays } = opts
  if (tradedDays === 0) return { tone: 'watch', label: 'Getting started', text: 'Log or import a few sessions and your read shows up here.' }
  if (pnl > 0) {
    if (capturePct != null && capturePct < 50) return { tone: 'watch', label: 'Strong month, one leak', text: "You're green this month, but you're leaving profit on the table." }
    if (capturePct != null) return { tone: 'good', label: 'Strong month', text: "Green month — and you're converting your setups well." }
    if (winRate != null && winRate < 50) return { tone: 'good', label: 'Winners are working', text: 'Green even below a 50% win rate — your winners outsize your losers.' }
    return { tone: 'good', label: 'Strong month', text: "Green this month — keep doing what's working." }
  }
  if (pnl < 0) {
    if (capturePct != null && capturePct < 50) return { tone: 'down', label: 'Down — exits are the leak', text: "Down this stretch, and you're giving back the moves you catch." }
    return { tone: 'down', label: 'Down this stretch', text: "Down over the last 30 days — let's tighten one thing at a time." }
  }
  return { tone: 'watch', label: 'Around breakeven', text: 'Flat this month — roughly breakeven.' }
}

const TONE: Record<'good' | 'watch' | 'down', { dot: string; text: string }> = {
  good: { dot: 'bg-green-400', text: 'text-green-400' },
  watch: { dot: 'bg-amber-400', text: 'text-amber-400' },
  down: { dot: 'bg-red-400', text: 'text-red-400' },
}

export default function BeginnerDashboard({ pnl, winRate, capturePct, greenDays, tradedDays, bestDay, focus, tape, days, charts }: Props) {
  const { setMode } = useUiMode()
  const v = periodVerdict({ pnl, capturePct, winRate, tradedDays })
  const tone = TONE[v.tone]
  const { score, band, verdictDays, compliantDays, execution, prep } = tape

  // Calm reference row. Conversion only appears when there's capture data (a
  // bare "—" reads as broken). Best day is signed-colored.
  const chips: { label: string; value: string; valueClass?: string; title?: string }[] = [
    { label: 'Day win rate', value: tradedDays > 0 ? `${Math.round((greenDays / tradedDays) * 100)}%` : '—' },
    { label: 'Win rate', value: winRate == null ? '—' : `${Math.round(winRate)}%` },
    ...(capturePct != null
      ? [{ label: 'Profit Captured', value: `${capturePct}%`, title: 'Of the best point your trade reached in your favor, how much you kept at exit, on average.' }]
      : []),
    {
      label: 'Best day',
      value: money(bestDay),
      valueClass: (bestDay ?? 0) > 0 ? 'text-green-400' : (bestDay ?? 0) < 0 ? 'text-red-400' : 'text-gray-100',
    },
  ]
  const chipCols = chips.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'

  return (
    <div className="space-y-4">
      {/* Hero report card — One TapeScore ring + the period verdict, P&L demoted.
          The ring is the grade, the sentence is the coach's comment, the chips
          are the subscores. Identical ring + chips to Detailed. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex items-center gap-5 flex-wrap">
        <TapeScoreRing
          score={score}
          band={band}
          title="TapeScore — one 0-100 score per day: rules kept (50%), execution quality (35%), prep (15%). Days that broke 2+ rules cap at 49."
        />
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
            <span className={`text-xs font-medium ${tone.text}`}>{v.label}</span>
          </div>
          <p className="text-lg font-semibold text-white leading-snug">{v.text}</p>
          {score != null && (
            <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
              {verdictDays > 0 && (
                <HeroChip
                  label={`Risk limits ${compliantDays}/${verdictDays}`}
                  tone={compliantDays / verdictDays >= 0.85 ? 'good' : compliantDays / verdictDays >= 0.6 ? 'mid' : 'bad'}
                  title="Sessions that kept at least 4 of the 5 account risk rails, out of sessions with a rails check. These are guardrails, not a measure of trade quality."
                />
              )}
              {execution != null && (
                <HeroChip
                  label={`Execution ${execution}`}
                  tone={execution >= 70 ? 'good' : execution >= 50 ? 'mid' : 'bad'}
                  title="Average execution quality (0-100): entry/stop/target parameters, move captured, prep adherence, profit factor"
                />
              )}
              {prep != null && (
                <HeroChip
                  label={`Prep ${prep}`}
                  tone={prep >= 70 ? 'good' : prep >= 50 ? 'mid' : 'bad'}
                  title="Average prep quality score (0-100) from the morning prep analysis"
                />
              )}
            </div>
          )}
          <div className="mt-3 text-xs text-gray-500">
            <span className={`font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(pnl)}</span>
            {' '}net P&amp;L · last 30 days · {tradedDays} session{tradedDays === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      {/* Your one focus — the single action, in plain English. */}
      <div className="rounded-xl border p-4" style={{ background: 'rgba(224,163,60,0.08)', borderColor: 'rgba(224,163,60,0.35)' }}>
        <div className="flex items-center gap-2 mb-1.5">
          <Target className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-400">Your one focus</span>
        </div>
        <p className="text-sm text-gray-200 leading-relaxed">{focus}</p>
      </div>

      {/* Clean stat chips — the calm reference row (numbers, not verdicts). */}
      <div className={`grid grid-cols-2 ${chipCols} gap-3`}>
        {chips.map(c => (
          <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4" title={c.title}>
            <div className="text-xs text-gray-500 mb-1">{c.label}</div>
            <div className={`text-xl font-semibold ${c.valueClass ?? 'text-gray-100'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Equity curve (kept in Highlights — intuitive). */}
      {charts}

      {/* Recent sessions — the same TapeScore table as Detailed, lean column set
          (Tape / Trades / Win % / P&L), read-only. Each row links to its EOD. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Recent sessions</h2>
        </div>
        {days.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">No sessions yet.</div>
        ) : (
          <div className="px-3 sm:px-4 pb-2">
            <RecentDaysList initialDays={days} mode="beginner" />
          </div>
        )}
      </div>

      {/* Graduation seam — one tap into the full Detailed Tape view. */}
      <button
        type="button"
        onClick={() => setMode('pro')}
        className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 border border-gray-800 hover:border-gray-600 rounded-xl py-2.5 transition-colors"
      >
        See your full breakdown <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}
