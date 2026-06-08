'use client'

import { Brain, AlertTriangle, CheckCircle, Loader2, TrendingUp, Target, ShieldCheck, ShieldX, Activity } from 'lucide-react'
import type { EodAiAnalysis, ProcessVerdict, ExecutionScore, RuleId, RuleStatus } from '@/lib/supabase/types'

interface Props {
  analysis: EodAiAnalysis | null
  loading: boolean
  onAnalyze: () => void
  disabled?: boolean
}

const RULE_LABELS: Record<RuleId, string> = {
  P1: 'Daily Loss Limit',
  P2: 'Size Within Cap',
  P3: 'No Size-Up After Loss',
  P4: 'Stop Valid',
  P5: 'Cooldown ≥90s',
  P6: 'Trade Cap ≤7',
  P7: 'Setup Valid',
}

const RULE_ORDER: RuleId[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']

export default function EodAnalysisCard({ analysis, loading, onAnalyze, disabled }: Props) {
  // v1.3-era analyses populate `process` + `execution`. Pre-v1.3 rows only
  // have the legacy `score`. UI prefers v1.3 when present, falls back otherwise.
  const hasV13 = !!(analysis?.process || analysis?.execution)
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-blue-400" />
          <h3 className="font-medium text-white text-sm">Session Analysis</h3>
        </div>
        <button
          onClick={onAnalyze}
          disabled={loading || disabled}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
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
  const isCompliant = p.verdict === 'Compliant'
  const Icon = isCompliant ? ShieldCheck : ShieldX
  const verdictColor = isCompliant ? 'text-green-400' : 'text-red-400'
  const borderColor = isCompliant ? 'border-green-800/60' : 'border-red-800/60'
  const bgColor = isCompliant ? 'bg-green-950/20' : 'bg-red-950/20'

  return (
    <div className={`${bgColor} ${borderColor} border rounded-lg p-3 space-y-2`}>
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${verdictColor}`} />
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Process</span>
        <span className={`ml-auto text-lg font-bold ${verdictColor}`}>{p.verdict}</span>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {RULE_ORDER.map(id => (
          <RuleChip key={id} id={id} status={p.per_rule?.[id]} />
        ))}
      </div>
      {p.notes && (
        <p className="text-[11px] text-gray-400 leading-snug pt-1">{p.notes}</p>
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
  const tooltip = `${id} — ${RULE_LABELS[id]}\nstatus: ${s}` + (status?.breach_count ? `\nbreaches: ${status.breach_count}` : '') + (status?.reason ? `\n${status.reason}` : '')
  return (
    <div
      className={`${cls} text-center text-[10px] font-mono py-1 rounded border cursor-help`}
      title={tooltip}
    >
      {id}
    </div>
  )
}

function ExecutionCard({ execution: e }: { execution: ExecutionScore }) {
  const composite = e.composite
  const compositeColor = composite == null
    ? 'text-gray-500'
    : composite >= 0.7
      ? 'text-green-400'
      : composite >= 0.4
        ? 'text-yellow-400'
        : 'text-red-400'

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
        <ExecMetric label="Duration" value={e.duration_to_thesis} weight="25%" />
        <ExecMetric label="MFE Cap" value={e.mfe_capture} weight="25%" />
        <ExecMetric label="MAE Heat" value={e.mae_heat} weight="20%" />
        <ExecMetric label="Prep" value={e.prep_adherence} weight="20%" />
        <ExecMetric label="RR" value={e.planned_vs_realized_rr} weight="10%" />
      </div>
      <p className="text-[10px] text-gray-500">
        Across {e.compliant_trade_count} compliant trade{e.compliant_trade_count === 1 ? '' : 's'} only — diagnostic, never blends with process.
      </p>
      {e.notes && (
        <p className="text-[11px] text-gray-400 leading-snug pt-1">{e.notes}</p>
      )}
    </div>
  )
}

function ExecMetric({ label, value, weight }: { label: string; value: number | null; weight: string }) {
  return (
    <div title={`${label} (weight ${weight})`}>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="text-sm font-mono text-gray-200">
        {value == null ? '—' : `${Math.round(value * 100)}%`}
      </div>
    </div>
  )
}
