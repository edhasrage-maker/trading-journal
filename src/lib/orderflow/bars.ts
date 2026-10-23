/**
 * Client-side bar model for the Deep Dive workspace: the payload's columnar
 * 1-minute bars + volume-at-price turned into per-bar records, then aggregated
 * to the chart timeframe. Ports the reference viewer's prep() / aggregateFrom()
 * / buildAgg() (Heiken-Ashi, per-bar POC, session separators).
 */
import type { MinuteBars, VapByMinute } from './minute-bars'
import type { SubBars } from './sub-minute'

export interface Bar1m {
  /** PT-clock epoch seconds. */
  t: number
  o: number; h: number; l: number; c: number
  v: number; bv: number; av: number
  d: number; dmin: number; dmax: number
  pv: number; vv: number
  /** The entry minute, cut at the fill. */
  partial: boolean
  /**
   * Seconds a still-forming bar covers (the 5m footprint's last column in
   * Blind or a replay). Unset: the bar's full length, or on the partial 1m bar
   * the seconds before the fill.
   */
  secs?: number
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

/** 30-minute history bars (payload `htf`) as bar records, so they aggregate like any others. */
export function htfToBars(h: { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; bv: number[]; av: number[] }): Bar1m[] {
  return h.t.map((t, i) => {
    const d = h.av[i] - h.bv[i]
    return { t, o: h.o[i], h: h.h[i], l: h.l[i], c: h.c[i], v: h.v[i], bv: h.bv[i], av: h.av[i], d, dmin: Math.min(0, d), dmax: Math.max(0, d), pv: 0, vv: h.v[i], partial: false }
  })
}

/**
 * Bucket offset (seconds) that starts 4-hour bars at the 15:00 PT session open
 * — 15, 19, 23, 03, 07, 11 — the way Sierra and exchange-session charts draw
 * them, rather than at midnight.
 */
export const SESSION_4H_OFFSET = 3 * 3600

/**
 * Aggregate bars to a `tf`-minute timeframe (viewer aggregateFrom). Buckets
 * start at multiples of the timeframe shifted by `offsetSec`.
 */
export function aggregateFrom(src: Bar1m[], tf: number, offsetSec = 0) {
  type Cur = Omit<AggBar, 'ho' | 'hc' | 'hh' | 'hl' | 'poc' | 'mark'>
  const out: Cur[] = []
  let cur: Cur | null = null
  src.forEach((b, i) => {
    const bt = Math.floor((b.t - offsetSec) / (tf * 60)) * tf * 60 + offsetSec
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

function heikenAshi(agg: AggBar[]) {
  let ho = 0, hc = 0
  agg.forEach((b, k) => {
    const c = (b.o + b.h + b.l + b.c) / 4, o = k === 0 ? (b.o + b.c) / 2 : (ho + hc) / 2
    b.ho = o; b.hc = c; b.hh = Math.max(b.h, o, c); b.hl = Math.min(b.l, o, c); ho = o; hc = c
  })
}

function sessionMarks(agg: AggBar[]) {
  agg.forEach((b, k) => {
    b.mark = null; if (k === 0) return
    const p = agg[k - 1], tp = tod(p.t), tc = tod(b.t)
    const dayChange = Math.floor(b.t / 86400) !== Math.floor(p.t / 86400)
    if ((tp < 390 || dayChange) && tc >= 390 && tc < 780) b.mark = 'rth'
    else if ((tp < 780 && !dayChange) && tc >= 780 && tc < 900) b.mark = 'close'
    else if (b.t - p.t > 3600 * 1.5 || (tp < 900 && tc >= 900 && !dayChange)) b.mark = 'eth'
  })
}

/** Timeframe bars with Heiken-Ashi, per-bar POC and session separators (viewer buildAgg). */
export function buildAgg(m1: Bar1m[], vap: VapRow[][], tf: number, offsetSec = 0): AggBar[] {
  const agg = aggregateFrom(m1, tf, offsetSec) as AggBar[]
  heikenAshi(agg)
  agg.forEach(b => {
    const m = new Map<number, number>()
    b.mins.forEach(i => (vap[i] ?? []).forEach(([tk, bb, aa]) => m.set(tk, (m.get(tk) || 0) + bb + aa)))
    let best = -1, bt: number | null = null
    m.forEach((v, tk) => { if (v > best) { best = v; bt = tk } })
    b.poc = bt != null ? bt / 4 : null
  })
  sessionMarks(agg)
  return agg
}

/**
 * 15s / 30s bars (payload `sub`) as chart bars: Heiken-Ashi, the server's bar
 * POC and session separators. `mins` holds the 1m bar each one falls in (empty
 * when that minute isn't in `m1`), so minute-based reads can find it.
 */
export function subToAgg(sb: SubBars, m1: Bar1m[]): AggBar[] {
  let j = 0
  const n = sb.t.length
  const agg: AggBar[] = sb.t.map((t, i) => {
    while (j + 1 < m1.length && m1[j + 1].t <= t) j++
    const inMin = m1.length > 0 && m1[j].t <= t && t < m1[j].t + 60
    return {
      t, o: sb.o[i], h: sb.h[i], l: sb.l[i], c: sb.c[i], v: sb.v[i], bv: sb.bv[i], av: sb.av[i],
      d: sb.d[i], dmin: sb.dmin[i], dmax: sb.dmax[i], pv: 0, vv: sb.v[i],
      mins: inMin ? [j] : [], partial: sb.partial && i === n - 1,
      ho: 0, hc: 0, hh: 0, hl: 0, poc: sb.poc[i], mark: null,
    }
  })
  heikenAshi(agg)
  sessionMarks(agg)
  return agg
}

/**
 * Footprint columns at `tf` minutes: the 1m bars and their volume-at-price
 * added up (rows in ascending price). tf = 1 hands the 1m bars back as they are.
 *
 * `live` (Blind, or a replay that hasn't reached the end): the last column is
 * still forming, so it records the seconds it covers — up to the fill on the
 * partial minute (`entrySec` past it), else to the end of its last minute.
 */
export function footprintBars(m1: Bar1m[], vap: VapRow[][], tf: number, live?: { entrySec: number }): { bars: Bar1m[]; vap: VapRow[][] } {
  if (tf === 1) return { bars: m1, vap }
  const agg = aggregateFrom(m1, tf)
  const bars: Bar1m[] = agg.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, bv: b.bv, av: b.av, d: b.d, dmin: b.dmin, dmax: b.dmax, pv: b.pv, vv: b.vv, partial: b.partial }))
  const last = bars[bars.length - 1], lm = m1[m1.length - 1]
  if (live && last && lm) last.secs = Math.max(1, Math.min(tf * 60, lm.t + (lm.partial ? Math.max(1, live.entrySec) : 60) - last.t))
  return {
    bars,
    vap: agg.map(b => {
      const m = new Map<number, [number, number]>()
      b.mins.forEach(i => (vap[i] ?? []).forEach(([tk, bb, aa]) => { const e = m.get(tk); if (e) { e[0] += bb; e[1] += aa } else m.set(tk, [bb, aa]) }))
      return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([tk, [bb, aa]]) => [tk, bb, aa] as VapRow)
    }),
  }
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
