'use client'

import { cn } from '@/lib/utils'
import type { HeatBaseline as Baseline, TodayHeat } from '@/lib/heat-baseline'
import type { RoundTripStats } from '@/lib/trade-excursion'

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
 */
export default function HeatBaseline({
  baseline,
  today,
  roundTrip,
}: {
  baseline: Baseline | null
  today: TodayHeat | null
  roundTrip?: RoundTripStats | null
}) {
  const hasGiveBack = !!roundTrip && roundTrip.count > 0
  // Nothing measurable today → nothing to interpret. A baseline on its own is
  // the exact trivia this component is meant not to be.
  if (!today && !hasGiveBack) return null

  const lead = today ? todaySentence(today) : null
  // Colour the panel's rule by how the session actually went, so the shape of
  // the day is readable before the words are.
  const tone = !today ? 'flat'
    : today.stopped > 0 || today.past > today.inside ? 'warn'
      : today.inside > 0 ? 'good' : 'flat'

  return (
    <div
      className={cn(
        'mt-1 mb-4 px-5 py-4 border border-gray-800 border-l-[3px] rounded-lg bg-gray-900',
        tone === 'good' ? 'border-l-green-700' : tone === 'warn' ? 'border-l-yellow-600' : 'border-l-gray-700',
      )}
    >
      {lead && (
        <p className="text-[14.5px] text-gray-100 leading-relaxed max-w-[74ch]">{lead}</p>
      )}

      {baseline && (
        <p className={cn('text-[13px] text-gray-400 leading-relaxed max-w-[74ch]', lead && 'mt-2')}>
          Your winners barely test the stop: inside half you win{' '}
          <b className="font-semibold text-green-400">{baseline.insideWinPct}%</b> of the time, past half{' '}
          <b className="font-semibold text-red-400">{baseline.pastWinPct}%</b>.
          <span className="text-gray-500">
            {' '}From your last {baseline.measuredN} trades with a stop set.
          </span>
        </p>
      )}

      {hasGiveBack && (
        <p className={cn('flex items-center gap-1.5 text-[12.5px] text-yellow-400/90', (lead || baseline) && 'mt-2.5')}>
          <span aria-hidden>↺</span>
          <span>
            <span className="font-medium">Gave it back</span> · {roundTrip!.count} of {roundTrip!.total} trade
            {roundTrip!.total === 1 ? '' : 's'} were up ≥{roundTrip!.thresholdAtr}×ATR then closed ≤ BE ·{' '}
            <span className="tabular-nums">−${Math.round(roundTrip!.giveBackUsd).toLocaleString()}</span>
          </span>
        </p>
      )}
    </div>
  )
}

/** What the session did, in one sentence, before any history is mentioned. */
function todaySentence(t: TodayHeat): string {
  if (t.measurable === 1) {
    if (t.stopped === 1) return 'Today’s trade ran to your stop.'
    return `Today’s trade went ${Math.round(t.singlePct ?? 0)}% of the way to your stop before it resolved.`
  }

  const parts: string[] = []
  if (t.inside > 0) parts.push(`${t.inside} stayed inside halfway to your stop`)
  if (t.past > 0) parts.push(`${t.past} pushed past halfway`)
  if (t.stopped > 0) parts.push(`${t.stopped} ran to the stop`)

  const trades = `${t.measurable} trade${t.measurable === 1 ? '' : 's'}`
  if (parts.length === 1) return `Today: all ${trades} ${parts[0].replace(/^\d+ /, '')}.`
  const last = parts.pop()!
  return `Today, of ${trades}: ${parts.join(', ')} and ${last}.`
}
