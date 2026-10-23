'use client'

import { useId, useMemo, useState, type ReactNode } from 'react'
import type { EodAiAnalysis } from '@/lib/supabase/types'
import { CHASE_CAP, tapeScoreFromAnalyses, tapeScoreDaySentence, type TapeScoreResult } from '@/lib/tapescore'
import { dayTradeInputs, dayTradeSums, type PartsTrade } from '@/lib/exit-rollup'
import type { EntryRuleConfig } from '@/lib/entry-rules'
import type { RunnerRuleConfig } from '@/lib/runner-rules'
import type { RiskYardstick } from '@/lib/exit-score'
import { chaseTrades, type ReentryTrade } from '@/lib/tapescore-day-rules'
import { dayR, fmtR, type RTrade } from '@/lib/trade-r'
import type { Axis, PartKey, PartView, TapeScoreParts } from '@/lib/tapescore-axes'
import { TapeScoreFormulaInfo } from '@/components/dashboard/TapeScoreHeroParts'

/**
 * The Recap's one card (founder, 2026-10-13: "have it all in the TapeScore";
 * pared down 2026-10-19, docs/chase-score-mockup.html: "too busy").
 *
 *   left  — the day's TapeScore ring, the verdict sentence, the P&L with ONE
 *           takeaway line under it (only when something qualifies: a broken
 *           daily loss limit, or 2 or more chase trades), and trades · win rate.
 *           Clicking the ring opens the breakdown under the card: Risk, Entry
 *           and Exit with their parts, and why the day was capped.
 *   right — whatever the page passes as `aside`: the Trade management read
 *           in Detailed Tape, nothing in Highlights
 *
 * The score shows whenever the day has been analysed, live session or not
 * (founder, 2026-10-23: "score should show no matter what"); while the session
 * is live (`live`) the takeaway reads "so far". Before the day is analysed it
 * says so in place of the ring. `showScore` false hides it (no caller does now).
 */
