'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Sparkles, ArrowRight, X } from 'lucide-react'
import type { FirstReadTeaser } from '@/app/api/first-read/route'
import DataInsights from '@/components/insights/DataInsights'
import type { RankedInsight } from '@/lib/data-insights'

/**
 * Post-import retroactive recap (alpha-readiness item 22). Picks the tester's
 * best and toughest historical day and teases the EOD read for each — the same
 * capture / heat / behavioral read they'll get after every session — so the
 * product pays off the moment their first import lands. Each card deep-links
 * into the full recap at /eod/<date>; no parallel recap surface is built.
 *
 * Two mounts, one component:
 *  - variant="dashboard": self-gates on the write-once `first_read` flag +
 *    dismissed state (fetched from /api/first-read). Dismissible.
 *  - variant="import":   always renders (the /import success block controls it);
 *    no dismiss affordance — it's a one-shot post-import payoff.
 */
export default function FirstReadCards({ variant }: { variant: 'dashboard' | 'import' }) {
  const [best, setBest] = useState<FirstReadTeaser | null>(null)
  const [worst, setWorst] = useState<FirstReadTeaser | null>(null)
  const [insights, setInsights] = useState<RankedInsight[]>([])
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // The dashboard gate returns early on the cheap armed/dismissed flag;
        // the import success block always needs the teaser, so it forces the
        // full history scan.
        const url = variant === 'import' ? '/api/first-read?force=1' : '/api/first-read'
        const r = await fetch(url).then(res => res.json())
        if (cancelled) return
        // Dashboard only shows once armed (first import) and not dismissed.
        const show = variant === 'import' ? true : (r.armed === true && r.dismissed !== true)
        if (r.best) setBest(r.best)
        if (r.worst) setWorst(r.worst)
        if (Array.isArray(r.insights)) setInsights(r.insights)
        setVisible(show && r.best != null)
      } catch {
        /* silent — no card rather than an error state */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [variant])

  const dismiss = () => {
    setVisible(false)
    fetch('/api/first-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismiss: true }),
    }).catch(() => {})
  }

  if (!loaded || !visible || !best) return null

  const single = worst == null // one day of history → a single "first read" card

  // Capture and heat come from per-trade MFE/MAE, which only exist if the
  // import carried them: most broker CSVs and every Sierra trade-activity log
  // have no excursion columns, and the hosted app has no bar data to derive
  // them from. The intro used to promise "how much of the move you kept, the
  // heat you took" regardless — and then the cards showed neither, which reads
  // as broken rather than as missing input. So say what this read is actually
  // built from, and what unlocks the rest.
  const hasExcursion = [best, worst].some(
    t => t != null && (t.capturePct != null || t.mfeMaeRatio != null),
  )

  return (
    <div className="relative rounded-xl border border-amber-900/50 bg-gradient-to-b from-amber-950/25 to-gray-900 p-5 mb-6">
      {variant === 'dashboard' && (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="absolute top-3 right-3 text-amber-500/60 hover:text-amber-300 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
        <h2 className="text-sm font-semibold text-amber-100">Your first read</h2>
      </div>
      <p className="text-xs text-gray-400 max-w-xl mb-4">
        {`Your history’s in. Here’s how ${single ? 'that day' : 'two of your days'} actually went — the same read you’ll get after every session: `}
        {hasExcursion
          ? 'how much of the move you kept, the heat you took, and how you behaved.'
          : 'what you made, how often you were right, and how you behaved.'}
      </p>

      {!hasExcursion && (
        <p className="text-[11px] text-gray-500 max-w-xl mb-4 -mt-2">
          Want the move-capture and heat reads too? Those need per-trade MFE/MAE, which your export
          didn&apos;t include —{' '}
          <Link href="/import" className="text-amber-300/90 hover:text-amber-200 underline underline-offset-2">
            re-import with those columns
          </Link>{' '}
          and they fill in.
        </p>
      )}

      <div className={`grid gap-3 ${single ? 'sm:grid-cols-1 max-w-md' : 'sm:grid-cols-2'}`}>
        <TeaserCard teaser={best} kind="best" />
        {worst && <TeaserCard teaser={worst} kind="worst" />}
      </div>

      {/* Tag-free insights strip (Pt 15) — patterns pulled from the raw fills,
          so the payoff isn't limited to two days. Renders nothing when the
          engine has no gated insight to show. */}
      <DataInsights insights={insights} variant="card" />
    </div>
  )
}

function TeaserCard({ teaser, kind }: { teaser: FirstReadTeaser; kind: 'best' | 'worst' }) {
  const isBest = kind === 'best'
  const pnlPositive = teaser.pnl >= 0
  const dayLabel = (() => {
    // date is YYYY-MM-DD; render at noon so timezone never rolls it a day back.
    try { return format(new Date(`${teaser.date}T12:00:00`), 'EEE, MMM d') } catch { return teaser.date }
  })()

  return (
    <Link
      href={`/review/today/${teaser.date}`}
      className={`group block rounded-lg border p-4 transition-colors ${
        isBest
          ? 'border-emerald-900/50 bg-emerald-950/20 hover:border-emerald-700/70'
          : 'border-rose-900/50 bg-rose-950/20 hover:border-rose-700/70'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${isBest ? 'text-emerald-300' : 'text-rose-300'}`}>
          {isBest ? 'Best day' : 'Toughest day'}
        </span>
        <span className="text-xs text-gray-400">{dayLabel}</span>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className={`font-mono text-xl font-bold ${pnlPositive ? 'text-green-400' : 'text-red-400'}`}>
          {`${pnlPositive ? '+' : '−'}$${Math.abs(teaser.pnl).toFixed(0)}`}
        </span>
        <span className="text-xs text-gray-500">{teaser.tradeCount} trade{teaser.tradeCount === 1 ? '' : 's'}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
        {teaser.winRate != null && (
          <span>Win <span className="text-gray-200 font-mono">{teaser.winRate.toFixed(0)}%</span></span>
        )}
        {teaser.capturePct != null && (
          <span>Profit Captured <span className="text-gray-200 font-mono">{teaser.capturePct}%</span></span>
        )}
        {teaser.mfeMaeRatio != null && (
          <span>MFE:MAE <span className="text-gray-200 font-mono">{teaser.mfeMaeRatio.toFixed(1)}×</span></span>
        )}
      </div>

      {teaser.flag && (
        <p className="mt-2 text-xs leading-snug text-gray-300">{teaser.flag}</p>
      )}

      <span className={`mt-3 inline-flex items-center gap-1 text-xs font-medium ${isBest ? 'text-emerald-300' : 'text-rose-300'}`}>
        Open the full read
        <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
