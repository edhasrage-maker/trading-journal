'use client'

import { cn } from '@/lib/utils'
import type { HeatBaseline as Baseline } from '@/lib/heat-baseline'
import type { RoundTripStats } from '@/lib/trade-excursion'

/**
 * The one line above the trade table that makes the MAE column mean something.
 *
 * The table already prints how far each trade drifted toward its stop (the MAE
 * cell's "0.7× · 78%"). What it never said is whether 78% is good or bad. This
 * says it, from the trader's own history, and then names where today landed.
 *
 * Replaces `MfeMaeEfficiency`, whose avg-MFE-vs-avg-MAE verdict was structurally
 * always-true for anyone using a stop. The round-trip / "gave it back" line was
 * the one specific thing in that panel, so it moves here intact.
 */
export default function HeatBaseline({
  baseline,
  todayHeatPct,
  todayWon,
  roundTrip,
}: {
  baseline: Baseline | null
  /** Today's heat as a % of planned risk — only when the day has exactly one
   *  measurable trade, so the sentence can close on it without averaging. */
  todayHeatPct?: number | null
  todayWon?: boolean
  roundTrip?: RoundTripStats | null
}) {
  const hasGiveBack = !!roundTrip && roundTrip.count > 0
  if (!baseline && !hasGiveBack) return null

  return (
    <div className="mb-4 pl-3 border-l-2 border-blue-900">
      {baseline && (
        <p className="text-[13.5px] text-gray-200 max-w-[80ch] leading-relaxed">
          <span className="font-semibold text-gray-100">Your winners barely test the stop.</span>{' '}
          When a trade’s MAE stayed inside <b className="font-semibold">half</b> your planned risk it won{' '}
          <b className="font-semibold text-green-400">{baseline.insideWinPct}%</b> of the time; past half,{' '}
          <b className="font-semibold text-red-400">{baseline.pastWinPct}%</b>.
          {todayHeatPct != null && (
            <> Today’s went to{' '}
              <b className={cn('font-semibold', todayHeatPct >= 50 ? 'text-yellow-400' : 'text-green-400')}>
                {Math.round(todayHeatPct)}%
              </b>
              {todayWon != null && (todayWon ? ' — and still paid.' : '.')}
            </>
          )}
          <span className="block text-[11.5px] text-gray-500 mt-1">
            From your last {baseline.measuredN} trades with a stop set · {baseline.insideN} inside half,{' '}
            {baseline.pastN} past it, {baseline.stoppedN} stopped out.
          </span>
        </p>
      )}
      {hasGiveBack && (
        <p className={cn('flex items-center gap-1.5 text-[12px] text-yellow-400/90', baseline && 'mt-2')}>
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
