'use client'

import { cn } from '@/lib/utils'
import type { Carryover } from '@/lib/prep-carryover'
import type { PrepCommitment, PrepNotes } from '@/lib/supabase/types'

/**
 * The Review → Prep bridge — the approved centrepiece of the Prep page.
 *
 * "The most distinctive thing on the page" (founder, R2.1). It closes the loop
 * the product promises: Review DIAGNOSES, Prep PRESCRIBES, and the session
 * resolves it. The hierarchy it sits in is deliberate and was confirmed
 * explicitly — What's happening today? (the hero) → What did my review teach
 * me? → What am I committing to? → Track whether I do it. It stays BELOW the
 * market read: yesterday's lesson is not today's market read, and pretending
 * otherwise would be dishonest.
 *
 * Two modes, and the second is the point of having modes at all:
 *   correct — a leak to avoid (imported from a finding that cost the trader)
 *   protect — an edge to keep. Prep must be able to protect what works, not
 *             only import mistakes.
 *
 * Tracking is a real commitment, not a label: it persists into prep_notes_json
 * and is resolved at review time.
 */
export default function PrepBridge({
  carryover,
  prepNotes,
  onPrepNotesChange,
  canTrack,
}: {
  /** Null when no finding separated itself — we show the honest empty state. */
  carryover: Carryover | null
  prepNotes: PrepNotes
  onPrepNotesChange: (v: PrepNotes) => void
  /** Past-dated preps are read-only for commitments — you can't commit to a
   *  session that already happened. */
  canTrack: boolean
}) {
  const committed = prepNotes.commitment ?? null
  // A commitment already tracked for this day wins over a freshly computed
  // finding: the trader committed to THAT wording, and the numbers behind a
  // live finding can move during the session.
  const shown: Carryover | PrepCommitment | null = committed ?? carryover
  const tracked = !!committed

  if (!shown) {
    return (
      <div className="mt-1 mb-1 px-5 py-4 border border-gray-800 border-l-[3px] border-l-gray-700 rounded-lg bg-gray-900">
        <div className="font-mono text-[11px] tracking-[0.13em] uppercase text-gray-500 mb-2">
          From your review
        </div>
        <p className="text-sm text-gray-400 max-w-[62ch] leading-normal">
          No clear read yet — nothing in your recent sessions separated itself at a sample size
          worth acting on. Not every month has a lesson, and manufacturing one would be the mistake.
        </p>
        <p className="text-xs text-gray-500 mt-2">
          A commitment appears here as soon as one of your setups, tags or exits shows a real gap.
        </p>
      </div>
    )
  }

  const isProtect = shown.mode === 'protect'

  const track = () => {
    if (!carryover || !canTrack) return
    const commitment: PrepCommitment = {
      key: carryover.key,
      mode: carryover.mode,
      source: carryover.source,
      finding: carryover.finding,
      metric: carryover.metric,
      today: carryover.today,
      tracked_at: new Date().toISOString(),
    }
    onPrepNotesChange({ ...prepNotes, commitment })
  }

  const untrack = () => {
    const next = { ...prepNotes }
    delete next.commitment
    onPrepNotesChange(next)
  }

  return (
    <div
      className={cn(
        'mt-1 mb-1 grid gap-5 sm:grid-cols-[1fr_auto] sm:items-center',
        'px-5 py-4 border border-gray-800 border-l-[3px] rounded-lg bg-gray-900',
        isProtect ? 'border-l-green-700' : 'border-l-blue-500',
      )}
    >
      <div>
        <div
          className={cn(
            'font-mono text-[11px] tracking-[0.13em] uppercase mb-2.5',
            isProtect ? 'text-green-400' : 'text-blue-400',
          )}
        >
          From your {shown.source}
        </div>

        <div className="text-sm text-gray-400 mb-2.5">
          {shown.finding} — <b className={cn('font-semibold', isProtect ? 'text-green-400' : 'text-gray-100')}>{shown.metric}</b>.
        </div>

        <div className="flex gap-3 items-baseline">
          <span
            className={cn('text-[13px] font-bold flex-shrink-0', isProtect ? 'text-green-400' : 'text-blue-400')}
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Today
          </span>
          <span
            className="text-[19px] font-bold tracking-[-0.015em] text-gray-100 leading-[1.22] max-w-[42ch]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {shown.today}
          </span>
        </div>
      </div>

      <div className="flex flex-col items-start sm:items-center gap-2">
        {tracked ? (
          <>
            <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-green-400 bg-green-400/[0.08] border border-green-700 rounded px-4 py-2 whitespace-nowrap">
              <span aria-hidden>✓</span> Tracking today
            </div>
            {canTrack && (
              <button
                type="button"
                onClick={untrack}
                className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                Stop tracking
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={track}
            disabled={!canTrack}
            className={cn(
              'text-[13px] font-semibold rounded px-4.5 py-2.5 border transition-colors whitespace-nowrap',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              isProtect
                ? 'text-green-400 bg-green-400/[0.08] border-green-700 hover:bg-green-400/[0.14]'
                : 'text-blue-300 bg-blue-500/[0.08] border-blue-500 hover:bg-blue-500/[0.14]',
            )}
          >
            {isProtect ? 'Protect this today' : 'Track this today'}
          </button>
        )}
        <div className="text-[11px] text-gray-500 text-center">
          {tracked ? 'Resolves at EOD review' : 'Resolves at EOD in your review'}
        </div>
      </div>
    </div>
  )
}
