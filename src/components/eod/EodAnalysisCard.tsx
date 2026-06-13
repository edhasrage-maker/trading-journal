'use client'

import { useState } from 'react'
import { Brain, AlertTriangle, CheckCircle, Loader2, TrendingUp, Target, ShieldCheck, ShieldX, Activity, RefreshCw } from 'lucide-react'
import type { EodAiAnalysis, ProcessVerdict, ExecutionScore, RuleId, RuleStatus } from '@/lib/supabase/types'

interface Props {
  analysis: EodAiAnalysis | null
  loading: boolean
  onAnalyze: () => void
  disabled?: boolean
  /** ISO timestamp of the most recently updated trade on the day. When this
   *  is AFTER analysis.analyzed_at, the analysis's per-rule verdicts may no
   *  longer reflect current trade state (the user backfilled tags / stops /
   *  applied detected levels after running the AI). Surfaces a stale badge
   *  so the verdict isn't trusted blindly. */
  latestTradeUpdate?: string | null
}

// v1.4 (2026-06-08 amendment 3): 5 hard safety-rail rules. Stop validity
// (was P4) and Setup validity (was P7) moved to Execution Parameters.
const RULE_LABELS: Record<RuleId, string> = {
  P1: 'Daily Loss Limit',
  P2: 'Size Within Cap',
  P3: 'No Size-Up After Loss',
  P4: 'Cooldown ≥90s',
  P5: 'Trade Cap ≤7',
}

/**
 * Full descriptions for the hover popup. Source of truth is
 * docs/Ruleset_v1.3_Process_Execution_Spec.md — kept short here so the
 * tooltip stays compact. Each line is one sentence on what the rule
 * enforces and why a breach matters.
 */
const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  P1: 'Stop trading the moment cumulative session P&L drops to the daily loss limit. Hard safety rail — breach means a missed stop on the DLL itself.',
  P2: 'Every trade must be at or below the per-trade size cap. No exceptions for "high-conviction" setups.',
  P3: 'After a losing trade, the next trade must be the same size or smaller — never larger. Sizing up after a loss is the classic revenge-trade tell.',
  P4: 'At least 90 seconds must elapse between one trade closing and the next opening. Forces a deliberate decision, not a reactive re-entry.',
  P5: 'Maximum 7 trades per day. Past 7 is overtrading territory regardless of P&L — quit while the edge is fresh.',
}

const RULE_ORDER: RuleId[] = ['P1', 'P2', 'P3', 'P4', 'P5']

