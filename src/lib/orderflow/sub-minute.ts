/**
 * 15- and 30-second bars from ticks, for Replay Review's sub-minute candles.
 *
 * Built on the server from the same cut frame as the 1-minute bars, so a blind
 * snapshot's sub-minute bars end before the fill second too. Each tick goes to
 * the bar its own timestamp falls in; within a bar, open / close and the
 * running delta follow the frame's order (file order within the minute, as the
 * completed 1m bars do). dmin / dmax are the running delta's extremes counted
 * from the bar's first trade, as on the 1m bars. Bar POC = the price with the
 * most bid + ask volume, the lowest price on a tie.
 */
import type { TickFrame } from './ticks'
import { sierraUsToUtcMinMs, sierraUsToUtcSecMs } from './ticks'
import { pyRound } from './pymath'

/** How far back the sub-minute bars go: the 2 hours before the fill. */
export const SUB_LOOKBACK_MS = 2 * 60 * 60_000

export interface SubBars {
  /** Bar length, seconds. */
  s: 15 | 30
  /** PT-clock epoch seconds of each bar's start. */
  t: number[]
  o: number[]; h: number[]; l: number[]; c: number[]
  v: number[]; bv: number[]; av: number[]
  /** Delta at the close / running min / running max within the bar. */
  d: number[]; dmin: number[]; dmax: number[]
  poc: (number | null)[]
  /** The last bar is cut at the fill (Blind, or a replay still inside it). */
  partial: boolean
}

export interface SubMinute {
  /** PT-clock epoch seconds where the bars start (a minute boundary). */
  from: number
  s15: SubBars
  s30: SubBars
}

interface Acc { o: number; h: number; l: number; c: number; v: number; bv: number; av: number; d: number; dmin: number; dmax: number; vap: Map<number, number> }

/** `cutPtMs`: the fill instant when the frame is cut there (blind), so a bar it falls inside is flagged partial. */
export function subMinuteBars(ticks: TickFrame, fromPtMs: number, s: 15 | 30, cutPtMs: number | null): SubBars {
  const len = s * 1000
  const acc = new Map<number, Acc>()
  for (let i = 0; i < ticks.n; i++) {
    const pm = ticks.ptMin[i]
    if (pm + 60_000 <= fromPtMs) continue
    const us = ticks.us[i]
    const ptMs = pm + (sierraUsToUtcSecMs(us) - sierraUsToUtcMinMs(us))
    if (ptMs < fromPtMs) continue
    const k = Math.floor(ptMs / len) * len
    const px = ticks.px[i], bv = ticks.bv[i], av = ticks.av[i]
    let a = acc.get(k)
    if (!a) { a = { o: px, h: px, l: px, c: px, v: 0, bv: 0, av: 0, d: 0, dmin: Infinity, dmax: -Infinity, vap: new Map() }; acc.set(k, a) }
    if (px > a.h) a.h = px
    if (px < a.l) a.l = px
    a.c = px
    a.v += ticks.v[i]; a.bv += bv; a.av += av
    a.d += av - bv
    if (a.d < a.dmin) a.dmin = a.d
    if (a.d > a.dmax) a.dmax = a.d
    const tk = Math.round(px * 4)
    a.vap.set(tk, (a.vap.get(tk) ?? 0) + bv + av)
  }
  const out: SubBars = { s, t: [], o: [], h: [], l: [], c: [], v: [], bv: [], av: [], d: [], dmin: [], dmax: [], poc: [], partial: false }
  for (const k of [...acc.keys()].sort((x, y) => x - y)) {
    const a = acc.get(k)!
    let best = -1, poc: number | null = null
    for (const [tk, v] of a.vap) if (v > best || (v === best && poc != null && tk / 4 < poc)) { best = v; poc = tk / 4 }
    out.t.push(k / 1000)
    out.o.push(pyRound(a.o, 2)); out.h.push(pyRound(a.h, 2)); out.l.push(pyRound(a.l, 2)); out.c.push(pyRound(a.c, 2))
    out.v.push(a.v); out.bv.push(a.bv); out.av.push(a.av)
    out.d.push(a.d); out.dmin.push(a.dmin); out.dmax.push(a.dmax)
    out.poc.push(poc)
  }
  const n = out.t.length
  out.partial = cutPtMs != null && n > 0 && out.t[n - 1] * 1000 + len > cutPtMs
  return out
}

/** Both resolutions from `fromPtMs` on. */
export function subMinute(ticks: TickFrame, fromPtMs: number, cutPtMs: number | null): SubMinute {
  return { from: fromPtMs / 1000, s15: subMinuteBars(ticks, fromPtMs, 15, cutPtMs), s30: subMinuteBars(ticks, fromPtMs, 30, cutPtMs) }
}
