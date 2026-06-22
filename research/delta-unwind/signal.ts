import { emaSeries } from '../ema-slope/ema'
import type { DeltaBar } from './scid-delta'

/**
 * TypeScript port of DeltaUnwindStars.cpp signal logic.
 *
 * The study flags a bar when intrabar delta thrust got reabsorbed by the close
 * ("unwind"), read as exhaustion → reversal in the OPPOSITE direction:
 *   Long  signal: delta dove hard intrabar (minDelta very negative) but the
 *                 close reabsorbed it.
 *   Short signal: delta spiked hard intrabar (maxDelta very positive) but the
 *                 close gave it back.
 *
 * Defaults mirror the .cpp SetDefaults block. EMA of |minDelta| / |maxDelta| is
 * computed across the full contiguous bar series, matching the study's per-bar
 * sc.ExponentialMovAvg over its AbsMin/AbsMax subgraphs.
 */

export type SignalParams = {
  emaLength: number // EMA Length (bars) — default 30
  minDeltaFloor: number // require minDelta <= -floor — default 100
  maxDeltaFloor: number // require maxDelta >= +floor — default 100
  impulseMult: number // impulse multiple vs EMA — default 0.8
  unwindStrThresh: number // unwind strength threshold — default 1.0
  requireLongCloseGE0: boolean // long: deltaClose >= 0 — default true
  shortCloseMode: 0 | 1 | 2 // 0=close<=0, 1=close<=frac*max, 2=none — default 0
  shortCloseFrac: number // used when shortCloseMode==1 — default 0.10
}

export const DEFAULT_PARAMS: SignalParams = {
  emaLength: 30,
  minDeltaFloor: 100,
  maxDeltaFloor: 100,
  impulseMult: 0.8,
  unwindStrThresh: 1.0,
  requireLongCloseGE0: true,
  shortCloseMode: 0,
  shortCloseFrac: 0.1,
}

export type SignalSide = 'long' | 'short' | null

export type SignalRow = {
  side: SignalSide
  unwindStrLong: number
  unwindStrShort: number
}

/**
 * Precomputed EMA-of-|delta| arrays for a bar series. These depend only on
 * emaLength (and the bars), NOT on the threshold params — so a parameter sweep
 * computes them once and reuses them across every combo.
 */
export type DeltaEnvelope = {
  absMin: number[]
  absMax: number[]
  emaAbsMin: number[]
  emaAbsMax: number[]
}

export function buildEnvelope(bars: DeltaBar[], emaLength: number): DeltaEnvelope {
  const absMin = bars.map(b => Math.abs(b.minDelta))
  const absMax = bars.map(b => Math.abs(b.maxDelta))
  return {
    absMin,
    absMax,
    emaAbsMin: emaSeries(absMin, emaLength),
    emaAbsMax: emaSeries(absMax, emaLength),
  }
}

/**
 * The study's long/short verdict for a single bar, given a precomputed envelope.
 * This is the canonical condition logic — computeSignals and the sweep both call it.
 */
export function signalSideAt(i: number, bars: DeltaBar[], env: DeltaEnvelope, params: SignalParams): SignalSide {
  const b = bars[i]
  const dc = b.deltaClose
  const minD = b.minDelta
  const maxD = b.maxDelta

  const unwindLong = minD < 0 ? dc - minD : 0
  const unwindShort = maxD > 0 ? maxD - dc : 0
  const unwindStrLong = env.absMin[i] > 0 ? unwindLong / env.absMin[i] : 0
  const unwindStrShort = env.absMax[i] > 0 ? unwindShort / env.absMax[i] : 0

  const longCloseOK = params.requireLongCloseGE0 ? dc >= 0 : true
  let shortCloseOK = true
  if (params.shortCloseMode === 0) shortCloseOK = dc <= 0
  else if (params.shortCloseMode === 1) shortCloseOK = dc <= params.shortCloseFrac * maxD

  const longCond =
    minD <= -params.minDeltaFloor &&
    minD <= -(params.impulseMult * env.emaAbsMin[i]) &&
    unwindStrLong >= params.unwindStrThresh &&
    longCloseOK

  const shortCond =
    maxD >= params.maxDeltaFloor &&
    maxD >= params.impulseMult * env.emaAbsMax[i] &&
    unwindStrShort >= params.unwindStrThresh &&
    shortCloseOK

  // If both fire (rare), leave it ambiguous — count under neither side.
  if (longCond && !shortCond) return 'long'
  if (shortCond && !longCond) return 'short'
  return null
}

/**
 * Compute a signal verdict for every bar. Index-aligned with `bars`.
 * (EvaluateOnClose is implicit: we evaluate completed bars only, which is what
 *  a bar array already represents — no mid-bar repaint to model.)
 */
export function computeSignals(bars: DeltaBar[], params: SignalParams = DEFAULT_PARAMS): SignalRow[] {
  const n = bars.length
  const env = buildEnvelope(bars, params.emaLength)
  const out: SignalRow[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const unwindLong = b.minDelta < 0 ? b.deltaClose - b.minDelta : 0
    const unwindShort = b.maxDelta > 0 ? b.maxDelta - b.deltaClose : 0
    out[i] = {
      side: signalSideAt(i, bars, env, params),
      unwindStrLong: env.absMin[i] > 0 ? unwindLong / env.absMin[i] : 0,
      unwindStrShort: env.absMax[i] > 0 ? unwindShort / env.absMax[i] : 0,
    }
  }
  return out
}
