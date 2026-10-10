/**
 * 1-minute bars and volume-at-price from ticks, PT-clock minutes.
 *
 * Bars aggregate the trade price only (Close), never a record's High/Low —
 * those are the ask/bid at the trade. Delta is ask volume minus bid volume;
 * dmin/dmax are the running delta's extremes counted from the minute's first
 * trade (not from zero), exactly as the reference's 1m delta bars define them.
 *
 * Called on a frame already cut at the fill (asOf), the entry minute comes out
 * as the PARTIAL bar: only the trades before the fill second.
 */
import type { TickFrame } from './ticks'

export interface MinuteBars {
  /** PT-clock minute start, epoch SECONDS (the chart's time axis). */
  t: number[]
  o: number[]; h: number[]; l: number[]; c: number[]
  v: number[]; bv: number[]; av: number[]
  /** Delta at the close / running min / running max within the minute. */
  d: number[]; dmin: number[]; dmax: number[]
  /** Σ price × volume and Σ volume, for tick-true VWAP. */
  pv: number[]; vv: number[]
}

export interface VapByMinute {
  /** Bar index into MinuteBars. */
  m: number[]
  /** Price in ticks (price × 4). */
  t: number[]
  /** Bid / ask volume traded at that price in that minute. */
  b: number[]
  a: number[]
}

export interface MinuteAggregate {
  bars: MinuteBars
  vap: VapByMinute
  /** Bar index of every tick (same length as the frame). */
  barOf: Int32Array
}

/**
 * One pass over the ticks: bars, per-bar Σpv / Σv, and volume-at-price sorted
 * by (bar, price) — the reference's np.unique(bar << 20 | tick) order.
 */
export function aggregateMinutes(ticks: TickFrame): MinuteAggregate {
  const bars: MinuteBars = { t: [], o: [], h: [], l: [], c: [], v: [], bv: [], av: [], d: [], dmin: [], dmax: [], pv: [], vv: [] }
  const barOf = new Int32Array(ticks.n)
  const vap: VapByMinute = { m: [], t: [], b: [], a: [] }
  let cur = -1
  let lastMin = NaN
  let cd = 0
  // per-bar price -> [bid, ask], flushed in ascending price order at each bar end
  let cell = new Map<number, [number, number]>()
  const flush = (bar: number) => {
    const keys = [...cell.keys()].sort((x, y) => x - y)
    for (const k of keys) {
      const e = cell.get(k)!
      vap.m.push(bar); vap.t.push(k); vap.b.push(e[0]); vap.a.push(e[1])
    }
    cell = new Map()
  }
  for (let i = 0; i < ticks.n; i++) {
    const m = ticks.ptMin[i]
    const px = ticks.px[i]
    const v = ticks.v[i], bv = ticks.bv[i], av = ticks.av[i]
    if (m !== lastMin) {
      if (cur >= 0) flush(cur)
      cur++
      lastMin = m
      cd = 0
      bars.t.push(m / 1000)
      bars.o.push(px); bars.h.push(px); bars.l.push(px); bars.c.push(px)
      bars.v.push(0); bars.bv.push(0); bars.av.push(0)
      bars.d.push(0); bars.dmin.push(Infinity); bars.dmax.push(-Infinity)
      bars.pv.push(0); bars.vv.push(0)
    }
    if (px > bars.h[cur]) bars.h[cur] = px
    if (px < bars.l[cur]) bars.l[cur] = px
    bars.c[cur] = px
    bars.v[cur] += v; bars.bv[cur] += bv; bars.av[cur] += av
    cd += av - bv
    bars.d[cur] = cd
    if (cd < bars.dmin[cur]) bars.dmin[cur] = cd
    if (cd > bars.dmax[cur]) bars.dmax[cur] = cd
    bars.pv[cur] += px * v
    bars.vv[cur] += v
    barOf[i] = cur
    const k = Math.round(px * 4)
    const e = cell.get(k)
    if (e) { e[0] += bv; e[1] += av } else cell.set(k, [bv, av])
  }
  if (cur >= 0) flush(cur)
  return { bars, vap, barOf }
}

/**
 * The partial entry bar: ticks of the entry minute strictly before the cutoff.
 * null when nothing traded in that window (including a fill on the exact
 * minute, where the window is empty).
 */
export function partialBar(ticks: TickFrame, entryMinutePtMs: number) {
  let i0 = ticks.n
  while (i0 > 0 && ticks.ptMin[i0 - 1] === entryMinutePtMs) i0--
  if (i0 === ticks.n) return null
  let o = NaN, h = -Infinity, l = Infinity, c = NaN, v = 0, bv = 0, av = 0, cd = 0, dmin = Infinity, dmax = -Infinity
  for (let i = i0; i < ticks.n; i++) {
    const px = ticks.px[i]
    if (i === i0) o = px
    if (px > h) h = px
    if (px < l) l = px
    c = px
    v += ticks.v[i]; bv += ticks.bv[i]; av += ticks.av[i]
    cd += ticks.av[i] - ticks.bv[i]
    if (cd < dmin) dmin = cd
    if (cd > dmax) dmax = cd
  }
  return { o, h, l, c, v, bv, av, dclose: cd, dmin, dmax }
}
