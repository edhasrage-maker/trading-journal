// Deep dive: STOPPED, THEN REVERSED. Of the trades that got taken out at their
// worst point, how many turned around and went where the trader thought — and
// would a stop a fraction of an ATR wider have flipped them?
//
// Tier 1: raw fills + our own market-data enrichments (excursion extremes, ATR at
// entry, and the post-exit PATH). No tags, no trader input.
//
// Two measurement notes, both forced by real data:
//
// 1. STOP-OUTS ARE INFERRED, not read off stop_price. On the prod DB only 136 of
//    7857 trades carry a stop_price, so requiring it would shrink this dive to
//    nothing. A loss that exited essentially AT its own adverse extreme is the
//    signature of a stop being hit — that's the proxy, with stop_price used as a
//    confirmation when it happens to be there.
//
// 2. THE COUNTERFACTUAL NEEDS PATH ORDER, not window extremes. The first cut of
//    this dive read trades.post_exit_favorable_pts / post_exit_against_pts, which
//    are two INDEPENDENT maxima over the same 30-minute window. "Would a stop
//    2.5 pts wider have survived?" can't be answered from those: over 30 minutes
//    price almost always travels 2.5 pts past the exit at SOME point, so every
//    widening scored as "stopped anyway" (11 of 12 on live data) no matter how
//    the trade actually resolved. The input here is therefore path-ordered — the
//    worst adverse excursion BEFORE the snap-back level was reached — which is
//    what scripts/dive-stop-reversal-ticks.ts measures off the SCID tick stream.
//
// PURE + unit-tested. The caller measures; this only analyzes.

import { symbolToMultiplier } from '@/lib/futures-symbols'
import { median } from './stats'
import { type DeepDiveResult, type DiveSegment, type Investigation, fmtUsd, fmtPct } from './types'

/** Path-ordered post-exit measurement for one trade. All distances are POINTS
 *  beyond the exit price, direction-relative to the trade. */
export interface PostExitPath {
  /** Did price trade back through the ENTRY price within the horizon? */
  reachedEntry: boolean
  /** Worst adverse excursion beyond the exit BEFORE entry was reached. Null when
   *  it never was (nothing to measure "before"). */
  adverseBeforeEntryPts: number | null
  /** Did price reach a full 1R past entry (entry + realized risk) in the horizon? */
  reachedTarget: boolean
  /** Worst adverse excursion beyond the exit BEFORE that target was reached. */
  adverseBeforeTargetPts: number | null
  /** Worst adverse excursion beyond the exit over the WHOLE horizon — decides
   *  whether an un-recovered trade would have been stopped again or just sat. */
  maxAdversePts: number
  /** Best favorable excursion beyond the exit over the whole horizon. Copy only. */
  maxFavorablePts: number
  /** Minutes measured after the exit. */
  horizonMin: number
}

export interface StopReversalTrade {
  id: string
  direction: 'long' | 'short' | null
  entryPrice: number | null
  exitPrice: number | null
  quantity: number | null
  pnl: number | null
  symbol: string | null
  /** Excursion extremes during the hold (tick-true after the Pt 11 backfill). */
  highDuringPosition: number | null
  lowDuringPosition: number | null
  /** ATR at entry, points — the unit every widening is expressed in. */
  atrPts: number | null
  /** Path-ordered post-exit measurement. Null ⇒ the trade can't be modelled. */
  path: PostExitPath | null
  /** Planned stop when the trader logged one; confirms the stop-out. */
  stopPrice?: number | null
}

/** Stop widenings modelled, in ATR. Kept coarse on purpose — this proposes a
 *  direction to test, not a fitted optimum. */
const WIDTHS_ATR = [0.15, 0.3, 0.5] as const
/** Exited within this fraction of its own worst point ⇒ read as a stop-out. */
const STOP_PROXIMITY_FRAC = 0.2
/** Ignore micro-losses (fat fingers, scratches) — they aren't stop placement. */
const MIN_RISK_ATR = 0.25
/** Minimum inferred stop-outs before the model is worth showing. */
const MIN_STOP_OUTS = 12

interface StopOut {
  /** Distance entry → exit, points (always positive). The realized 1R. */
  riskPts: number
  atrPts: number
  pnl: number
  /** $ per point for the whole position (multiplier × contracts). */
  dpp: number
  path: PostExitPath
}

