'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { PrepCommitment } from '@/lib/supabase/types'

/**
 * The other half of the Review → Prep loop.
 *
 * Prep imports one finding from the trader's own history and turns it into a
 * commitment for the session. Until now that commitment was displayed and
 * persisted but never closed — which made it a label, not a loop. This is where
 * it resolves.
 *
 * Deliberately not a graded question. It asks what happened, in the trader's
 * own words, and records it. TapeScore doesn't get to decide whether you kept
 * your word — it only has to remember that you made the promise, and what you
 * said about it. The resolved flag is what lets a future finding say "you held
 * this 6 of 8 sessions" instead of guessing.
 */
export default function CommitmentResolution({
  date,
  commitment,
  /** Past dates stay editable — traders review a day late all the time. */
  editable = true,
}: {
  date: string
  commitment: PrepCommitment
  editable?: boolean
}) {
  const [resolved, setResolved] = useState<PrepCommitment['resolved']>(commitment.resolved)
  const [saving, setSaving] = useState<'followed' | 'not_followed' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isProtect = commitment.mode === 'protect'

  const choose = async (choice: 'followed' | 'not_followed') => {
    if (!editable || saving) return
    // Tapping the current answer clears it — changing your mind is allowed
    // until you stop looking at the day.
    const next = resolved === choice ? null : choice
    setSaving(choice)
    setError(null)
    try {
      const res = await fetch(`/api/commitment/${date}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error ?? 'Could not save that')
        return
      }
      setResolved(next ?? undefined)
    } catch {
      setError('Could not save that — check your connection')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div
      className={cn(
        'mb-6 px-5 py-4 border border-gray-800 border-l-[3px] rounded-lg bg-gray-900',
        isProtect ? 'border-l-green-700' : 'border-l-blue-500',
      )}
    >
      <div
        className={cn(
          'font-mono text-[11px] tracking-[0.13em] uppercase mb-2.5',
          isProtect ? 'text-green-400' : 'text-blue-400',
        )}
      >
        You committed to this before the open
      </div>

      <div className="flex gap-3 items-baseline mb-1">
        <span
          className={cn('text-[13px] font-bold flex-shrink-0', isProtect ? 'text-green-400' : 'text-blue-400')}
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Today
        </span>
        <span
          className="text-[19px] font-bold tracking-[-0.015em] text-gray-100 leading-[1.22] max-w-[46ch]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {commitment.today}
        </span>
      </div>
      <p className="text-[13px] text-gray-500 mb-4 max-w-[62ch]">
        From your {commitment.source} — {commitment.finding.toLowerCase()}, {commitment.metric}.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[13px] text-gray-400">Did you hold to it?</span>
        {(['followed', 'not_followed'] as const).map(choice => {
          const on = resolved === choice
          const label = choice === 'followed' ? 'I held it' : 'I didn’t'
          return (
            <button
              key={choice}
              type="button"
              onClick={() => choose(choice)}
              disabled={!editable || saving !== null}
              aria-pressed={on}
              className={cn(
                'text-[13px] px-3 py-1.5 rounded border transition-colors disabled:opacity-60',
                on
                  ? choice === 'followed'
                    ? 'border-green-700 text-green-400 bg-green-400/[0.08]'
                    : 'border-yellow-700 text-yellow-400 bg-yellow-400/[0.08]'
                  : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600',
              )}
            >
              {saving === choice ? 'Saving…' : label}
            </button>
          )
        })}
        {resolved && (
          <span className="text-[11px] text-gray-500">
            {resolved === 'followed'
              ? 'Recorded — this is what turns a promise into a pattern.'
              : 'Recorded. Naming it is the useful part, not the outcome.'}
          </span>
        )}
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    </div>
  )
}
