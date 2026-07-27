'use client'

import { useMemo } from 'react'
import type { EodAiAnalysis } from '@/lib/supabase/types'
import { tapeScoreFromAnalyses, tapeScoreDaySentence } from '@/lib/tapescore'
import { TapeScoreFormulaInfo } from '@/components/dashboard/TapeScoreHeroParts'

/**
 * EOD hero — the day's One TapeScore (Ruleset amendment 5): 0-100 ring,
 * plain-language verdict sentence, and the component chips (Rules kept /
 * Execution / Prep). Renders nothing until the day has an EOD analysis; the
 * detailed process/execution panels below stay the drill-down.
 *
 * Self-contained on purpose: EodClient carries parallel-session WIP, so the
 * mount there stays a two-line change.
 */
export default function TapeScoreHeader({
  analysis,
  prepScore,
  tradeCount,
  winCount,
  lossCount,
  pnl,
}: {
  analysis: EodAiAnalysis | null
  /** Prep AI quality score (1-10) from ai_analysis_json.score. */
  prepScore: number | null
  tradeCount: number
  winCount: number
  lossCount: number
  pnl: number
}) {
  const result = useMemo(
    () => tapeScoreFromAnalyses(analysis, prepScore),
    [analysis, prepScore],
  )
  if (!result) return null

  // No trade-count penalty — see TapeScorePill: the score grades decisions,
  // which one trade can demonstrate perfectly well.
  const colors =
    result.band === 'high' ? { stroke: '#4ade80', text: 'text-green-400' }
    : result.band === 'mid' ? { stroke: '#fbbf24', text: 'text-amber-300' }
    : { stroke: '#f87171', text: 'text-red-400' }
  const R = 40
  const CIRC = 2 * Math.PI * R
  const dash = (result.score / 100) * CIRC
  // New analyses carry an AI-written day headline; legacy rows fall back to
  // the deterministic sentence so every scored day still gets a verdict.
  const sentence = analysis?.headline?.trim() || tapeScoreDaySentence(result)
  const { passCount, entry, capture } = result.components
  const pnlCls = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-4 flex-wrap">
      <div
        className="relative w-[76px] h-[76px] shrink-0"
        title="TapeScore — one 0-100 score for the day: risk, entry and exit, weighted equally. Days that broke 2+ risk rails cap at 49."
      >
        <svg width="76" height="76" viewBox="0 0 92 92" className="-rotate-90">
          <circle cx="46" cy="46" r={R} fill="none" stroke="#1f2937" strokeWidth="7" />
          <circle
            cx="46" cy="46" r={R} fill="none"
            stroke={colors.stroke} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center leading-none">
            <div className={`font-mono text-[21px] font-extrabold ${colors.text}`}>{result.score}</div>
            <div className="text-[7px] tracking-[0.14em] text-gray-500 mt-0.5">TAPESCORE</div>
          </div>
        </div>
      </div>
      <div className="flex-1 min-w-[240px]">
        <div className="flex items-center gap-1.5">
          <p className="text-white font-semibold text-[15px]">{sentence}</p>
          <TapeScoreFormulaInfo />
        </div>
        <p className="text-xs text-gray-500 mt-0.5">
          {tradeCount} trade{tradeCount === 1 ? '' : 's'}
          {' · '}
          <span className="text-green-400">{winCount}W</span>
          <span className="text-gray-600"> / </span>
          <span className="text-red-400">{lossCount}L</span>
          {' · '}
          <span className={`font-mono ${pnlCls}`}>{`${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl)).toLocaleString()}`}</span>
        </p>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {result.basis === 'legacy' ? (
            <Chip label="Scored under an earlier rubric" tone="mid" title="Pre-v1.3 analysis — re-run Analyze Session to grade under the current rules." />
          ) : (
            <>
              {passCount != null && (
                <Chip
                  label={`Risk limits ${passCount}/5`}
                  tone={passCount >= 5 ? 'good' : passCount === 4 ? 'mid' : 'bad'}
                  title="The five account risk rails: daily loss limit, size cap, no size-up after a loss, 90s cooldown, trade cap. These are guardrails, not a measure of trade quality."
                />
              )}
              {entry != null && (
                <Chip
                  label={`Entry ${entry}`}
                  tone={entry >= 70 ? 'good' : entry >= 50 ? 'mid' : 'bad'}
                  title="Entry quality (0-100): entry/stop/target parameters, prep adherence, profit factor — capture is scored separately"
                />
              )}
              {capture != null && (
                <Chip
                  label={`Exit ${capture}`}
                  tone={capture >= 70 ? 'good' : capture >= 50 ? 'mid' : 'bad'}
                  title="Exit / profit capture (0-100): how much of the favorable move you kept — MFE captured"
                />
              )}
            </>
          )}
        </div>
      </div>
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