/** Reduce a trade to the stop-out facts, or null if it isn't an inferred
 *  stop-out (or is missing what the model needs). */
function toStopOut(t: StopReversalTrade): StopOut | null {
  if (t.pnl == null || t.pnl >= 0) return null
  if (t.direction == null || t.entryPrice == null || t.exitPrice == null) return null
  if (t.quantity == null || !(t.quantity > 0)) return null
  if (t.atrPts == null || !(t.atrPts > 0)) return null
  if (!t.path) return null

  const sign = t.direction === 'long' ? 1 : -1
  const riskPts = (t.entryPrice - t.exitPrice) * sign
  if (!(riskPts > 0)) return null                       // exited in profit-ish; not a stop
  if (riskPts < MIN_RISK_ATR * t.atrPts) return null    // noise-sized loss

  const adverseExtreme = t.direction === 'long' ? t.lowDuringPosition : t.highDuringPosition
  let stopped = false
  if (adverseExtreme != null) {
    const adverseRunPts = (t.entryPrice - adverseExtreme) * sign
    // Exited essentially at the worst tick of the trade ⇒ a stop was hit, not a
    // discretionary bail (a manual exit leaves room between exit and extreme).
    if (adverseRunPts > 0 && adverseRunPts - riskPts <= STOP_PROXIMITY_FRAC * adverseRunPts) stopped = true
  }
  if (!stopped && t.stopPrice != null) {
    stopped = Math.abs(t.exitPrice - t.stopPrice) <= 0.1 * riskPts
  }
  if (!stopped) return null

  const mult = symbolToMultiplier(t.symbol ?? '')
  if (!(mult > 0)) return null
  return { riskPts, atrPts: t.atrPts, pnl: t.pnl, dpp: mult * t.quantity, path: t.path }
}

interface WidthModel {
  atrFrac: number
  /** Median widening in points across the set — for a human-readable label. */
  medianPts: number
  /** Modelled change in total P&L from widening every stop by this much. */
  deltaUsd: number
  stillStopped: number
  toTarget: number
  toBreakeven: number
  unresolved: number
}

/**
 * Model one widening across every stop-out. Each trade lands in exactly one of
 * four buckets, decided by the ORDERED path:
 *   toTarget     — reached 1R past entry, and the adverse excursion BEFORE that
 *                  never touched the wider stop: scored as a +1R win.
 *   toBreakeven  — same, but only got back to entry: scored flat.
 *   stillStopped — the wider stop was reached at some point: loss deepens by the
 *                  extra width.
 *   unresolved   — never recovered, never reached the wider stop either. Scored as
 *                  the DEEPER loss, because there's no evidence it ever got out.
 */
function modelWidth(atrFrac: number, outs: StopOut[]): WidthModel {
  let deltaUsd = 0, stillStopped = 0, toTarget = 0, toBreakeven = 0, unresolved = 0
  const widenings: number[] = []
  for (const o of outs) {
    const wPts = atrFrac * o.atrPts
    widenings.push(wPts)
    const p = o.path
    if (p.reachedTarget && p.adverseBeforeTargetPts != null && p.adverseBeforeTargetPts < wPts) {
      toTarget++; deltaUsd += o.riskPts * o.dpp - o.pnl; continue
    }
    if (p.reachedEntry && p.adverseBeforeEntryPts != null && p.adverseBeforeEntryPts < wPts) {
      toBreakeven++; deltaUsd += -o.pnl; continue
    }
    if (p.maxAdversePts >= wPts) stillStopped++; else unresolved++
    deltaUsd += -wPts * o.dpp
  }
  return { atrFrac, medianPts: median(widenings), deltaUsd, stillStopped, toTarget, toBreakeven, unresolved }
}

/**
 * Quantify the "the market tagged me and left" pattern and price the widening
 * that would have flipped it. Returns null when there aren't enough inferred
 * stop-outs to model.
 */
