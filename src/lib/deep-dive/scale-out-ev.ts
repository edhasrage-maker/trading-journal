// Deep dive: is SCALING OUT actually +EV? Closes the capture thread. Capture %
// says "you booked 45% of the favorable move" but not whether the fix is holding
// longer — because the alternative to scaling isn't always "hold more", it's
// sometimes "take it ALL at the first target".
//
// Reconstructs three exits from the trader's own fills, on the same trades:
//   A. all out at the first target (no runner at all)
//   B. what they actually did (the real scale-out)
//   C. held every contract to where the last piece came off
// and reports which one the trader's own tape paid best.
//
// Tier 1: raw fills + the scale-out legs, no tags. Bar data (the favorable
// extreme) only ENRICHES one detail line, so a fills-only account still gets the
// full comparison.
//
// PURE + unit-tested. The registry gathers the trades; this only analyzes.

import { symbolToMultiplier } from '@/lib/futures-symbols'
import { groupExitEvents, type ExitFill } from './exit-events'
import { median, shareAbove } from './stats'
import { type DeepDiveResult, type DiveSegment, type Investigation, fmtUsd, fmtPct } from './types'

export interface ScaleOutTrade {
  id: string
  direction: 'long' | 'short' | null
  entryPrice: number | null
  /** Instrument symbol — drives the point multiplier (MNQ $2 vs NQ $20). */
  symbol: string | null
  /** exits_json. Same-timestamp fill fragments are collapsed into events first. */
  fills: ExitFill[] | null
  /** Favorable price extreme during the hold (high for a long, low for a short).
   *  Optional: adds the "how much room was actually beyond your first exit" line. */
  favorableExtreme?: number | null
  /** ATR at entry, points. Optional; normalizes the beyond-target room. */
  atrPts?: number | null
}

/** Minimum genuine scale-outs before the comparison is worth showing. */
const MIN_SCALE_OUTS = 15
/** Below this the three exits are effectively the same plan — nothing notable. */
const MIN_TOTAL_GAP_USD = 250
const MIN_PER_TRADE_GAP_USD = 5

interface Reconstructed {
  actual: number
  allOutTp1: number
  allRide: number
  /** actual − allOutTp1: what the runner earned (or gave back) on this trade. */
  runnerPremium: number
  /** Room the tape offered beyond the first exit price, in ATR (null when unknown). */
  beyondAtr: number | null
}

/** Rebuild the three exit plans for ONE trade from its own fills. Returns null
 *  when the trade isn't a genuine scale-out (single exit event) or is missing
 *  the fields the reconstruction needs. */
function reconstruct(t: ScaleOutTrade): Reconstructed | null {
  if (t.entryPrice == null || t.direction == null) return null
  const events = groupExitEvents(t.fills)
  if (events.length < 2) return null            // one exit order = not a scale-out
  const sign = t.direction === 'long' ? 1 : -1
  const mult = symbolToMultiplier(t.symbol ?? '')
  if (!(mult > 0)) return null
  const favPts = (price: number) => (price - t.entryPrice!) * sign

  const tp1 = events[0].price
  // Scope: "is scaling out +EV" is a question about BOOKING A TARGET and letting
  // the rest ride. A first exit that was already underwater is bailing in
  // pieces, a different behaviour — excluded so it can't muddy the verdict.
  if (!(favPts(tp1) > 0)) return null

  const totalQty = events.reduce((s, e) => s + e.qty, 0)
  if (!(totalQty > 0)) return null

  const actual = events.reduce((s, e) => s + e.qty * favPts(e.price) * mult, 0)
  const allOutTp1 = totalQty * favPts(tp1) * mult
  const allRide = totalQty * favPts(events[events.length - 1].price) * mult

  let beyondAtr: number | null = null
  if (t.favorableExtreme != null && t.atrPts != null && t.atrPts > 0) {
    beyondAtr = Math.max(0, favPts(t.favorableExtreme) - favPts(tp1)) / t.atrPts
  }
  return { actual, allOutTp1, allRide, runnerPremium: actual - allOutTp1, beyondAtr }
}

/**
 * Compare the three exit plans across every genuine scale-out. The verdict is
 * whichever plan the trader's own fills paid best; the falsifiable test is the
 * switch to it, priced in dollars.
 */
