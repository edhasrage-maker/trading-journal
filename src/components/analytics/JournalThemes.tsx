'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Sparkles, Loader2, RefreshCw, AlertTriangle, TrendingUp, TrendingDown, Minus, HelpCircle, Quote } from 'lucide-react'
import { formatDistanceToNowStrict } from 'date-fns'
import type { EnrichedTheme } from '@/lib/themes-prompt'

interface Props {
  from: string
  to: string
}

interface ApiResponse {
  themes: EnrichedTheme[]
  notes_count: number | null
  generated_at: string
  model: string
  cached: boolean
}

interface ApiError {
  error: string
  notes_count?: number
}

/**
 * Journal Themes — surfaces recurring framings the trader keeps returning to
 * in their EOD notes, with verbatim excerpts and grade/PnL correlation per
 * theme. Cached server-side; clicking Generate re-runs Claude.
 */
export default function JournalThemes({ from, to }: Props) {
  const [open, setOpen] = useState(true)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emptyCorpus, setEmptyCorpus] = useState(false)

  // Fetch cached result on range change. forceRefresh=false → 200 if cached,
  // 400 if no qualifying notes in range, anything else surfaces as error.
  const load = useCallback(async (forceRefresh: boolean) => {
    setLoading(true)
    setError(null)
    setEmptyCorpus(false)
    try {
      const res = await fetch('/api/extract-themes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, forceRefresh }),
      })
      const json = await res.json()
      if (!res.ok) {
        const err = json as ApiError
        if (res.status === 400 && err.notes_count === 0) {
          setEmptyCorpus(true)
          setData(null)
        } else {
          setError(err.error || `${res.status} ${res.statusText}`)
        }
        return
      }
      setData(json as ApiResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  // Auto-load cached themes whenever the date range changes. forceRefresh is
  // false so this is free if the cache is warm — only the explicit Generate
  // button triggers a Claude call (and the corresponding token spend).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() triggers loading/error setState chains; this is the standard sync-effect shape per CLAUDE.md.
    void load(false)
  }, [load])

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex items-start gap-2 text-left flex-1"
        >
          <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          <div>
            <h2 className="font-semibold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-400" />
              Journal Themes
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Recurring framings in your EOD notes, correlated to your grade and PnL.
            </p>
          </div>
        </button>

        {open && (
          <div className="flex items-center gap-3 shrink-0">
            {data && (
              <span className="text-[10px] text-gray-600 font-mono" title={`generated ${data.generated_at} · ${data.model}`}>
                {data.cached ? 'cached' : 'fresh'} · {formatDistanceToNowStrict(new Date(data.generated_at))} ago · {data.notes_count} notes
              </span>
            )}
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading || emptyCorpus}
              className="flex items-center gap-1.5 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              title={data ? 'Re-run analysis (uses tokens)' : 'Run AI analysis (uses tokens)'}
            >
              {loading
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : data
                  ? <RefreshCw className="w-3 h-3" />
                  : <Sparkles className="w-3 h-3" />
              }
              {loading ? 'Analyzing…' : data ? 'Regenerate' : 'Generate'}
            </button>
          </div>
        )}
      </div>

      {open && (
        <>
          {error && (
            <div className="flex items-start gap-2 bg-red-950/40 border border-red-900 text-red-300 rounded-lg px-3 py-2 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {emptyCorpus && (
            <p className="text-center text-xs text-gray-500 italic py-6">
              No EOD notes with at least 20 characters in this range. Write reflections in your EOD recaps to build the corpus.
            </p>
          )}

          {!error && !emptyCorpus && !data && !loading && (
            <p className="text-center text-xs text-gray-500 italic py-6">
              Click <span className="text-purple-400">Generate</span> to extract recurring themes from your EOD notes in this range.
            </p>
          )}

          {data && data.themes.length === 0 && (
            <p className="text-center text-xs text-gray-500 italic py-6">
              No recurring themes identified. Either the corpus is too small or notes don&apos;t yet have enough recurring patterns.
            </p>
          )}

          {data && data.themes.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              {data.themes.map((theme, i) => (
                <ThemeCard key={i} theme={theme} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function ThemeCard({ theme }: { theme: EnrichedTheme }) {
  const TrendIcon = theme.trend === 'improving'
    ? TrendingDown // less frequent over time → ↓ (improvement on a "frequency of issue" theme)
    : theme.trend === 'worsening'
      ? TrendingUp
      : theme.trend === 'steady'
        ? Minus
        : HelpCircle
  const trendColor = theme.trend === 'improving' ? 'text-green-400'
    : theme.trend === 'worsening' ? 'text-red-400'
    : 'text-gray-500'

  const freqColor = theme.frequency_estimate === 'high' ? 'text-amber-300 bg-amber-950/40 border-amber-900'
    : theme.frequency_estimate === 'medium' ? 'text-blue-300 bg-blue-950/40 border-blue-900'
    : 'text-gray-400 bg-gray-800 border-gray-700'

  return (
    <article className="bg-gray-950 border border-gray-800 rounded-lg p-4 space-y-3">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-white text-sm leading-tight">{theme.label}</h3>
          <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${freqColor}`}>
            {theme.frequency_estimate}
          </span>
        </div>
        <p className="text-xs text-gray-400 leading-snug">{theme.summary}</p>
      </header>

      {/* Correlation chips */}
      <div className="flex items-center gap-2 text-[11px] font-mono flex-wrap">
        <span className={`flex items-center gap-1 ${trendColor}`} title={`trend: ${theme.trend}`}>
          <TrendIcon className="w-3 h-3" />
          {theme.trend}
        </span>
        {theme.evidence_dates.length > 0 && (
          <span className="text-gray-500">· {theme.evidence_dates.length} day{theme.evidence_dates.length === 1 ? '' : 's'} quoted</span>
        )}
        {theme.avg_grade != null && (
          <span className={`px-1.5 py-0.5 rounded ${theme.avg_grade >= 7 ? 'bg-green-950/40 text-green-300' : theme.avg_grade >= 5 ? 'bg-yellow-950/40 text-yellow-300' : 'bg-red-950/40 text-red-300'}`} title="Average overall_grade on days where this theme was quoted">
            grade {theme.avg_grade.toFixed(1)}
          </span>
        )}
        {theme.avg_pnl != null && (
          <span className={`px-1.5 py-0.5 rounded ${theme.avg_pnl > 0 ? 'bg-green-950/40 text-green-300' : 'bg-red-950/40 text-red-300'}`} title="Average eod_pnl on days where this theme was quoted">
            PnL {theme.avg_pnl >= 0 ? '+' : ''}${theme.avg_pnl.toFixed(0)}
          </span>
        )}
        {theme.avg_process_score != null && (
          <span className={`px-1.5 py-0.5 rounded ${theme.avg_process_score >= 7 ? 'bg-green-950/40 text-green-300' : theme.avg_process_score >= 5 ? 'bg-yellow-950/40 text-yellow-300' : 'bg-red-950/40 text-red-300'}`} title="Average prep-quality score on days where this theme was quoted">
            prep {theme.avg_process_score.toFixed(1)}
          </span>
        )}
      </div>

      {/* Excerpts */}
      <ul className="space-y-2 text-xs">
        {theme.excerpts.slice(0, 3).map((ex, i) => (
          <li key={i} className="flex gap-2">
            <Quote className="w-3 h-3 text-gray-700 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <Link
                href={`/eod/${ex.date}`}
                className="text-purple-400 hover:text-purple-300 text-[10px] font-mono"
              >
                {ex.date}
              </Link>
              <p className="text-gray-300 italic leading-snug mt-0.5">&ldquo;{ex.text}&rdquo;</p>
            </div>
          </li>
        ))}
      </ul>
    </article>
  )
}
