'use client'

import { cn } from '@/lib/utils'
import type { HeatBaseline as Baseline, TodayHeat } from '@/lib/heat-baseline'

/**
 * The line above the trade table that makes the MAE column mean something.
 *
 * Order matters and was wrong first time round: this led with the lifetime
 * split and never said what happened in the session, so on any day without
 * exactly one measurable trade it was pure history — trivia sitting above a
 * table about today. **Today leads; the baseline is the context underneath it.**
 *
 * It also has a surface now. Rendered flat on the page background it read as
 * filler and got skipped; it uses the same panel treatment as the Prep
 * commitment block, which is the locked precedent for "read this bit".
 *
 * Founder, 2026-10-20: the lifetime split is only worth reading under the
 * day's own line, never on its own ("a broad stat with no applicability to
 * today"), so a day with no trade measurable against its stop shows nothing.
 * The "gave it back" line moved out: the Session behavior panel already says it,
 * with the trade numbers.
 */
export default function HeatBaseline({
  baseline,
  today,
}: {
  baseline: Baseline | null
  today: TodayHeat | null
}) {
  // Nothing measurable today → nothing to interpret. A baseline on its own is
  // the exact trivia this component is meant not to be.
  if (!today) return null

  const lead = todaySentence(today)
  // Colour the panel's rule by how the session actually went, so the shape of
  // the day is readable before the words are.
  const tone = today.stopped > 0 || today.past > today.inside ? 'warn'
    : today.inside > 0 ? 'good' : 'flat'

  return (
    <div
      className={cn(
        'mt-1 mb-4 px-5 py-4 border border-gray-800 border-l-[3px] rounded-lg bg-gray-900',
        tone === 'good' ? 'border-l-green-700' : tone === 'warn' ? 'border-l-yellow-600' : 'border-l-gray-700',
      )}
    >
      <p className="text-[14.5px] text-gray-100 leading-relaxed max-w-[74ch]">{lead}</p>

      {baseline && (
        <p className="text-[13px] text-gray-400 leading-relaxed max-w-[74ch] mt-2">
          {baselineLead(baseline)} inside half you win{' '}
          <b className={`font-semibold ${winCls(baseline.insideWinPct, baseline.pastWinPct)}`}>{baseline.insideWinPct}%</b>{' '}
          of the time <span className="text-gray-500">({baseline.insideN} trades)</span>, past half{' '}
          <b className={`font-semibold ${winCls(baseline.pastWinPct, baseline.insideWinPct)}`}>{baseline.pastWinPct}%</b>{' '}
          <span className="text-gray-500">({baseline.pastN})</span>.
          <span className="text-gray-500">
            {' '}From your last {baseline.measuredN} trades with a stop set.
          </span>
        </p>
      )}
    </div>
  )
}

/** Win rates closer than this read as "about the same" — no claim either way. */
const SAME_PTS = 10

/** The opening clause for the history line. It says which way the trader's
 *  own split leans, and only when it actually leans that way: the line used to
 *  say "your winners barely test the stop" unconditionally, even when the
 *  past-half win rate was the higher one. */
function baselineLead(b: Baseline): string {
  const gap = b.insideWinPct - b.pastWinPct
  if (gap >= SAME_PTS) return 'Your winners barely test the stop:'
  if (gap <= -SAME_PTS) return 'Going past halfway hasn’t cost you so far:'
  return 'Halfway to the stop makes little difference for you:'
}

/** Green for the higher of the two win rates, red for the lower, grey when they're about the same. */
function winCls(self: number, other: number): string {
  if (Math.abs(self - other) < SAME_PTS) return 'text-gray-200'
  return self > other ? 'text-green-400' : 'text-red-400'
}

/** What the session did, in one sentence, before any history is mentioned.
 *  Highlights' "What happened" uses it on its own, without the history line. */
export function todaySentence(t: TodayHeat): string {
  if (t.measurable === 1) {
    if (t.stopped === 1) return 'Today’s trade ran to your stop.'
    return `Today’s trade went ${Math.round(t.singlePct ?? 0)}% of the way to your stop before it resolved.`
  }

  const parts: string[] = []
  if (t.inside > 0) parts.push(`${t.inside} stayed inside halfway to your stop`)
  if (t.past > 0) parts.push(`${t.past} pushed past halfway`)
  if (t.stopped > 0) parts.push(`${t.stopped} ran to the stop`)

  const trades = `${t.measurable} trade${t.measurable === 1 ? '' : 's'}`
  if (parts.length === 1) {
    const all = t.measurable === 2 ? 'both trades' : `all ${trades}`
    return `Today: ${all} ${parts[0].replace(/^\d+ /, '')}.`
  }
  const last = parts.pop()!
  return `Today, of ${trades}: ${parts.join(', ')} and ${last}.`
}
