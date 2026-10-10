/**
 * The planned bracket at entry: the trade's recorded stop / TP1 when they're
 * valid for its direction, otherwise assumed from the trader's own rubric
 * (resolveRubric): stop = atrStopTarget × ATR, TP = tp1RMultiple × that stop
 * distance. For the owner that's 1 ATR and 2R — the reference's
 * "1 ATR stop / 2 ATR TP".
 *
 * Placement is decided at entry, so it is blind-safe and stays visible in
 * blind mode. Assumed prices snap to the 0.25 grid (ties to even, as the
 * reference's Python round() does).
 */
import { pyRound, rint } from './pymath'

export type BracketSource = 'recorded' | 'assumed'

export interface PlannedBracket {
  atr: number | null
  atr_src: string
  stop: number | null
  stop_src: BracketSource
  tp: number | null
  tp_src: BracketSource
  /** Rubric multiples used for the assumed legs (for labels). */
  atr_stop_mult: number
  tp_r_mult: number
}

export interface BracketInputs {
  entryPrice: number
  direction: 'long' | 'short'
  recordedStop?: number | null
  recordedTp?: number | null
  /** The trade's entry_atr_1m. */
  entryAtr?: number | null
  /** ATR14 on completed 1m bars, used when entryAtr is missing. */
  atrFallback: number | null
  atrStopTarget: number
  tp1RMultiple: number
}

const finite = (x: number | null | undefined): x is number => x != null && Number.isFinite(x)

export function plannedBracket(x: BracketInputs): PlannedBracket {
  const px = x.entryPrice, sd = x.direction === 'long' ? 1 : -1
  let atr: number | null = x.entryAtr ?? null
  let atrSrc = 'entry ATR (1m)'
  if (!finite(atr) || atr <= 0) { atr = x.atrFallback; atrSrc = '1m ATR14 from bars' }
  const st = x.recordedStop, tp = x.recordedTp
  const stOk = finite(st) && (st - px) * sd < 0
  const tpOk = finite(tp) && (tp - px) * sd > 0
  const rnd = (v: number) => pyRound(rint(v * 4) / 4, 2)
  const stopDist = atr ? x.atrStopTarget * atr : null
  return {
    atr: atr ? pyRound(atr, 2) : null,
    atr_src: atrSrc,
    stop: stOk ? st : stopDist != null ? rnd(px - sd * stopDist) : null,
    stop_src: stOk ? 'recorded' : 'assumed',
    tp: tpOk ? tp : stopDist != null ? rnd(px + sd * (x.tp1RMultiple * stopDist)) : null,
    tp_src: tpOk ? 'recorded' : 'assumed',
    atr_stop_mult: x.atrStopTarget,
    tp_r_mult: x.tp1RMultiple,
  }
}

/**
 * The reference's ATR fallback: mean true range of the last 14 completed 1m
 * bars (15 bars → 14 ranges against the previous close).
 */
export function atrFallback14(h: number[], l: number[], c: number[]): number | null {
  const n = h.length, s = Math.max(0, n - 15)
  const tr: number[] = []
  for (let i = s + 1; i < n; i++) tr.push(Math.max(h[i], c[i - 1]) - Math.min(l[i], c[i - 1]))
  return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null
}
