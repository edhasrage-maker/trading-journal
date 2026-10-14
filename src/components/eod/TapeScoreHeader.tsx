'use client'

import { useMemo, type ReactNode } from 'react'
import type { EodAiAnalysis } from '@/lib/supabase/types'
import { tapeScoreFromAnalyses, tapeScoreDaySentence, type TapeScoreResult } from '@/lib/tapescore'
import { exitScoreView, type ExitTradeInput } from '@/lib/exit-score'
import { EXIT_AXIS_DESC, dayExitStored, dayExitSums, exitFactorsTooltip } from '@/lib/exit-rollup'
import { TapeScoreFormulaInfo } from '@/components/dashboard/TapeScoreHeroParts'

/**
 * The Recap's one card (founder, 2026-10-13: "have it all in the TapeScore").
 *
 *   left  — the day's One TapeScore ring (Ruleset amendment 5), the verdict
 *           sentence, the day's numbers in ONE line (P&L · trades · win rate)
 *           and the Risk / Entry / Exit chips
 *   right — whatever the page passes as `aside`: the Trade management read
 *           in Detailed Tape, nothing in Highlights
 *
 * It replaced three places that printed the same three numbers: the P&L /
 * Trades / Win Rate strip in the page header, a "N trades · W / L · $" line on
 * this card, and three boxes beside the Trade management card.
 *
 * While the session is still live the score stays out of sight (`showScore`
 * false) and the card carries only the numbers and Trade management. Before
 * the day is analysed it says so in place of the ring.
 */
export default function TapeScoreHeader({
  analysis,
  prepScore,
  trades,
  avgRiskDollars,
  atrStopTarget,
  tradeCount,
  winRate,
  pnl,
  showScore = true,
  aside,
}: {
  analysis: EodAiAnalysis | null
  /** Prep AI quality score (1-10) from ai_analysis_json.score. */
  prepScore: number | null
  /** The day's trades — the Exit axis is scored from them, live, so an edit in
   *  the drawer moves it. */
  trades: ExitTradeInput[]
  /** The trader's average dollar risk going into this day (server-computed by
   *  the shared rule in src/lib/exit-rollup.ts); null = none yet. */
  avgRiskDollars: number | null
  /** The trader's ATR stop setting (default 1). */
  atrStopTarget: number
  tradeCount: number
  /** Share of the day's trades that closed green, 0-100. */
  winRate: number
  pnl: number
  /** False while the session is still live: no ring, verdict or chips. */
  showScore?: boolean
  /** The card's right half (Trade management). */
  aside?: ReactNode
}) {
  // The day's Exit, through the same two steps the per-day rollup takes
  // (store the day's inputs, then score them against the average risk), so this
  // header and the dashboard can't disagree about the same day.
  const exitView = useMemo(() => {
    const sums = dayExitSums(dayExitStored(trades, atrStopTarget), avgRiskDollars)
    return sums ? exitScoreView(sums) : null
  }, [trades, atrStopTarget, avgRiskDollars])
  const result = useMemo(
    () => tapeScoreFromAnalyses(analysis, prepScore, exitView?.score ?? null),
    [analysis, prepScore, exitView],
  )
  const scored = showScore && result != null
  // An empty day with nothing graded has nothing to say yet.
  if (!scored && tradeCount === 0 && pnl === 0 && !aside) return null

  const pnlCls = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const pnlText = `${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl)).toLocaleString()}`
  const exitTitle = exitFactorsTooltip(`Exit (0-100): ${EXIT_AXIS_DESC}.`, exitView?.factors)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col lg:flex-row gap-5 lg:gap-7">
      <div className="lg:flex-1 min-w-0 flex items-center gap-5">
        {scored && <Ring score={result.score} band={result.band} />}
        <div className="flex-1 min-w-0 space-y-2.5">
          {scored && (
            <div className="flex items-center gap-1.5">
              {/* New analyses carry an AI-written day headline; legacy rows
                  fall back to the deterministic sentence so every scored day
                  still gets a verdict. */}
              <p className="text-white font-semibold text-[17px] leading-snug" style={{ fontFamily: 'var(--font-display)' }}>
                {analysis?.headline?.trim() || tapeScoreDaySentence(result)}
              </p>
              <TapeScoreFormulaInfo />
            </div>
          )}
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
            <span className={`text-2xl font-bold tabular-nums ${pnlCls}`} style={{ fontFamily: 'var(--font-display)' }}>
              {pnlText}
            </span>
            {tradeCount > 0 && (
              <span className="text-[13px] text-gray-400 whitespace-nowrap">
                {tradeCount} trade{tradeCount === 1 ? '' : 's'} · {Math.round(winRate)}% win rate
              </span>
            )}
          </div>
          {scored ? (
            <Chips result={result} exitTitle={exitTitle} />
          ) : showScore && tradeCount > 0 ? (
            <p className="text-xs text-gray-500">Not scored yet — run Analyze Session below for the day&rsquo;s TapeScore.</p>
          ) : null}
        </div>
      </div>
      {aside && (
        <div className="lg:flex-[1.15] min-w-0 border-t lg:border-t-0 lg:border-l border-gray-800 pt-5 lg:pt-0 lg:pl-7 flex flex-col justify-center">
          {aside}
        </div>
      )}
    </div>
  )
}