export default function TapeScoreHeader({
  analysis,
  prepScore,
  trades,
  riskYardstick,
  atrStopTarget,
  includeFlow = true,
  entryRules,
  runnerRules,
  tradeCount,
  winRate,
  pnl,
  dailyLossLimit = null,
  showScore = true,
  live = false,
  aside,
}: {
  analysis: EodAiAnalysis | null
  /** Prep AI quality score (1-10) from ai_analysis_json.score. */
  prepScore: number | null
  /** The day's trades — the per-trade parts (Risk's loss size and stop size,
   *  Entry's order-flow Score, the Exit parts) are scored from them, live, so
   *  an edit in the drawer moves them. */
  trades: PartsTrade[]
  /** The trader's risk yardstick going into this day (server-computed by the
   *  shared rule in src/lib/exit-rollup.ts); null = none yet. */
  riskYardstick: RiskYardstick | null
  /** The trader's ATR stop setting (default 1). */
  atrStopTarget: number
  /** The trader's setting: include the order-flow Score in Entry (default on). */
  includeFlow?: boolean
  /** The trader's entry rules — Entry's "Entry rules" part. */
  entryRules?: EntryRuleConfig[]
  /** The trader's runner rules — Exit's "Runner rules" part where one counts. */
  runnerRules?: RunnerRuleConfig[]
  tradeCount: number
  /** Share of the day's trades that closed green, 0-100. */
  winRate: number
  pnl: number
  /** The trader's daily loss limit in dollars (positive); null = not tracked. */
  dailyLossLimit?: number | null
  /** False hides the ring and verdict. */
  showScore?: boolean
  /** The session is still live: the takeaway reads "so far". */
  live?: boolean
  /** The card's right half (Trade management). */
  aside?: ReactNode
}) {
  // The day's per-trade parts, through the same two steps the per-day rollup
  // takes (store the day's inputs, then score them against the risk yardstick),
  // so this header and the dashboard can't disagree about the same day.
  const tradeSums = useMemo(
    () => dayTradeSums(dayTradeInputs(trades, atrStopTarget, entryRules, runnerRules), riskYardstick),
    [trades, atrStopTarget, entryRules, runnerRules, riskYardstick],
  )
  const result = useMemo(
    () => tapeScoreFromAnalyses(analysis, prepScore, tradeSums, { includeFlow, runnerOwn: !!runnerRules?.some(r => r.on) }),
    [analysis, prepScore, tradeSums, includeFlow, runnerRules],
  )
  const chase = useMemo(() => chaseTrades(trades as ReentryTrade[]), [trades])
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const scored = showScore && result != null
  // An empty day with nothing graded has nothing to say yet.
  if (!scored && tradeCount === 0 && pnl === 0 && !aside) return null

  const pnlCls = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
  const pnlText = `${pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(pnl)).toLocaleString()}`
  // The day in R beside the P&L, and its average win vs average loss
  // (src/lib/trade-r.ts; founder 2026-10-22, mockup https://claude.ai/artifact/5QWKdATNpTntCQ6Ar9neZn).
  const r = dayR(trades as RTrade[])
  const rCls = r.totalR == null ? '' : r.totalR > 0 ? 'text-green-400' : r.totalR < 0 ? 'text-red-400' : 'text-gray-400'
  const rTitle = r.totalR == null ? undefined
    : `Each trade's P&L divided by what it risked to its planned stop, added up${r.withStop < r.trades ? ` (${r.withStop} of ${r.trades} trades had a stop)` : ''}.`
  const winLoss = r.avgWinR != null && r.avgLossR != null && r.ratio != null
    ? `avg win ${r.avgWinR.toFixed(1)}R vs loss ${r.avgLossR.toFixed(1)}R (${r.ratio.toFixed(1)} : 1)`
    : null
  const takeaway = takeawayLine({ pnl, dailyLossLimit, chase: chase.length, live, chaseCapped: scored && result.chaseCapped })
  const takeawayEl = takeaway && (
    <p className="text-[15px] font-semibold text-gray-100 leading-snug" style={{ textWrap: 'balance' }}>
      <span className="inline-block w-[7px] h-[7px] rounded-full bg-amber-400 mr-2 align-[2px]" aria-hidden="true" />
      {takeaway}
    </p>
  )

  return (
    <div className="space-y-3">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col lg:flex-row gap-5 lg:gap-7">
        <div className="lg:flex-1 min-w-0">
          <div className="flex items-center gap-5">
            {scored && <Ring score={result.score} band={result.band} open={open} controls={panelId} onToggle={() => setOpen(v => !v)} />}
            <div className="flex-1 min-w-0 space-y-2">
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
              <div className="space-y-1">
                <span className="flex items-baseline gap-3">
                  <span className={`text-[28px] leading-tight font-bold tabular-nums ${pnlCls}`} style={{ fontFamily: 'var(--font-display)' }}>
                    {pnlText}
                  </span>
                  {r.totalR != null && (
                    <span className={`text-[19px] leading-tight font-bold tabular-nums ${rCls}`} style={{ fontFamily: 'var(--font-display)' }} title={rTitle}>
                      {fmtR(r.totalR, 1)}
                    </span>
                  )}
                </span>
                {/* Beside the ring there's room for it; on a phone it runs full width below. */}
                {takeawayEl && <div className="hidden sm:block">{takeawayEl}</div>}
                {tradeCount > 0 && (
                  <p className="text-[13px] text-gray-400 tabular-nums">
                    {tradeCount} trade{tradeCount === 1 ? '' : 's'} · {Math.round(winRate)}% win rate{winLoss ? ` · ${winLoss}` : ''}
                  </p>
                )}
              </div>
              {!scored && showScore && tradeCount > 0 && (
                <p className="text-xs text-gray-500">Not scored yet — run Analyze Session below for the day&rsquo;s TapeScore.</p>
              )}
            </div>
          </div>
          {takeawayEl && <div className="sm:hidden mt-3">{takeawayEl}</div>}
        </div>
        {aside && (
          <div className="lg:flex-[1.15] min-w-0 border-t lg:border-t-0 lg:border-l border-gray-800 pt-5 lg:pt-0 lg:pl-7 flex flex-col justify-center">
            {aside}
          </div>
        )}
      </div>
      {scored && open && <Breakdown id={panelId} result={result} chase={chase} />}
    </div>
  )
}

/** The one line under the P&L: a broken daily loss limit first, else 2 or more chase trades, else nothing. */
function takeawayLine({ pnl, dailyLossLimit, chase, live, chaseCapped }: {
  pnl: number; dailyLossLimit: number | null; chase: number; live: boolean; chaseCapped: boolean
}): string | null {
  if (dailyLossLimit != null && dailyLossLimit > 0 && pnl <= -dailyLossLimit) {
    return `Hit your $${Math.round(dailyLossLimit).toLocaleString()} daily loss limit.`
  }
  if (chase >= 2) {
    if (live) return `${chase} chase trades after losses so far.`
    return chaseCapped ? `${chase} chase trades after losses capped the day.` : `${chase} chase trades after losses.`
  }
  return null
}

const SHORT: Record<PartKey, string> = {
  rules: 'rules', lossSize: 'loss size', stopSize: 'stop size', reentry: 're-entries',
  checklist: 'checklist', entryRules: 'your entry rules', flow: 'order flow', plan: 'plan',
  kept: 'profit kept', stopRespected: 'stop respected', runner: 'runner rules',
}
/** Parts graded pass/fail per trade: shown as "x of n". */
const COUNTED = new Set<PartKey>(['stopSize', 'reentry', 'stopRespected'])
const AXES: { axis: Axis; label: string; keys: PartKey[] }[] = [
  { axis: 'risk', label: 'Risk', keys: ['rules', 'lossSize', 'stopSize', 'reentry'] },
  { axis: 'entry', label: 'Entry', keys: ['checklist', 'entryRules', 'flow', 'plan'] },
  { axis: 'exit', label: 'Exit', keys: ['kept', 'stopRespected', 'runner'] },
]

