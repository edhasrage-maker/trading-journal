/**
 * Client-side bar model for the Deep Dive workspace: the payload's columnar
 * 1-minute bars + volume-at-price turned into per-bar records, then aggregated
 * to the chart timeframe. Ports the reference viewer's prep() / aggregateFrom()
 * / buildAgg() (Heiken-Ashi, per-bar POC, session separators).
 */
import type { MinuteBars, VapByMinute } from './minute-bars'

export interface Bar1m {
  /** PT-clock epoch seconds. */
  t: number
  o: number; h: number; l: number; c: number
  v: number; bv: number; av: number
  d: number; dmin: number; dmax: number
  pv: number; vv: number
  /** The entry minute, cut at the fill. */
  partial: boolean
}

/** [priceTicks, bidVol, askVol] */
export type VapRow = [number, number, number]

export function toBars1m(b: MinuteBars, hasPartial: boolean): Bar1m[] {
  const n = b.t.length
  return b.t.map((t, i) => ({
    t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i],
    v: b.v[i] || 0, bv: b.bv[i] || 0, av: b.av[i] || 0,
    d: b.d[i] || 0, dmin: b.dmin[i] ?? 0, dmax: b.dmax[i] ?? 0,
    pv: b.pv[i] || 0, vv: b.vv[i] || 0,
    partial: hasPartial && i === n - 1,
  }))
}

/** Volume-at-price grouped per bar, rows in ascending price. */
export function vapPerBar(vap: VapByMinute, nBars: number): VapRow[][] {
  const out: VapRow[][] = Array.from({ length: nBars }, () => [])
  for (let k = 0; k < vap.m.length; k++) out[vap.m[k]].push([vap.t[k], vap.b[k], vap.a[k]])
  return out
}

const tod = (t: number) => { const d = new Date(t * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes() }

export type SessionMark = 'rth' | 'close' | 'eth' | null

export interface AggBar {
  t: number
  o: number; h: number; l: number; c: number
  v: number; bv: number; av: number
  d: number; dmin: number; dmax: number
  pv: number; vv: number
  /** Indices of the 1-minute bars inside. */
  mins: number[]
  partial: boolean
  /** Heiken-Ashi open / close / high / low. */
  ho: number; hc: number; hh: number; hl: number
  /** Price with the most volume inside the bar (first in ascending price on a tie). */
  poc: number | null
  /** Session separator drawn before this bar. */
  mark: SessionMark
}

/** Aggregate 1-minute bars to a `tf`-minute timeframe (viewer aggregateFrom). */
export function aggregateFrom(src: Bar1m[], tf: number) {
  type Cur = Omit<AggBar, 'ho' | 'hc' | 'hh' | 'hl' | 'poc' | 'mark'>
  const out: Cur[] = []
  let cur: Cur | null = null
  src.forEach((b, i) => {
    const bt = Math.floor(b.t / (tf * 60)) * tf * 60
    if (!cur || cur.t !== bt) {
      cur = { t: bt, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, bv: 0, av: 0, d: 0, dmin: Infinity, dmax: -Infinity, pv: 0, vv: 0, mins: [], partial: false }
      out.push(cur)
    }
    cur.dmin = Math.min(cur.dmin, cur.d + b.dmin); cur.dmax = Math.max(cur.dmax, cur.d + b.dmax)
    cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c
    cur.v += b.v; cur.bv += b.bv; cur.av += b.av; cur.d += b.d; cur.pv += b.pv; cur.vv += b.vv
    cur.mins.push(i); if (b.partial) cur.partial = true
  })
  return out
}

/** Timeframe bars with Heiken-Ashi, per-bar POC and session separators (viewer buildAgg). */
export function buildAgg(m1: Bar1m[], vap: VapRow[][], tf: number): AggBar[] {
  const agg = aggregateFrom(m1, tf) as AggBar[]
  let ho = 0, hc = 0
  agg.forEach((b, k) => {
    const c = (b.o + b.h + b.l + b.c) / 4, o = k === 0 ? (b.o + b.c) / 2 : (ho + hc) / 2
    b.ho = o; b.hc = c; b.hh = Math.max(b.h, o, c); b.hl = Math.min(b.l, o, c); ho = o; hc = c
  })
  agg.forEach(b => {
    const m = new Map<number, number>()
    b.mins.forEach(i => vap[i].forEach(([tk, bb, aa]) => m.set(tk, (m.get(tk) || 0) + bb + aa)))
    let best = -1, bt: number | null = null
    m.forEach((v, tk) => { if (v > best) { best = v; bt = tk } })
    b.poc = bt != null ? bt / 4 : null
  })
  agg.forEach((b, k) => {
    b.mark = null; if (k === 0) return
    const p = agg[k - 1], tp = tod(p.t), tc = tod(b.t)
    const dayChange = Math.floor(b.t / 86400) !== Math.floor(p.t / 86400)
    if ((tp < 390 || dayChange) && tc >= 390 && tc < 780) b.mark = 'rth'
    else if ((tp < 780 && !dayChange) && tc >= 780 && tc < 900) b.mark = 'close'
    else if (b.t - p.t > 3600 * 1.5 || (tp < 900 && tc >= 900 && !dayChange)) b.mark = 'eth'
  })
  return agg
}

/** True range series: first bar's own range, then vs the previous close. */
function trueRanges(arr: { h: number; l: number; c: number }[]): number[] {
  return arr.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h, arr[i - 1].c) - Math.min(b.l, arr[i - 1].c)))
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

/**
 * Simple-mean ATR14 on completed 1m bars and on completed 5m bars before the
 * entry's 5m bucket (viewer prep(); shown in the levels header). The partial
 * entry bar is excluded from both.
 */
export function atr1m5m(m1: Bar1m[], entryPtSec: number): { atr1: number | null; atr5: number | null } {
  const comp = m1.filter(b => !b.partial)
  const atr1 = mean(trueRanges(comp).slice(-14))
  const entry5 = Math.floor(entryPtSec / 300)
  const b5 = aggregateFrom(comp, 5).filter(b => Math.floor(b.t / 300) < entry5)
  const atr5 = mean(trueRanges(b5).slice(-14))
  return { atr1, atr5 }
}