export function analyzeScaleOutEv(trades: ScaleOutTrade[]): DeepDiveResult | null {
  const rows = trades.map(reconstruct).filter((r): r is Reconstructed => r !== null)
  if (rows.length < MIN_SCALE_OUTS) return null

  const n = rows.length
  const sum = (f: (r: Reconstructed) => number) => rows.reduce((s, r) => s + f(r), 0)
  const actual = sum(r => r.actual)
  const allOutTp1 = sum(r => r.allOutTp1)
  const allRide = sum(r => r.allRide)

  const premiums = rows.map(r => r.runnerPremium)
  const conversion = shareAbove(premiums)          // share where the runner paid
  const converted = premiums.filter(p => p > 0).length
  const giveBacks = premiums.filter(p => p <= 0)
  const medianGiveBack = giveBacks.length ? median(giveBacks) : 0
  const beyond = rows.map(r => r.beyondAtr).filter((x): x is number => x != null)
  const medianBeyondAtr = beyond.length >= Math.max(8, Math.floor(n / 3)) ? median(beyond) : null

  // Which plan won, and by how much over what they did?
  const tp1Gain = allOutTp1 - actual
  const rideGain = allRide - actual
  const bestGain = Math.max(tp1Gain, rideGain)
  const perTradeGain = bestGain / n
  // All three plans within noise of each other → the exit isn't the leak.
  if (bestGain < MIN_TOTAL_GAP_USD && Math.abs(perTradeGain) < MIN_PER_TRADE_GAP_USD) return null

  const segments: DiveSegment[] = [
    { label: 'All out at your first target', value: Math.round(allOutTp1), n, pnl: Math.round(allOutTp1), extra: { perTrade: Math.round(allOutTp1 / n) } },
    { label: 'What you did (scaled out)', value: Math.round(actual), n, pnl: Math.round(actual), extra: { perTrade: Math.round(actual / n) } },
    { label: 'Held it all to your last exit', value: Math.round(allRide), n, pnl: Math.round(allRide), extra: { perTrade: Math.round(allRide / n) } },
  ]

  const detail: string[] = [
    `Across ${n} genuine scale-outs your fills booked ${fmtUsd(actual)} (${fmtUsd(actual / n)}/trade).`,
    `The same trades with the FULL size off at your first target: ${fmtUsd(allOutTp1)} (${fmtUsd(allOutTp1 / n)}/trade).`,
    `Holding every contract to where you took the last piece off: ${fmtUsd(allRide)} (${fmtUsd(allRide / n)}/trade).`,
    `The runner paid on ${converted} of ${n} (${fmtPct(conversion * 100)}); the ${giveBacks.length} that didn't gave back a median of ${fmtUsd(medianGiveBack)}.`,
  ]
  if (medianBeyondAtr != null) {
    // Availability, NOT conversion: this is room the tape offered at some point
    // during the hold. Plenty of room + a low conversion rate means the runner's
    // problem is TIMING, not opportunity — worth saying out loud so the reader
    // doesn't take "there was room" as "hold longer".
    detail.push(
      medianBeyondAtr < 0.25
        ? `Beyond your first exit price the tape only offered a median of ${medianBeyondAtr.toFixed(2)}×ATR more — your first target is sitting near the exhaustion point.`
        : `The room was there — a median of ${medianBeyondAtr.toFixed(2)}×ATR beyond your first exit price — so the runner's problem is when you take it off, not whether the move continues.`,
    )
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  // Scaling is -EV and taking it all at TP1 wins.
  if (tp1Gain >= rideGain && tp1Gain > 0) {
    const severity = Math.min(1, Math.min(1, tp1Gain / 2500) * 0.6 + (1 - conversion) * 0.4)
    return {
      id: 'scale-out-ev',
      title: 'Is scaling out paying you?',
      headline: `Taking the full size at your first target would have made ${fmtUsd(tp1Gain)} more than scaling out across ${n} trades.`,
      severity,
      segments,
      detail,
      reframe: `Your first target isn't an early exit — it's roughly where the move dies. Leaving a runner on past it is a bet you lose ${fmtPct((1 - conversion) * 100)} of the time, and it's funded by gains you already had in hand.`,
      test: {
        rule: 'Take the full position off at your first target',
        impactUsd: tp1Gain,
        basis: `gross P&L rebuilt from your own fills — every contract exited at your first exit price instead of scaling, over the same ${n} trades. Commissions excluded, and it gives up the stop-to-breakeven protection a partial normally buys.`,
      },
    }
  }

  // Holding the whole position wins — the partials are the leak.
  if (rideGain > 0) {
    const severity = Math.min(1, Math.min(1, rideGain / 2500) * 0.6 + conversion * 0.4)
    return {
      id: 'scale-out-ev',
      title: 'Is scaling out paying you?',
      headline: `Your runners DO convert — holding the full position to your last exit would have added ${fmtUsd(rideGain)} across ${n} trades.`,
      severity,
      segments,
      detail,
      reframe: `The partials aren't protecting you, they're taxing your best trades: the runner paid on ${fmtPct(conversion * 100)} of these, so the contracts you took off early are the ones that cost you.`,
      test: {
        rule: 'Stop scaling — hold the whole position to where you take the last piece off',
        impactUsd: rideGain,
        basis: `gross P&L rebuilt from your own fills, taking your LAST exit time as given, over the same ${n} trades. Commissions excluded; it also carries full size through the drawdown a partial would have de-risked.`,
      },
    }
  }

  // What they're already doing beats both alternatives — say so, quietly.
  return {
    id: 'scale-out-ev',
    title: 'Is scaling out paying you?',
    headline: `Your scale-out is the best of the three exits: ${fmtUsd(actual)} vs ${fmtUsd(allOutTp1)} all-out-at-target and ${fmtUsd(allRide)} holding it all.`,
    severity: 0.08,   // a confirmation, not a leak — never lead the opener with it
    segments,
    detail,
    reframe: `Scaling is earning its keep here, so low capture % on these trades is a measurement artifact of the runner, not a leak to fix.`,
  }
}

export const scaleOutEvInvestigation: Investigation<ScaleOutTrade[]> = {
  id: 'scale-out-ev',
  title: 'Is scaling out paying you?',
  // 'legs' because the whole dive is the scale-out reconstruction; 'bars' is NOT
  // required — the favorable-extreme line degrades away without it.
  requires: ['fills', 'legs'],
  keywords: ['scale out', 'scaling', 'partials', 'runner', 'tp1', 'first target', 'take profit', 'let it run', 'trim'],
  run: analyzeScaleOutEv,
}
