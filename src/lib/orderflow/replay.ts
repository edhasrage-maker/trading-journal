/**
 * Play forward: a Full review snapshot as it stood at a moment after the fill.
 * Nothing here is rebuilt from ticks — it only cuts what Full review already
 * carries. A 1-minute bar shows once its minute has closed, a 40-trade bubble
 * once its 40th trade printed, an exit once it filled. Until the fill's own
 * minute closes, Blind's partial bar stands in for it, so pressing Play starts
 * from exactly the chart Blind showed.
 */
import type { DeepDiveSnapshot } from './server/snapshot'
import type { MinuteBars, VapByMinute } from './minute-bars'
import { bubblesAsOf, type BubbleChart } from './bubbles40t'

/** How many of the ascending values in `a` are <= x. */
export function countUpTo(a: ArrayLike<number>, x: number): number {
  let lo = 0, hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid }
  return lo
}

/** 1-minute bars closed by `at` (PT-clock seconds); every bar once the data has run out. */
export const barsDone = (S: DeepDiveSnapshot, at: number, end: boolean) => (end ? S.bars.t.length : countUpTo(S.bars.t, at - 60))

/** 40-trade bubbles whose last trade had printed by `at`. */
export const bubblesDone = (B: BubbleChart | null, at: number) => (B ? countUpTo(B.t, at) : 0)

const FIELDS = ['t', 'o', 'h', 'l', 'c', 'v', 'bv', 'av', 'd', 'dmin', 'dmax', 'pv', 'vv'] as const

/**
 * The first `n` 1-minute bars of a Full review snapshot (and their
 * volume-at-price), plus Blind's partial fill bar while the fill's minute is
 * still open. Bubbles are cut separately (cutBubbles), at their own pace.
 */
export function cutBars(S: DeepDiveSnapshot, n: number, blindS?: DeepDiveSnapshot | null): DeepDiveSnapshot {
  const bars = Object.fromEntries(FIELDS.map(f => [f, S.bars[f].slice(0, n)])) as unknown as MinuteBars
  const vap: VapByMinute = { m: [], t: [], b: [], a: [] }
  const push = (src: VapByMinute, k: number, m: number) => { vap.m.push(m); vap.t.push(src.t[k]); vap.b.push(src.b[k]); vap.a.push(src.a[k]) }
  for (let k = 0; k < S.vap.m.length; k++) if (S.vap.m[k] < n) push(S.vap, k, S.vap.m[k])

  let partial = false
  if (blindS?.has_partial && blindS.row.date === S.row.date && blindS.times.entry === S.times.entry) {
    const pi = blindS.bars.t.length - 1, pt = blindS.bars.t[pi]
    if (n === 0 || bars.t[n - 1] < pt) {
      for (const f of FIELDS) bars[f].push(blindS.bars[f][pi])
      for (let k = 0; k < blindS.vap.m.length; k++) if (blindS.vap.m[k] === pi) push(blindS.vap, k, n)
      partial = true
    }
  }
  return { ...S, bars, vap, has_partial: partial }
}

/** The bubble chart once its first `n` bubbles had printed (ES floor and large-print rings as of then). */
export const cutBubbles = (B: BubbleChart | null, n: number): BubbleChart | null => (B && n > 0 ? bubblesAsOf(B, n) : null)