function Ring({ score, band }: { score: number; band: 'high' | 'mid' | 'low' }) {
  // No trade-count penalty — see TapeScorePill: the score grades decisions,
  // which one trade can demonstrate perfectly well.
  const colors =
    band === 'high' ? { stroke: '#4ade80', text: 'text-green-400' }
    : band === 'mid' ? { stroke: '#fbbf24', text: 'text-amber-300' }
    : { stroke: '#f87171', text: 'text-red-400' }
  const R = 40
  const CIRC = 2 * Math.PI * R
  const dash = (score / 100) * CIRC
  return (
    <div
      className="relative w-[104px] h-[104px] shrink-0"
      title="TapeScore — one 0-100 score for the day: risk, entry and exit, weighted equally. Days that broke 2+ risk rails cap at 49."
    >
      <svg width="104" height="104" viewBox="0 0 92 92" className="-rotate-90">
        <circle cx="46" cy="46" r={R} fill="none" stroke="#1f2937" strokeWidth="7" />
        <circle
          cx="46" cy="46" r={R} fill="none"
          stroke={colors.stroke} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRC}`}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center leading-none">
          <div className={`font-mono text-[28px] font-extrabold ${colors.text}`}>{score}</div>
          <div className="text-[8px] tracking-[0.14em] text-gray-500 mt-1">TAPESCORE</div>
        </div>
      </div>
    </div>
  )
}

function Chips({ result, exitTitle }: { result: TapeScoreResult; exitTitle: string }) {
  const { passCount, railCount, entry, exit } = result.components
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {result.basis === 'legacy' ? (
        <Chip label="Scored under an earlier rubric" tone="mid" title="Pre-v1.3 analysis — re-run Analyze Session to grade under the current rules." />
      ) : (
        <>
          {passCount != null && (
            <Chip
              label={`Risk limits ${passCount}/${railCount ?? 5}`}
              tone={passCount >= (railCount ?? 5) ? 'good' : passCount === (railCount ?? 5) - 1 ? 'mid' : 'bad'}
              title="The five account risk rails: daily loss limit, size cap, no size-up after a loss, 90s cooldown, trade cap. These are guardrails, not a measure of trade quality."
            />
          )}
          {entry != null && (
            <Chip
              label={`Entry ${entry}`}
              tone={entry >= 70 ? 'good' : entry >= 50 ? 'mid' : 'bad'}
              title="Entry quality (0-100): entry/stop/target parameters, prep adherence, profit factor — the exit is scored separately"
            />
          )}
          {exit != null && (
            <Chip
              label={`Exit ${exit}`}
              tone={exit >= 70 ? 'good' : exit >= 50 ? 'mid' : 'bad'}
              title={exitTitle}
            />
          )}
        </>
      )}
    </div>
  )
}

function Chip({ label, tone, title }: { label: string; tone: 'good' | 'mid' | 'bad'; title: string }) {
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
