import type { RankedInsight, InsightTone } from '@/lib/data-insights'

/**
 * Shared renderer for the tag-free "what your data already says" insights
 * (Pt 15). One component, two shapes:
 *
 *  - variant="analytics": a titled block that leads the Patterns page — the
 *    payoff a tagless account gets where the Setup table would otherwise
 *    collapse to a single Discretionary bucket.
 *  - variant="card": a compact strip under the first-read best/worst day cards.
 *
 * Pure/presentational (no hooks) so it drops into either the client Analytics
 * page or the client FirstReadCards. Renders nothing when there are no gated
 * insights — on a thin account the engine suppresses everything, and an empty
 * "what your data says" header is worse than no header.
 */

const TONE_DOT: Record<InsightTone, string> = {
  good: 'bg-emerald-400',
  bad: 'bg-rose-400',
  neutral: 'bg-gray-400',
}
const TONE_CHIP: Record<InsightTone, string> = {
  good: 'text-emerald-300',
  bad: 'text-rose-300',
  neutral: 'text-gray-400',
}

export default function DataInsights({
  insights,
  variant,
}: {
  insights: RankedInsight[]
  variant: 'analytics' | 'card'
}) {
  if (!insights.length) return null

  if (variant === 'card') {
    return (
      <div className="mt-4 border-t border-amber-900/30 pt-3">
        <p className="text-xs font-semibold text-amber-100/90 mb-2">What your data already says</p>
        <ul className="space-y-1.5">
          {insights.map(i => (
            <li key={i.key} className="flex gap-2 text-xs leading-snug">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[i.tone]}`} />
              <span>
                <span className="font-medium text-gray-200">{i.headline}.</span>{' '}
                <span className="text-gray-400">{i.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // variant === 'analytics'
  return (
    <section data-tour="analytics-insights">
      <h2
        className="text-[clamp(16px,1.8vw,19px)] font-bold tracking-[-0.02em] text-gray-100"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        What your data already says
      </h2>
      <p className="text-gray-500 text-xs mt-1 mb-3">
        Pulled straight from your fills — no tags needed. Only the patterns with enough trades to trust.
      </p>
      <div>
        {insights.map(i => (
          <div key={i.key} className="grid grid-cols-[auto_1fr] gap-3 items-start border-t border-gray-800 py-3">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[i.tone]}`} />
            <div>
              <span className={`text-[10px] font-semibold uppercase tracking-wide ${TONE_CHIP[i.tone]}`}>
                {i.dimension}
              </span>
              <p className="text-[15px] font-semibold text-gray-100 leading-snug">{i.headline}</p>
              <p className="text-sm text-gray-400 leading-snug mt-0.5">{i.detail}</p>
              <p className="text-[11px] text-gray-600 mt-1 tabular-nums">{i.footnote}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
