'use client'

import { Brain, AlertTriangle, CheckCircle, Loader2, LineChart } from 'lucide-react'

interface Analysis {
  summary: string
  chart_thesis?: string
  chart_structure_notes?: string[]
  flags: string[]
  strengths: string[]
  score: number
  analyzed_at?: string
}

interface Props {
  analysis: Analysis | null
  loading: boolean
  onAnalyze: () => void
  disabled?: boolean
}

export default function AiAnalysisCard({ analysis, loading, onAnalyze, disabled }: Props) {
  const scoreColor = !analysis ? '' : analysis.score >= 7 ? 'text-green-400' : analysis.score >= 4 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-blue-400" />
          <h3 className="font-medium text-white text-sm">Prep Analysis</h3>
        </div>
        <button
          onClick={onAnalyze}
          disabled={loading || disabled}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
          {loading ? 'Analyzing...' : 'Analyze Prep'}
        </button>
      </div>

      {!analysis && !loading && (
        <p className="text-gray-500 text-sm">Fill in your prep notes above then click Analyze Prep to get objective feedback.</p>
      )}

      {analysis && (
        <div className="space-y-3">
          {/* Chart thesis */}
          {analysis.chart_thesis && (
            <div className="bg-blue-950/40 border border-blue-800/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-1.5">
                <LineChart className="w-3.5 h-3.5 text-blue-400" />
                <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">AI Chart Read</span>
              </div>
              <p className="text-sm text-gray-200 leading-relaxed">{analysis.chart_thesis}</p>
              {analysis.chart_structure_notes && analysis.chart_structure_notes.length > 0 && (
                <ul className="space-y-0.5 pt-1">
                  {analysis.chart_structure_notes.map((note, i) => (
                    <li key={i} className="text-xs text-blue-300 flex gap-2">
                      <span className="text-blue-500 mt-0.5 shrink-0">→</span>
                      {note}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Score */}
          <div className="flex items-center gap-3 pb-3 border-b border-gray-800">
            <span className={`text-3xl font-bold ${scoreColor}`}>{analysis.score}<span className="text-lg text-gray-500">/10</span></span>
            <p className="text-sm text-gray-300 leading-relaxed">{analysis.summary}</p>
          </div>

          {/* Flags */}
          {analysis.flags?.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />
                <span className="text-xs font-semibold text-yellow-500 uppercase tracking-wider">Watch Out</span>
              </div>
              <ul className="space-y-1">
                {analysis.flags.map((flag, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-yellow-500 mt-0.5">•</span>
                    {flag}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Strengths */}
          {analysis.strengths?.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                <span className="text-xs font-semibold text-green-500 uppercase tracking-wider">Strengths</span>
              </div>
              <ul className="space-y-1">
                {analysis.strengths.map((s, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-green-500 mt-0.5">•</span>
                    {s}
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
