'use client'

import { useState } from 'react'
import { Sparkles, Loader2, Check, X, RefreshCw, AlertTriangle } from 'lucide-react'

interface Props {
  date: string
  currentDayType: string
  onAccept: (dayType: string) => void
}

interface Prediction {
  prediction: string
  reasoning: string
  confidence: 'high' | 'medium' | 'low'
  model: string
  generated_at: string
}

/**
 * Predict day type for the current prep date. Manual-trigger only — clicking
 * the button fires /api/predict-day-type, which reads market_context and
 * prep_notes_json off trading_days. Result is held in component state; the
 * suggestion does NOT persist to the database until the user clicks Accept,
 * which calls onAccept() to set the parent's dayType state. The parent saves
 * to trading_days as part of its normal auto-save / manual save flow.
 */
export default function DayTypePredictor({ date, currentDayType, onAccept }: Props) {
  const [loading, setLoading] = useState(false)
  const [prediction, setPrediction] = useState<Prediction | null>(null)
  const [error, setError] = useState<string | null>(null)

  const predict = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/predict-day-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `${res.status} ${res.statusText}`)
        setPrediction(null)
        return
      }
      setPrediction(data as Prediction)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error')
    } finally {
      setLoading(false)
    }
  }

  const accept = () => {
    if (!prediction) return
    onAccept(prediction.prediction)
    setPrediction(null) // collapse the chip after acceptance
  }

  const dismiss = () => {
    setPrediction(null)
    setError(null)
  }

  const isCurrent = prediction && currentDayType === prediction.prediction

  return (
    <div className="mt-3 space-y-2">
      {!prediction && !error && (
        <button
          type="button"
          onClick={predict}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
          title="Ask Claude to predict the day type from this date's market context and prep notes"
        >
          {loading
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Sparkles className="w-3 h-3" />}
          {loading ? 'Analyzing…' : 'Predict day type (AI)'}
        </button>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div>{error}</div>
            <button
              type="button"
              onClick={dismiss}
              className="text-red-400 hover:text-red-200 mt-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {prediction && (
        <div className="bg-purple-950/30 border border-purple-900 rounded-lg p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-purple-400 font-medium flex items-center flex-wrap gap-x-2 gap-y-0.5">
                <span>
                  Claude suggests <span className="text-purple-200 font-semibold">{prediction.prediction}</span>
                </span>
                <ConfidenceBadge confidence={prediction.confidence} />
                {isCurrent && <span className="text-purple-400 font-normal">(already set)</span>}
              </div>
              <p className="text-xs text-gray-300 italic mt-1 leading-snug">{prediction.reasoning}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            {!isCurrent && (
              <button
                type="button"
                onClick={accept}
                className="flex items-center gap-1 bg-purple-700 hover:bg-purple-600 text-white text-xs font-medium px-2.5 py-1 rounded transition-colors"
              >
                <Check className="w-3 h-3" />
                Accept
              </button>
            )}
            <button
              type="button"
              onClick={predict}
              disabled={loading}
              className="flex items-center gap-1 text-purple-400 hover:text-purple-300 disabled:text-gray-600 disabled:cursor-not-allowed text-xs px-2 py-1 transition-colors"
              title="Re-run the prediction (uses tokens)"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {loading ? 'Re-analyzing…' : 'Regenerate'}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="flex items-center gap-1 text-gray-500 hover:text-gray-300 text-xs px-2 py-1 transition-colors"
            >
              <X className="w-3 h-3" />
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Confidence chip beside the suggestion. Honesty signal — low confidence
 * means the heuristics didn't cleanly converge and the trader should treat
 * the suggestion as a starting point, not a verdict.
 */
function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const styles =
    confidence === 'high'
      ? 'bg-green-900/40 border-green-700/60 text-green-300'
      : confidence === 'medium'
        ? 'bg-yellow-900/40 border-yellow-700/60 text-yellow-300'
        : 'bg-red-900/40 border-red-700/60 text-red-300'
  const title =
    confidence === 'high'
      ? 'Heuristics align cleanly across structural inputs and bias.'
      : confidence === 'medium'
        ? 'Most signals align but at least one conflict or missing input — verify before accepting.'
        : 'Signals are conflicting or sparse — treat this as a starting point, not a verdict.'
  return (
    <span
      className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${styles}`}
      title={title}
    >
      {confidence} confidence
    </span>
  )
}
