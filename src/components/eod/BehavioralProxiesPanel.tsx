'use client'

import { useMemo } from 'react'
import { Activity } from 'lucide-react'
import { computeBehavioralProxies, type ProxyTrade, type ProxySeverity } from '@/lib/behavioral-proxies'
import type { RoundTripStats } from '@/lib/trade-excursion'

/**
 * Session-behavior readout — tilt/revenge re-entries, shrinking hold time,
 * stacking one direction, and pressing size into a drawdown, all derived from
 * the day's fill sequence (no planned stop or tags needed). Renders a
 * steady-session note when nothing fires, so a clean day gets reinforcement.
 *
 * GIVE-BACKS come from somewhere else, and have to. `ProxyTrade` carries only
 * id / direction / entry_time / exit_time / pnl / quantity, so to that engine a
 * trade that ran 2×ATR in your favour and one that went straight against you
 * are the same event: a loss. It wasn't declining to mention them — it cannot
 * see them. The excursion read (`aggregateRoundTrips`) is computed by the page
 * and passed in, so the panel a trader actually reads for "what did I do wrong
 * today" names the most expensive habit there is instead of leaving it a card
 * away in the heat block.
 */

const TONE: Record<Exclude<ProxySeverity, 'none'>, { dot: string; text: string; bg: string; border: string }> = {
  flag: { dot: 'bg-amber-400', text: 'text-amber-200', bg: 'rgba(224,163,60,0.09)', border: 'rgba(224,163,60,0.32)' },
  mild: { dot: 'bg-gray-400', text: 'text-gray-300', bg: 'rgba(107,114,128,0.10)', border: 'rgba(107,114,128,0.30)' },
}

export default function BehavioralProxiesPanel({
  trades,
  sessionEndedAt,
  roundTrip,
}: {
  trades: ProxyTrade[]
  sessionEndedAt?: string | null
  /** Excursion-derived give-backs for the same trades. Optional: surfaces that
   *  don't compute excursions simply omit the row. */
  roundTrip?: RoundTripStats | null
}) {
  const { tradeCount, hasSignal, proxies } = useMemo(
    () => computeBehavioralProxies(trades, sessionEndedAt),
    [trades, sessionEndedAt],
  )

  // Round-trip ids → 1-indexed session positions, matching how every other row
  // cites its evidence.
  const giveBack = useMemo(() => {
    if (!roundTrip || roundTrip.count === 0) return null
    const seqById = new Map(trades.map((t, i) => [t.id, i + 1]))
    const evidence = roundTrip.ids
      .map(id => seqById.get(id))
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b)
    return { ...roundTrip, evidence }
  }, [roundTrip, trades])

  if (tradeCount < 2) return null

  const signals = proxies.filter(p => p.severity !== 'none')
  // A day that gave winners back is not a steady session, whatever the fill
  // sequence looked like.
  const anySignal = hasSignal || giveBack != null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-3">
        <Activity className="w-3.5 h-3.5" />
        {/* Say which evidence is in play: the give-back row is excursion-derived,
            and claiming the whole panel comes "from your fills" would be a quiet
            lie about where that number came from. */}
        Session behavior · {tradeCount} trade{tradeCount === 1 ? '' : 's'} ·{' '}
        {giveBack ? 'from your fills and what price did' : 'derived from your fills'}
      </div>

      {!anySignal ? (
        <div
          className="rounded-lg px-3 py-2.5 border"
          style={{ background: 'rgba(52,211,153,0.08)', borderColor: 'rgba(52,211,153,0.30)' }}
        >
          <p className="text-[13px] leading-relaxed text-green-200">
            No tilt, stacking, or hold-time drift detected — a steady, patient session.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {giveBack && (
            <div
              className="rounded-lg px-3 py-2 border flex items-start gap-2.5"
              style={{ background: TONE.flag.bg, borderColor: TONE.flag.border }}
            >
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${TONE.flag.dot}`} />
              <div className="min-w-0">
                <div className={`text-[13px] font-medium ${TONE.flag.text}`}>
                  Gave back a winner
                  {giveBack.evidence.length > 0 && (
                    <span className="ml-1.5 font-normal text-gray-500">
                      trade{giveBack.evidence.length === 1 ? '' : 's'} {giveBack.evidence.join(', ')}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-gray-400 leading-snug">
                  {giveBack.count} of {giveBack.measurable} evaluable trade
                  {giveBack.measurable === 1 ? '' : 's'} ran ≥{giveBack.thresholdAtr}×ATR in your favour,
                  then closed at breakeven or worse — handed back $
                  {Math.round(giveBack.giveBackUsd).toLocaleString()} from peak
                </div>
              </div>
            </div>
          )}
          {signals.map(p => {
            const tone = TONE[p.severity as 'flag' | 'mild']
            return (
              <div
                key={p.key}
                className="rounded-lg px-3 py-2 border flex items-start gap-2.5"
                style={{ background: tone.bg, borderColor: tone.border }}
              >
                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} />
                <div className="min-w-0">
                  <div className={`text-[13px] font-medium ${tone.text}`}>
                    {p.label}
                    {p.evidence.length > 0 && (
                      <span className="ml-1.5 font-normal text-gray-500">
                        trade{p.evidence.length === 1 ? '' : 's'} {p.evidence.join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-gray-400 leading-snug">{p.detail}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
