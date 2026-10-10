/**
 * 1-minute delta footprint — port of the reference viewer's renderFootprint()
 * math, with the per-bar stats from the founder's EdhasrageFootprint.cpp.
 *
 *  Cells: delta (ask - bid volume) per row of `g` ticks; the bar's POC row is
 *    the one with the most volume (first in ascending price on a tie).
 *  Diagonal imbalance: ask[p] >= ratio * bid[p - row] (or bid[p] >= ratio *
 *    ask[p + row]) with that side's volume >= minVol. 3+ consecutive rows form
 *    a stacked imbalance.
 *  Stats: range = H - L; VPS = volume / 60 (volume / elapsed seconds on the
 *    partial entry bar); VPS tier 1/2/3 at >= 2x / 3x / 4x the median VPS of
 *    the prior 10 bars (median = sorted[n/2]); delta spike = |delta| >= 2x the
 *    median |delta| of the prior 10 bars.
 */
import type { Bar1m, VapRow } from './bars'

export interface FootprintStats {
  vps: number
  range: number
  d: number
  /** 0 = normal, 1/2/3 = VPS at 2x/3x/4x the prior-10 median. */
  tier: number
  up: boolean
  dSpike: boolean
}

/** Stats for bar i. `entrySec` = the fill's seconds-past-the-minute. */
export function footprintStats(m1: Bar1m[], i: number, entrySec: number): FootprintStats {
  const vpsOf = (b: Bar1m) => b.v / (b.partial ? Math.max(1, entrySec) : 60)
  const b = m1[i], vps = vpsOf(b), d = b.d, pv: number[] = [], pd: number[] = []
  for (let k = 1; k <= 10 && i - k >= 0; k++) { const q = m1[i - k]; pv.push(q.v / 60); pd.push(Math.abs(q.d)) }
  pv.sort((x, y) => x - y); pd.sort((x, y) => x - y)
  const mv = pv.length ? pv[Math.floor(pv.length / 2)] : 0, md = pd.length ? pd[Math.floor(pd.length / 2)] : 0
  const r = mv > 0 ? vps / mv : 0, tier = r >= 4 ? 3 : r >= 3 ? 2 : r >= 2 ? 1 : 0
  return { vps, range: b.h - b.l, d, tier, up: d >= 0, dSpike: md > 0 && Math.abs(d) >= 2 * md }
}

export interface FootprintColumn {
  /** Index into the 1m bars. */
  i: number
  bar: Bar1m
  stats: FootprintStats
  /** Row bottoms (ticks) spanned by the bar's range. */
  klo: number; khi: number
  /** Row bottom (ticks) -> [bid, ask]. */
  cells: Map<number, [number, number]>
  /** Largest |delta| in the bar (>= 1). */
  maxAbsDelta: number
  /** POC row bottom, or null if the bar has no volume rows. */
  poc: number | null
  askImb: Set<number>
  bidImb: Set<number>
  /** Stacked imbalances: rows [kTop - (cnt-1)·g, kTop]. */
  stacked: { side: 'ask' | 'bid'; kTop: number; cnt: number }[]
}

export interface FootprintModel {
  cols: FootprintColumn[]
  g: number
  /** Row bottoms (ticks) of the entry price, the stop and the TP. */
  eK: number; sK: number | null; tK: number | null
  kmin: number; kmax: number
}

export interface FootprintOptions {
  /** Bars to show (the last N). */
  bars: number
  /** Row size in ticks. */
  g: number
  /** Imbalance ratio, e.g. 3 = 300%. */
  ratio: number
  minVol: number
}

const rowOf = (price: number, g: number) => Math.floor(Math.round(price * 4) / g) * g

export function footprintModel(
  m1: Bar1m[], vap: VapRow[][], opts: FootprintOptions,
  entry: { price: number; entrySec: number }, bracket: { stop?: number | null; tp?: number | null } = {},
): FootprintModel {
  const { g, ratio, minVol } = opts
  const N = Math.min(opts.bars, m1.length), first = m1.length - N
  const cols: FootprintColumn[] = []
  for (let i = first; i < m1.length; i++) {
    const b = m1[i], m = new Map<number, [number, number]>()
    vap[i].forEach(([tk, bb, aa]) => { const k = Math.floor(tk / g) * g; const e = m.get(k) || [0, 0]; e[0] += bb; e[1] += aa; m.set(k, e) })
    const klo = rowOf(b.l, g), khi = rowOf(b.h, g)
    const get = (k: number) => m.get(k) || [0, 0]
    let mxd = 1, pk: number | null = null, pvv = -1
    for (let k = klo; k <= khi; k += g) { const [bb, aa] = get(k); mxd = Math.max(mxd, Math.abs(aa - bb)); if (bb + aa > pvv) { pvv = bb + aa; pk = k } }
    const askImb = new Set<number>(), bidImb = new Set<number>()
    for (let k = klo; k <= khi; k += g) {
      const [bb, aa] = get(k)
      if (aa >= minVol && aa >= ratio * get(k - g)[0]) askImb.add(k)
      if (bb >= minVol && bb >= ratio * get(k + g)[1]) bidImb.add(k)
    }
    const stacked: FootprintColumn['stacked'] = []
    const runs = (set: Set<number>, side: 'ask' | 'bid') => {
      let cnt = 0
      for (let k = klo; k <= khi + g; k += g) {
        if (set.has(k)) cnt++
        else { if (cnt >= 3) stacked.push({ side, kTop: k - g, cnt }); cnt = 0 }
      }
    }
    runs(askImb, 'ask'); runs(bidImb, 'bid')
    cols.push({ i, bar: b, stats: footprintStats(m1, i, entry.entrySec), klo, khi, cells: m, maxAbsDelta: mxd, poc: pk, askImb, bidImb, stacked })
  }
  const eK = rowOf(entry.price, g)
  let kmin = eK, kmax = eK
  cols.forEach(c => { kmin = Math.min(kmin, c.klo); kmax = Math.max(kmax, c.khi) })
  const sK = bracket.stop != null ? rowOf(bracket.stop, g) : null
  const tK = bracket.tp != null ? rowOf(bracket.tp, g) : null
  return { cols, g, eK, sK, tK, kmin, kmax }
}