export function analyzeStoppedReversal(trades: StopReversalTrade[]): DeepDiveResult | null {
  const outs = trades.map(toStopOut).filter((o): o is StopOut => o !== null)
  if (outs.length < MIN_STOP_OUTS) return null

  const n = outs.length
  const horizonMin = median(outs.map(o => o.path.horizonMin))
  const backToEntry = outs.filter(o => o.path.reachedEntry).length
  const ranFull1R = outs.filter(o => o.path.reachedTarget).length
  const reversalRate = backToEntry / n
  const medAdverseAtr = median(outs.map(o => o.path.maxAdversePts / o.atrPts))
  const medFavAtr = median(outs.map(o => o.path.maxFavorablePts / o.atrPts))
  const totalLoss = outs.reduce((s, o) => s + o.pnl, 0)

  const models = WIDTHS_ATR.map(f => modelWidth(f, outs))
  const best = models.reduce((a, b) => (b.deltaUsd > a.deltaUsd ? b : a))

  const segments: DiveSegment[] = [
    { label: 'Your stops as placed', value: 0, n, pnl: Math.round(totalLoss) },
    ...models.map(m => ({
      label: `+${m.atrFrac.toFixed(2)}×ATR (≈${m.medianPts.toFixed(1)} pts)`,
      value: Math.round(m.deltaUsd),
      n,
      extra: { toTarget: m.toTarget, breakeven: m.toBreakeven, stoppedAnyway: m.stillStopped, unresolved: m.unresolved },
    })),
  ]

  const detail = [
    `${n} of your losses exited at (or within a hair of) their own worst tick — the signature of a stop being hit.`,
    `Within ${Math.round(horizonMin)} minutes of that stop, ${backToEntry} of them (${fmtPct(reversalRate * 100)}) traded back through your entry and ${ranFull1R} (${fmtPct((ranFull1R / n) * 100)}) ran a full 1R past it.`,
    `Median worst-case continuation past your exit was ${medAdverseAtr.toFixed(2)}×ATR, against a median snap-back of ${medFavAtr.toFixed(2)}×ATR.`,
    `Those ${n} stop-outs cost ${fmtUsd(totalLoss)} as they stand.`,
  ]

  if (best.deltaUsd <= 0) {
    return {
      id: 'stopped-reversal',
      title: 'Stopped, then reversed',
      headline: `Your stops are placed about right — widening them 0.15–0.5×ATR models ${fmtUsd(best.deltaUsd)}, i.e. worse.`,
      severity: 0.08,
      segments,
      detail: [...detail, `Every widening modelled loses money: the trades that come back don't come back before a wider stop would have been hit too, so the extra room just pays more for the same losers.`],
      reframe: `Getting stopped and watching it reverse FEELS like the leak, but your own tape says it isn't one — the fix, if there is one, is at the entry, not the stop.`,
    }
  }

  return {
    id: 'stopped-reversal',
    title: 'Stopped, then reversed',
    headline: `${fmtPct(reversalRate * 100)} of your stop-outs reversed back through your entry within ${Math.round(horizonMin)} minutes — a ${best.atrFrac.toFixed(2)}×ATR wider stop models ${fmtUsd(best.deltaUsd)}.`,
    severity: Math.min(1, Math.min(1, best.deltaUsd / 2500) * 0.6 + reversalRate * 0.4),
    segments,
    detail,
    reframe: medAdverseAtr < 0.3
      ? `Your stop is sitting inside the noise band: price only pushes ${medAdverseAtr.toFixed(2)}×ATR past your exit before turning, so you're not being proven wrong — you're being brushed out on the way to being right.`
      : `Widening pays here not because your read is right more often, but because the ${best.toTarget + best.toBreakeven} trades that recover more than cover the ${best.stillStopped} that go on to lose more.`,
    test: {
      rule: `Place stops ${best.atrFrac.toFixed(2)}×ATR (≈${best.medianPts.toFixed(1)} pts) beyond where you'd put them now`,
      impactUsd: best.deltaUsd,
      basis: `re-scored each of the ${n} inferred stop-outs against the ordered post-exit path: ${best.toTarget} reached +1R before the wider stop, ${best.toBreakeven} got back to entry, ${best.stillStopped} were stopped anyway (deeper loss), ${best.unresolved} never resolved in the ${Math.round(horizonMin)}-min window and were also scored as the deeper loss. Gross of commissions.`,
    },
  }
}

export const stoppedReversalInvestigation: Investigation<StopReversalTrade[]> = {
  id: 'stopped-reversal',
  title: 'Stopped, then reversed',
  requires: ['fills', 'bars'],
  keywords: ['stopped out', 'stop loss', 'stop placement', 'stop hunt', 'reversed', 'shaken out', 'wider stop', 'tight stop'],
  run: analyzeStoppedReversal,
}
