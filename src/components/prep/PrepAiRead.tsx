'use client'

import { cn } from '@/lib/utils'
import type { AiAnalysis } from '@/lib/supabase/types'

/**
 * The TapeScore read — plain read, yours to override.
 *
 * Replaces the scored "Prep Analysis" card. The "Prep quality 7/10" number is
 * deliberately gone: a score with no visible rubric is false precision, and it
 * put the app in the position of grading a plan it can't see the reasoning
 * behind. What's left is what the read can actually support — what it sees,
 * what to watch, and what's working — in the trader's own frame.
 *
 * Named "TapeScore suggested", never "Claude suggests": the trader owns every
 * decision on this page.
 */

export function watchAndKeep(analysis: AiAnalysis | null): { watch: string | null; keep: string | null } {
  return {
    watch: analysis?.flags?.find(Boolean) ?? null,
    keep: analysis?.strengths?.find(Boolean) ?? null,
  }
}

/** Highlights: one thing to watch, one thing to keep. Nothing else. */
export function WatchKeep({ analysis }: { analysis: AiAnalysis | null }) {
  const { watch, keep } = watchAndKeep(analysis)

  if (!watch && !keep) {
    return (
      <p className="text-sm text-gray-500 max-w-[62ch]">
        Run the read once your chart and notes are in — TapeScore will name one thing to watch and
        one thing to keep doing.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3.5">
      {watch && (
        <div className="flex gap-3.5 items-baseline">
          <span
            className="text-[13px] font-bold text-yellow-400 w-[50px] flex-shrink-0"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Watch
          </span>
          <p className="text-sm text-gray-100 leading-snug max-w-[62ch]">{watch}</p>
        </div>
      )}
      {keep && (
        <div className="flex gap-3.5 items-baseline">
          <span
            className="text-[13px] font-bold text-green-500 w-[50px] flex-shrink-0"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Keep
          </span>
          <p className="text-sm text-gray-100 leading-snug max-w-[62ch]">{keep}</p>
        </div>
      )}
    </div>
  )
}

function ReadRow({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-t border-gray-800 first:border-t-0 first:pt-0">
      <div className="text-[11px] tracking-wide uppercase text-gray-500 mb-1.5 font-semibold">{heading}</div>
      {children}
    </div>
  )
}

function Bullets({ items, tone }: { items: string[]; tone: 'watch' | 'keep' }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((t, i) => (
        <li key={i} className="text-[13.5px] text-gray-100 leading-snug flex gap-2.5 items-start">
          <span
            aria-hidden
            className={cn('font-mono text-xs mt-px flex-shrink-0', tone === 'watch' ? 'text-yellow-400' : 'text-green-400')}
          >
            {tone === 'watch' ? '!' : '+'}
          </span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  )
}

/** Detailed Tape: the full read. */
export default function PrepAiRead({ analysis }: { analysis: AiAnalysis | null }) {
  const chartRead = analysis?.chart_thesis || analysis?.summary || null
  const watch = (analysis?.flags ?? []).filter(Boolean)
  const strengths = (analysis?.strengths ?? []).filter(Boolean)

  if (!chartRead && watch.length === 0 && strengths.length === 0) {
    return (
      <p className="text-sm text-gray-500 max-w-[62ch]">
        No read yet. Run it once your chart and notes are in — TapeScore reads the chart, names what
        to watch, and says what is already working. It never scores your plan.
      </p>
    )
  }

  return (
    <div>
      {chartRead && (
        <ReadRow heading="Chart read">
          <p className="text-sm text-gray-100 leading-normal max-w-[64ch]">{chartRead}</p>
        </ReadRow>
      )}
      {watch.length > 0 && (
        <ReadRow heading="Watch out">
          <Bullets items={watch} tone="watch" />
        </ReadRow>
      )}
      {strengths.length > 0 && (
        <ReadRow heading="Working">
          <Bullets items={strengths} tone="keep" />
        </ReadRow>
      )}
    </div>
  )
}