export default function EodAnalysisCard({ analysis, loading, onAnalyze, disabled, latestTradeUpdate }: Props) {
  // v1.3-era analyses populate `process` + `execution`. Pre-v1.3 rows only
  // have the legacy `score`. UI prefers v1.3 when present, falls back otherwise.
  const hasV13 = !!(analysis?.process || analysis?.execution)
  // Stale = a trade was modified after the analysis ran. The verdict was
  // computed against an older snapshot of the data, so any per-rule reason
  // that cites missing fields (no stop, no setup tag) may be silently wrong
  // by now. Threshold a few seconds to avoid false positives from the EOD
  // route's own updated_at touches on the trading_day row.
  const isStale = !!(
    analysis?.analyzed_at &&
    latestTradeUpdate &&
    Date.parse(latestTradeUpdate) > Date.parse(analysis.analyzed_at) + 2000
  )
  const legacyScore = analysis?.score ?? 0
  const legacyColor = !analysis
    ? ''
    : legacyScore >= 7
      ? 'text-green-400'
      : legacyScore >= 4
        ? 'text-yellow-400'
        : 'text-red-400'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Brain className="w-4 h-4 text-blue-400 shrink-0" />
          <h3 className="font-medium text-white text-sm">Session Analysis</h3>
          {isStale && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-amber-700/60 bg-amber-950/40 text-amber-300"
              title={`Trades were modified after this analysis ran (${analysis?.analyzed_at ? new Date(analysis.analyzed_at).toLocaleString() : '—'}). Per-rule reasons may cite fields you've since backfilled. Re-run Analyze Session for an accurate verdict.`}
            >
              <RefreshCw className="w-3 h-3" />
              Stale — re-run
            </span>
          )}
        </div>
        <button
          onClick={onAnalyze}
          disabled={loading || disabled}
          className={`flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
            isStale ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'
          }`}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
          {loading ? 'Analyzing...' : 'Analyze Session'}
        </button>
      </div>

      {!analysis && !loading && (
        <p className="text-gray-500 text-sm">
          Save your EOD notes and at least one trade, then click Analyze Session for an objective coach review.
        </p>
      )}

      {analysis && (
        <div className="space-y-3">
          {/* v1.3: Process verdict + Execution composite, side-by-side */}
          {hasV13 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-3 border-b border-gray-800">
              {analysis.process && <ProcessCard process={analysis.process} />}
              {analysis.execution && <ExecutionCard execution={analysis.execution} />}
            </div>
          ) : (
            /* Pre-v1.3 legacy: single score + summary */
            <div className="flex items-center gap-3 pb-3 border-b border-gray-800">
              <span className={`text-3xl font-bold ${legacyColor}`}>
                {legacyScore}
                <span className="text-lg text-gray-500">/10</span>
              </span>
              <p className="text-sm text-gray-300 leading-relaxed">{analysis.summary}</p>
            </div>
          )}

          {/* Summary line in v1.3 era — lives below the verdict cards */}
          {hasV13 && analysis.summary && (
            <p className="text-sm text-gray-300 leading-relaxed pb-3 border-b border-gray-800">{analysis.summary}</p>
          )}

          {/* What worked */}
          {analysis.what_worked && analysis.what_worked.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                <span className="text-xs font-semibold text-green-500 uppercase tracking-wider">What Worked</span>
              </div>
              <ul className="space-y-1">
                {analysis.what_worked.map((s, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-green-500 mt-0.5">•</span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Mistakes */}
          {analysis.mistakes && analysis.mistakes.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                <span className="text-xs font-semibold text-red-500 uppercase tracking-wider">Mistakes</span>
              </div>
              <ul className="space-y-1">
                {analysis.mistakes.map((m, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-red-500 mt-0.5">•</span>
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Patterns */}
          {analysis.patterns && analysis.patterns.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Patterns Across Trades</span>
              </div>
              <ul className="space-y-1">
                {analysis.patterns.map((p, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-blue-400 mt-0.5">→</span>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Next session focus */}
          {analysis.next_session_focus && analysis.next_session_focus.length > 0 && (
            <div className="bg-yellow-950/30 border border-yellow-800/50 rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Target className="w-3.5 h-3.5 text-yellow-400" />
                <span className="text-xs font-semibold text-yellow-400 uppercase tracking-wider">Focus Tomorrow</span>
              </div>
              <ul className="space-y-1">
                {analysis.next_session_focus.map((f, i) => (
                  <li key={i} className="text-sm text-gray-200 flex gap-2">
                    <span className="text-yellow-400 mt-0.5">▸</span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProcessCard({ process: p }: { process: ProcessVerdict }) {
  const [notesOpen, setNotesOpen] = useState(false)
  const isCompliant = p.verdict === 'Compliant'
  const Icon = isCompliant ? ShieldCheck : ShieldX
  const verdictColor = isCompliant ? 'text-green-400' : 'text-red-400'
  const borderColor = isCompliant ? 'border-green-800/60' : 'border-red-800/60'
  const bgColor = isCompliant ? 'bg-green-950/20' : 'bg-red-950/20'

  // Legacy rows have `notes` but no `headline`. Surface the notes' first
  // sentence as a faux-headline so the always-visible line still says
  // something useful for those days. New rows (post-headline prompt) will
  // have a proper headline.
  const fauxHeadline = !p.headline && p.notes
    ? p.notes.split(/(?<=[.!?])\s+/)[0]
    : null
  const visible = p.headline ?? fauxHeadline

  return (
    <div className={`${bgColor} ${borderColor} border rounded-lg p-3 space-y-2`}>
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${verdictColor}`} />
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Process</span>
        <span className={`ml-auto text-lg font-bold ${verdictColor}`}>{p.verdict}</span>
      </div>
      <div className="grid grid-cols-5 gap-1">
        {RULE_ORDER.map(id => (
          <RuleChip key={id} id={id} status={p.per_rule?.[id]} />
        ))}
      </div>
      {visible && (
        <p className="text-[11px] text-gray-300 leading-snug pt-1">{visible}</p>
      )}
      {p.notes && p.notes !== visible && (
        <div>
          {notesOpen && (
            <p className="text-[11px] text-gray-400 leading-snug">{p.notes}</p>
          )}
          <button
            type="button"
            onClick={() => setNotesOpen(o => !o)}
            className="text-[10px] text-blue-400 hover:text-blue-300"
          >
            {notesOpen ? 'Show less' : 'Show details'}
          </button>
        </div>
      )}
    </div>
  )
}

function RuleChip({ id, status }: { id: RuleId; status: RuleStatus | undefined }) {
  const s = status?.status ?? 'incomplete'
  const cls = s === 'pass'
    ? 'bg-green-900/40 text-green-300 border-green-800/60'
    : s === 'fail'
      ? 'bg-red-900/40 text-red-300 border-red-800/60'
      : 'bg-gray-800 text-gray-500 border-gray-700'
  const statusColor = s === 'pass' ? 'text-green-300' : s === 'fail' ? 'text-red-300' : 'text-gray-400'
  // Custom hover popup using group-hover — pure CSS, no React state needed.
  // Replaces the native title="" tooltip which (a) didn't show the rule
  // description, only the label, and (b) had a ~500ms delay that made the
  // 5-chip strip feel sluggish.
  return (
    <div className={`relative group ${cls} text-center text-[10px] font-mono py-1 rounded border cursor-help`}>
      {id}
      <div className="invisible group-hover:visible absolute z-30 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-gray-950 border border-gray-700 rounded-lg shadow-xl p-3 text-left pointer-events-none">
        <div className="flex items-baseline justify-between gap-2 mb-1.5">
          <span className="text-xs font-bold text-white">
            {id} — {RULE_LABELS[id]}
          </span>
          <span className={`text-[10px] font-mono uppercase ${statusColor}`}>{s}</span>
        </div>
        <p className="text-[11px] text-gray-300 leading-snug font-sans">
          {RULE_DESCRIPTIONS[id]}
        </p>
        {(status?.breach_count != null && status.breach_count > 0) && (
          <p className="text-[10px] text-red-400 font-mono mt-1.5">
            Breaches today: {status.breach_count}
          </p>
        )}
        {status?.reason && (
          <p className="text-[10px] text-gray-400 italic mt-1.5 font-sans leading-snug">
            {status.reason}
          </p>
        )}
        {/* arrow */}
        <div className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-950 border-r border-b border-gray-700 rotate-45 -mt-1" />
      </div>
    </div>
  )
}

function ExecutionCard({ execution: e }: { execution: ExecutionScore }) {
  const [notesOpen, setNotesOpen] = useState(false)
  const composite = e.composite
  const compositeColor = composite == null
    ? 'text-gray-500'
    : composite >= 0.7
      ? 'text-green-400'
      : composite >= 0.4
        ? 'text-yellow-400'
        : 'text-red-400'

  // RR null = no compliant trade had both a stop and a TP1, so planned R
  // couldn't be computed. The notes typically explain which trades lacked
  // which fields; surface a tight version in the tooltip so the user
  // doesn't have to scroll the notes block.
  const rrNullReason = e.planned_vs_realized_rr == null
    ? "RR couldn't be computed — at least one compliant trade needs both a stop_price and a tp1_price for planned vs realized R. Fill those in (or apply detected levels from the recording) and re-run."
    : null

  // Headline is the always-visible "why this score" line; notes hide behind
  // "Show details". Legacy rows have notes but no headline — surface the
  // first sentence of notes as a faux-headline so older analyses don't go
  // blank above the chips.
  const fauxHeadline = !e.headline && e.notes
    ? e.notes.split(/(?<=[.!?])\s+/)[0]
    : null
  const visible = e.headline ?? fauxHeadline

  return (
    <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-blue-400" />
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Execution</span>
        <span className={`ml-auto text-lg font-bold ${compositeColor}`}>
          {composite == null ? '—' : `${Math.round(composite * 100)}%`}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-2 text-center">
        <ExecMetric label="Exec Params" value={e.execution_parameters} weight="35%" />
        <ExecMetric label="MFE Cap" value={e.mfe_capture} weight="20%" />
        <ExecMetric label="Prep" value={e.prep_adherence} weight="20%" />
        <ExecMetric label="MAE Heat" value={e.mae_heat} weight="15%" />
        <ExecMetric label="RR" value={e.planned_vs_realized_rr} weight="10%" nullReason={rrNullReason} />
      </div>
      <p className="text-[10px] text-gray-500">
        Across {e.compliant_trade_count} compliant trade{e.compliant_trade_count === 1 ? '' : 's'} only — diagnostic, never blends with process.
      </p>
      {visible && (
        <p className="text-[11px] text-gray-300 leading-snug pt-1">{visible}</p>
      )}
      {e.notes && e.notes !== visible && (
        <div>
          {notesOpen && (
            <p className="text-[11px] text-gray-400 leading-snug">{e.notes}</p>
          )}
          <button
            type="button"
            onClick={() => setNotesOpen(o => !o)}
            className="text-[10px] text-blue-400 hover:text-blue-300"
          >
            {notesOpen ? 'Show less' : 'Show details'}
          </button>
        </div>
      )}
    </div>
  )
}

function ExecMetric({ label, value, weight, nullReason }: { label: string; value: number | null; weight: string; nullReason?: string | null }) {
  const isNull = value == null
  const tooltip = isNull && nullReason
    ? `${label} (weight ${weight}) — ${nullReason}`
    : `${label} (weight ${weight})`
  return (
    <div title={tooltip} className={isNull && nullReason ? 'cursor-help' : ''}>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`text-sm font-mono ${isNull && nullReason ? 'text-amber-400' : 'text-gray-200'}`}>
        {value == null ? '—' : `${Math.round(value * 100)}%`}
      </div>
    </div>
  )
}
