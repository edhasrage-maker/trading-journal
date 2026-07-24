'use client'

import type { ReactNode } from 'react'
import { Target, ChevronRight } from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'
import { TapeScoreRing } from './TapeScoreHeroParts'
import RecentDaysList, { type DayRowData } from './RecentDaysList'
import { ScoreBreakdownInfo, type HeroPeriodData } from '@/components/review/ReviewMonthHero'

/**
 * Beginner ("Highlights") dashboard — a coach REPORT, not a lighter journal.
 * Leads with the One TapeScore (the same 0-100 ring + axis chips Detailed shows)
 * beside a plain-English verdict, then the single focus (the prescription), a
 * calm row of stat chips, the equity curve, a lean Recent Days table, and a seam
 * into Detailed Tape.
 *
 * CONSISTENCY: the score, the axis chips and the focus all come from the SAME
 * `hero` object the Detailed view renders — this month's TapeScore + this
 * month's finding-engine leak. So the two modes never disagree on the score or
 * the leak (they used to: this view ran a 30-day aggregate and a hand-written
 * capture line, while Detailed ran the finding engine over a chosen window).
 * The stat chips below stay a 30-day quick-reference, clearly labelled.
 */
type Props = {
  pnl: number
  winRate: number | null
  capturePct: number | null
  greenDays: number
  tradedDays: number
  bestDay: number | null
  /** This month's TapeScore + finding — the SAME data the Detailed hero shows,
   *  so the score and the leak match across modes. */
  hero: HeroPeriodData
  /** Recent day rows for the lean Highlights table (Tape / Trades / Win % / P&L). */
  days: DayRowData[]
  // Performance charts (equity curve), rendered below the stat chips.
  charts?: ReactNode
}

function money(n: number | null): string {
  if (n == null) return '—'
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`
}

const TONE = {
  edge: { dot: 'bg-green-400', text: 'text-green-400', label: 'Clear edge' },
  leak: { dot: 'bg-blue-400', text: 'text-blue-400', label: 'Clear leak' },
  none: { dot: 'bg-gray-500', text: 'text-gray-400', label: 'No clear read' },
} as const

export default function BeginnerDashboard({ pnl, winRate, capturePct, greenDays, tradedDays, bestDay, hero, days, charts }: Props) {
  const { setMode } = useUiMode()
  const { scorePeriod, carryover } = hero
  const { score, band, scoredDays } = scorePeriod

  // The verdict + focus come from the finding engine — the same leak Detailed
  // shows, in plain words.
  const state = carryover == null ? 'none' : carryover.mode === 'protect' ? 'edge' : 'leak'
  const tone = TONE[state]
  const verdictText = carryover
    ? carryover.finding + (carryover.mode === 'protect' ? ' — keep leaning on it.' : '.')
    : tradedDays === 0
      ? 'Log or import a few sessions and your read shows up here.'
      : 'Nothing separated itself this month — your numbers sit inside your normal range.'
  const focus = carryover?.today
    ?? 'No change to force — keep taking your A setups and let the sample build.'

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
          title="TapeScore — one 0-100 score per day: risk limits kept (50%), entry quality (30%), profit capture (20%). Days that broke 2+ risk rails cap at 49."
        />
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
            <span className={`text-xs font-medium ${tone.text}`}>{tone.label}</span>
            <span className="text-[11px] text-gray-500">· this month</span>
            <ScoreBreakdownInfo period={scorePeriod} />
          </div>
          <p className="text-lg font-semibold text-white leading-snug">{verdictText}</p>
          <div className="mt-3 text-xs text-gray-500">
            {score != null
              ? <>This month · {scoredDays} scored session{scoredDays === 1 ? '' : 's'}</>
              : <>No graded sessions this month yet</>}
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

      {/* Clean stat chips — the calm reference row (numbers, not verdicts).
          A 30-day quick-reference, labelled so its window is unmistakably
          distinct from the month TapeScore above. */}
      <div>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-xs text-gray-500">Last 30 days</span>
          <span className={`text-xs font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(pnl)} net</span>
          <span className="text-xs text-gray-600">· {tradedDays} session{tradedDays === 1 ? '' : 's'}</span>
        </div>
        <div className={`grid grid-cols-2 ${chipCols} gap-3`}>
          {chips.map(c => (
            <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4" title={c.title}>
              <div className="text-xs text-gray-500 mb-1">{c.label}</div>
              <div className={`text-xl font-semibold ${c.valueClass ?? 'text-gray-100'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
            </div>
          ))}
        </div>
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
