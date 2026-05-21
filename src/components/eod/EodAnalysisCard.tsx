'use client'

import { Brain, AlertTriangle, CheckCircle, Loader2, TrendingUp, Target } from 'lucide-react'
import type { EodAiAnalysis } from '@/lib/supabase/types'

interface Props {
  analysis: EodAiAnalysis | null
  loading: boolean
  onAnalyze: () => void
  disabled?: boolean
}

export default function EodAnalysisCard({ analysis, loading, onAnalyze, disabled }: Props) {
  const score = analysis?.score ?? 0
  const scoreColor = !analysis
    ? ''
    : score >= 7
      ? 'text-green-400'
      : score >= 4
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
          {/* Score + summary */}
          <div className="flex items-center gap-3 pb-3 border-b border-gray-800">
            <span className={`text-3xl font-bold ${scoreColor}`}>
              {score}
              <span className="text-lg text-gray-500">/10</span>
            </span>
            <p className="text-sm text-gray-300 leading-relaxed">{analysis.summary}</p>
          </div>

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
