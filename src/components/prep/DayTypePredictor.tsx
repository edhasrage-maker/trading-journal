'use client'

import { useMemo, useState } from 'react'
import { Sparkles, Loader2, Check, X, RefreshCw, AlertTriangle } from 'lucide-react'

interface Props {
  date: string
  /** Currently-selected day types on the prep form. Used to mark which
   *  predicted labels are "already set" so the UI doesn't re-add duplicates. */
  currentDayTypes: string[]
  /** Accept handler — receives the array of labels the user kept. Parent
   *  dedupes and appends to its day_types[] state. */
  onAccept: (labels: string[]) => void
}

type Confidence = 'high' | 'medium' | 'low'
type Axis = 'structural' | 'regime' | 'flag'

interface PredictionItem {
  label: string
  confidence: Confidence
  axis: Axis
}

interface PredictResponse {
  predictions: PredictionItem[]
  reasoning: string
  model: string
  generated_at: string
}

const AXIS_TITLES: Record<Axis, string> = {
  structural: 'Structural',
  regime: 'Regime',
  flag: 'Flag',
}

/**
 * Multi-axis day-type predictor. Asks Claude to identify the day's character
 * across three axes (structural / regime / flags) and returns 1-N suggestions
 * each with its own confidence. The user can drop individual suggestions
 * before clicking Accept — the kept set is sent to the parent in one call.
 *
 * Replaces the earlier single-pick design which would only ever suggest one
 * label even when multiple clearly applied (e.g. a Trend Day on a High Action
 * session would surface only "Trend Day", losing the regime signal).
 */
export default function DayTypePredictor({ date, currentDayTypes, onAccept }: Props) {
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<PredictResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Labels the user has dismissed from the current prediction set — they
   *  won't be sent to onAccept. Reset whenever a new prediction arrives. */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const currentSet = useMemo(() => new Set(currentDayTypes), [currentDayTypes])

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
        setResponse(null)
        return
      }
      setResponse(data as PredictResponse)
      setDismissed(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error')
    } finally {
      setLoading(false)
    }
  }

  /** Labels eligible to accept: predicted, not dismissed, not already set. */
  const acceptable = useMemo(() => {
    if (!response) return []
    return response.predictions
      .map(p => p.label)
      .filter(label => !dismissed.has(label) && !currentSet.has(label))
  }, [response, dismissed, currentSet])

  const acceptAll = () => {
    if (acceptable.length === 0) return
    onAccept(acceptable)
    setResponse(null)
    setDismissed(new Set())
  }

  const toggleDismiss = (label: string) => {
    setDismissed(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  const dismissAll = () => {
    setResponse(null)
    setError(null)
    setDismissed(new Set())
  }

  return (
    <div className="mt-3 space-y-2">
      {!response && !error && (
        <button
          type="button"
          onClick={predict}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
          title="Ask Claude to predict day type(s) from this date's market context and prep notes"
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
            <button type="button" onClick={dismissAll} className="text-red-400 hover:text-red-200 mt-1">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {response && (
        <div className="bg-purple-950/30 border border-purple-900 rounded-lg p-3 space-y-3">
          <div className="flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-purple-400 font-medium">
                Claude suggests{' '}
                <span className="text-purple-200 font-semibold">
                  {response.predictions.length} label{response.predictions.length === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-xs text-gray-300 italic mt-1 leading-snug">{response.reasoning}</p>
            </div>
          </div>

          {/* Per-prediction chip row. Each chip shows label + axis + confidence,
              with a click-to-dismiss × so the user can drop a single suggestion
              before accepting the rest. Already-set labels are visually muted
              and ignored on Accept. */}
          <div className="flex flex-wrap gap-1.5">
            {response.predictions.map(p => {
              const isCurrent = currentSet.has(p.label)
              const isDismissed = dismissed.has(p.label)
              return (
                <PredictionChip
                  key={`${p.axis}-${p.label}`}
                  prediction={p}
                  isCurrent={isCurrent}
                  isDismissed={isDismissed}
                  onToggleDismiss={() => toggleDismiss(p.label)}
                />
              )
            })}
          </div>

          <div className="flex items-center gap-2 pt-1">
            {acceptable.length > 0 && (
              <button
                type="button"
                onClick={acceptAll}
                className="flex items-center gap-1 bg-purple-700 hover:bg-purple-600 text-white text-xs font-medium px-2.5 py-1 rounded transition-colors"
              >
                <Check className="w-3 h-3" />
                Accept {acceptable.length} label{acceptable.length === 1 ? '' : 's'}
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
              onClick={dismissAll}
              className="flex items-center gap-1 text-gray-500 hover:text-gray-300 text-xs px-2 py-1 transition-colors"
            >
              <X className="w-3 h-3" />
              Dismiss all
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

interface ChipProps {
  prediction: PredictionItem
  isCurrent: boolean
  isDismissed: boolean
  onToggleDismiss: () => void
}

function PredictionChip({ prediction, isCurrent, isDismissed, onToggleDismiss }: ChipProps) {
  const { label, confidence, axis } = prediction
  const confidenceStyles =
    confidence === 'high'
      ? 'border-green-700/60 text-green-300'
      : confidence === 'medium'
        ? 'border-yellow-700/60 text-yellow-300'
        : 'border-red-700/60 text-red-300'
  const axisColor =
    axis === 'structural' ? 'text-blue-300'
    : axis === 'regime' ? 'text-amber-300'
    : 'text-fuchsia-300'

  return (
    <div
      className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-opacity ${
        isCurrent ? 'opacity-40 border-gray-700 bg-gray-900/40'
        : isDismissed ? 'opacity-30 border-gray-700 bg-gray-900/40 line-through'
        : 'border-purple-700 bg-purple-950/40'
      }`}
      title={
        isCurrent ? `${label} is already set on this day — won't be re-added`
        : isDismissed ? 'Dismissed — click again to keep'
        : `${AXIS_TITLES[axis]} axis, ${confidence} confidence`
      }
    >
      <span className={`text-[9px] uppercase tracking-wider font-mono ${axisColor}`}>
        {AXIS_TITLES[axis]}
      </span>
      <span className="text-gray-200 font-medium">{label}</span>
      <span className={`text-[9px] uppercase font-mono border rounded px-1 py-px ${confidenceStyles}`}>
        {confidence}
      </span>
      {isCurrent ? (
        <span className="text-[9px] text-gray-500 italic">already set</span>
      ) : (
        <button
          type="button"
          onClick={onToggleDismiss}
          className="ml-0.5 text-gray-500 hover:text-gray-200 transition-colors"
          aria-label={isDismissed ? 'Keep' : 'Dismiss'}
          title={isDismissed ? 'Click to keep this suggestion' : 'Click to drop this suggestion'}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  )
}