/** One axis's parts in a line: "Rules 4 of 4 kept · loss size 100 · stop size 5 of 6 · re-entries 0 of 3". */
function partSummary(parts: TapeScoreParts, axis: Axis, keys: PartKey[]): string {
  const bits: string[] = []
  for (const k of keys) {
    const p = (parts[axis] as Record<PartKey, PartView>)[k]
    if (!p || p.score == null || !(p.weight > 0)) continue
    const label = k === 'runner' && !parts.runnerOwn ? 'runner' : SHORT[k]
    if (k === 'rules' && parts.rulesKept != null && parts.rulesOf != null) bits.push(`${label} ${parts.rulesKept} of ${parts.rulesOf} kept`)
    else if (COUNTED.has(k) && p.n != null && p.n > 0) bits.push(`${label} ${Math.round((p.score / 100) * p.n)} of ${p.n}`)
    else bits.push(`${label} ${Math.round(p.score)}`)
  }
  if (!bits.length) return ''
  bits[0] = bits[0].charAt(0).toUpperCase() + bits[0].slice(1)
  return bits.join(' · ')
}

const ptHm = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' }) : '?')

/** What the ring opens: the three axes with their parts, and why the day was capped. */
function Breakdown({ id, result, chase }: { id: string; result: TapeScoreResult; chase: { entry_time?: string | null }[] }) {
  const { components: c, parts } = result
  const lowered = result.capped || result.chaseCapped
  const times = chase.map(t => ptHm(t.entry_time))
  const list = times.length > 1 ? `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}` : times.join('')
  return (
    <div id={id} className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 space-y-2.5 max-w-3xl">
      <p className="text-[13.5px] font-semibold text-gray-100">
        TapeScore {result.score}{' '}
        <span className="font-normal text-gray-400">
          {result.basis === 'legacy'
            ? '· scored under an earlier rubric: re-run Analyze Session to grade under the current rules'
            : lowered ? `· Risk, Entry and Exit average ${result.uncapped}, capped at ${result.score}` : '· Risk, Entry and Exit averaged'}
        </span>
      </p>
      {parts && (
        <div className="grid grid-cols-[52px_34px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 items-baseline text-[13px] tabular-nums">
          {AXES.map(({ axis, label, keys }) => {
            const v = c[axis]
            if (v == null) return null
            return (
              <div key={axis} className="contents">
                <span className="text-gray-400">{label}</span>
                <span className={`font-bold ${v >= 70 ? 'text-green-400' : v >= 50 ? 'text-amber-300' : 'text-red-400'}`}>{v}</span>
                <span className="text-gray-400 text-[12.5px]">{partSummary(parts, axis, keys)}</span>
              </div>
            )
          })}
        </div>
      )}
      {result.chaseCapped && (
        <p className="text-[13px] text-gray-300 border-t border-gray-800 pt-2.5">
          <span className="inline-block w-[7px] h-[7px] rounded-full bg-amber-400 mr-2 align-[2px]" aria-hidden="true" />
          <span className="font-semibold text-gray-100">Capped at {CHASE_CAP}.</span>{' '}
          {result.chaseTrades} chase trades{list ? ` (${list})` : ''} came within 5 minutes of a losing exit with no fresh trigger. With 2 or more, the day can&apos;t be green.
        </p>
      )}
      {result.capped && (
        <p className="text-[13px] text-gray-300 border-t border-gray-800 pt-2.5">
          <span className="inline-block w-[7px] h-[7px] rounded-full bg-red-400 mr-2 align-[2px]" aria-hidden="true" />
          <span className="font-semibold text-gray-100">Capped at 49.</span>{' '}
          Rules broken (the daily loss limit, or more than one rule): the day can&apos;t read green or amber.
        </p>
      )}
    </div>
  )
}

function Ring({ score, band, open, controls, onToggle }: {
  score: number; band: 'high' | 'mid' | 'low'; open: boolean; controls: string; onToggle: () => void
}) {
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
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="relative w-[104px] h-[104px] shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70"
      title={open ? 'Hide the breakdown' : 'Click for the breakdown: Risk, Entry, Exit and any cap'}
    >
      <svg width="104" height="104" viewBox="0 0 92 92" className="-rotate-90">
        <circle cx="46" cy="46" r={R} fill="none" stroke="#1f2937" strokeWidth="7" />
        <circle
          cx="46" cy="46" r={R} fill="none"
          stroke={colors.stroke} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRC}`}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center">
        <span className="text-center leading-none">
          <span className={`block font-mono text-[28px] font-extrabold ${colors.text}`}>{score}</span>
          <span className="block text-[8px] tracking-[0.14em] text-gray-500 mt-1">TAPESCORE</span>
        </span>
      </span>
    </button>
  )
}
