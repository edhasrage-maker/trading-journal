/**
 * 40-trade bubble chart — port of the founder's Sierra study
 * Edhasrage_Delta_Heat_Map.cpp / Edhasrage_ES_Delta_Heat_Map.cpp (default
 * inputs, full-recalculation path), by way of the reference server's
 * bubble_chart(). One bubble per 40 accepted trade records.
 *
 *  Accepting a record: price = Close, volume = TotalVolume. Ask volume > bid
 *  volume is a buy, bid > ask a sell. A volume tie resolves only on a
 *  single-trade record: price >= ask (High) buys, price <= bid (Low) sells;
 *  otherwise the record is skipped. Price <= 0, volume <= 0 or bid+ask = 0 is
 *  skipped too. ES tick-rounds every price; NQ keeps raw prices.
 *
 *  Bubble: dominant side's volume (tie -> buy), priced at the dominant side's
 *  largest print if >= the large-print threshold, else the larger qualifying
 *  print of either side (tie -> buy), else the newest trade price. Among equal
 *  print sizes the newest wins.
 *
 *  Level 0/1/2 (size + colour): rank against the previous L bubbles (current
 *  excluded, no session reset), ceil-rank on (n-1), no interpolation.
 *  ES only: a level-2 bubble below the linear 99.5th percentile of all bubbles
 *  drops to level 1 (not applied to the live preview).
 *
 *  Large-print rings: at most one per bar (the print chosen for the price),
 *  deduped, clustered, thresholded — see `marks` below.
 *
 *  Play forward rebuilds the chart as of any second after the fill from a Full
 *  review payload (bubblesAsOf), by these same rules: what it shows is what a
 *  Blind cut at that second shows.
 */
import type { OfRoot, TickFrame } from './ticks'
import { TICK } from './ticks'
import { npPercentileLinear, npPercentileLinearTop, pyRound, rint } from './pymath'
import { utcToPtMs } from './pt-clock'
import { sierraUsToUtcSecMs } from './ticks'

export interface BubbleConfig {
  /** Ranking lookback (bubbles). */
  lookback: number
  /** Medium / large percentiles. */
  mediumPct: number
  largePct: number
  /** Large-print threshold (contracts). */
  lpt: number
  /** ES level-2 floor percentile over all loaded bubbles (null = off). */
  floor: number | null
}

export const BUBBLE_CFG: Record<OfRoot, BubbleConfig> = {
  NQ: { lookback: 100, mediumPct: 70, largePct: 99, lpt: 50, floor: null },
  ES: { lookback: 200, mediumPct: 80, largePct: 99, lpt: 100, floor: 99.5 },
}

export const TRADES_PER_BUBBLE = 40
export const BUBBLE_SIZES = [5, 15, 35] as const
export const MAX_BUBBLES = 4000

export interface LargePrintMark {
  /** Absolute 40T bar index (subtract `first` for an index into the arrays). */
  g: number
  side: 1 | -1
  vol: number
  px: number
}

export interface BubbleChart {
  /** Absolute index of the first bubble returned (older ones are trimmed). */
  first: number
  /** Total 40T bars built (incl. trimmed and the live one). */
  n: number
  /** Trades in the last (live, possibly partial) bar. */
  live_trades: number
  /** The live bar's level before the ES floor (the study's live preview). */
  live_lvl: number
  lpt: number
  /** 40T bar OHLC (trade prices). */
  o: number[]; h: number[]; l: number[]; c: number[]
  /** PT-clock epoch seconds of each bar's last trade. */
  t: number[]
  vol: number[]
  dir: (1 | -1)[]
  px: number[]
  lvl: number[]
  sizes: number[]
  marks: LargePrintMark[]
  cfg: { lookback: number; medium_pct: number; large_pct: number; floor: number | null }
  /**
   * Full review only: what Play forward needs to show the chart exactly as a
   * Blind cut at any second after the fill would (bubblesAsOf). The bubble
   * still forming, the ES floor and the large-print clusters all depend on
   * where the cut falls, so the final arrays can't simply be sliced.
   */
  raw?: BubbleRaw
}

/** A large print that survived the dedupe: [absolute 40T bar, side, volume, price]. */
export type KeptPrint = [number, number, number, number]

export interface BubbleRaw {
  /** Levels before the ES floor (the ranking only looks back). */
  lvl0: number[]
  /** ES: the largest volumes of the bubbles before `first`, enough for the floor at any cut. NQ: null. */
  vol_top: number[] | null
  /** Every deduped large print, oldest first (the dedupe only looks back). */
  kept: KeptPrint[]
  /**
   * Every accepted trade from the start of the bubble forming at the fill to
   * the end of the data: trade `from + i` (from is a multiple of 40), stamped
   * PT-clock second `s0 + s[i]`, at price `px[i]` as the study takes it, volume
   * `v[i]` signed + buy / − sell.
   */
  trades: { from: number; s0: number; s: number[]; px: number[]; v: number[] }
}

/** Sorted multiset with O(L) insert/remove — the rolling ranking window. */
function insertSorted(a: number[], x: number) {
  let lo = 0, hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid }
  a.splice(lo, 0, x)
}
function removeSorted(a: number[], x: number) {
  let lo = 0, hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < x) lo = mid + 1; else hi = mid }
  a.splice(lo, 1)
}

/** One 40T bar as the study builds it from accepted trades s..e. */
interface Bar40 { o: number; h: number; l: number; c: number; vol: number; dir: 1 | -1; px: number; lpSide: 1 | -1 | 0; lpVol: number }

/** The bar of accepted trades s..e (prices as accepted, volume signed + buy / − sell). */
function bar40(apx: ArrayLike<number>, asv: ArrayLike<number>, s: number, e: number, lpt: number): Bar40 {
  let hi = -Infinity, lo = Infinity, buy = 0, sell = 0
  // largest print per side; ties -> newest (later index wins on >=)
  let bigBuyV = 0, bigBuyP = NaN, bigSellV = 0, bigSellP = NaN
  let hasBuy = false, hasSell = false
  for (let k = s; k <= e; k++) {
    const p = apx[k], x = asv[k]
    if (p > hi) hi = p
    if (p < lo) lo = p
    if (x > 0) {
      buy += x
      if (!hasBuy || x >= bigBuyV) { bigBuyV = x; bigBuyP = p; hasBuy = true }
    } else {
      sell -= x
      if (!hasSell || -x >= bigSellV) { bigSellV = -x; bigSellP = p; hasSell = true }
    }
  }
  const dm = buy >= sell ? 1 : -1
  const b: Bar40 = { o: apx[s], h: hi, l: lo, c: apx[e], vol: dm > 0 ? buy : sell, dir: dm, px: apx[e], lpSide: 0, lpVol: 0 }
  const hb = bigBuyV >= lpt, hs = bigSellV >= lpt
  const useBuy = (dm > 0 && hb) || (!(dm < 0 && hs) && (hb || hs) && bigBuyV >= bigSellV && hb)
  const useSell = !useBuy && (hb || hs)
  if (useBuy) { b.px = rint(bigBuyP / TICK) * TICK; b.lpSide = 1; b.lpVol = bigBuyV }
  else if (useSell) { b.px = rint(bigSellP / TICK) * TICK; b.lpSide = -1; b.lpVol = bigSellV }
  return b
}

/** Level 0/1/2 of a bubble of volume x against the previous bubbles' volumes `win` (ascending). */
function rankLevel(win: readonly number[], x: number, pm: number, pl: number): number {
  const cnt = win.length
  if (cnt <= 1) return 0
  const mi = Math.min(Math.max(Math.ceil((pm / 100.0) * (cnt - 1)), 0), cnt - 1)
  const li = Math.min(Math.max(Math.ceil((pl / 100.0) * (cnt - 1)), 0), cnt - 1)
  return x > win[li] ? 2 : x >= win[mi] ? 1 : 0
}

/** The dedupe: a print repeating one kept within 5 bars (same side and size, within 2 ticks) is dropped. */
function isRepeat(kept: readonly KeptPrint[], from: number, k: number, sd: number, vv: number, pp: number): boolean {
  for (let j = from; j < kept.length; j++) {
    const q = kept[j]
    if (q[1] === sd && rint(q[2]) === rint(vv) && Math.abs(q[0] - k) <= 5 && Math.abs(q[3] - pp) <= 2 * TICK) return true
  }
  return false
}

/**
 * Large-print rings from the deduped prints: cluster, then threshold. A
 * cluster's ring moves to a later, bigger print at the same price.
 */
export function clusterMarks(kept: readonly KeptPrint[], lpt: number, a0: number): LargePrintMark[] {
  const clusters: KeptPrint[] = []
  for (const [k, sd, vv, pp] of kept) {
    let cl: KeptPrint | null = null
    for (let j = clusters.length - 1; j >= 0; j--) {
      const q = clusters[j]
      if (q[1] === sd && Math.abs(k - q[0]) <= 24 && Math.abs(pp - q[3]) <= 0.51 * TICK) { cl = q; break }
    }
    if (cl === null) clusters.push([k, sd, vv, pp])
    else if (vv > cl[2]) { cl[0] = k; cl[2] = vv; cl[3] = pp }
  }
  const marks: LargePrintMark[] = []
  for (const q of clusters) {
    if (q[2] >= lpt && q[0] >= a0 - 1) marks.push({ g: q[0], side: q[1] as 1 | -1, vol: rint(q[2]), px: q[3] })
  }
  return marks
}

const ptSec = (us: number) => utcToPtMs(sierraUsToUtcSecMs(us)) / 1000
const bubbleCount = (trades: number) => (trades > 0 ? Math.floor((trades - 1) / TRADES_PER_BUBBLE) + 1 : 0)

/** Accepted trades stamped before PT-clock second `sec`: exactly the ones a Blind cut there takes. From the fill on. */
export function tradesBefore(B: BubbleChart, sec: number): number {
  const T = B.raw?.trades
  if (!T) return 0
  let lo = 0, hi = T.s.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (T.s0 + T.s[mid] < sec) lo = mid + 1; else hi = mid }
  return T.from + lo
}

/**
 * Play forward: the chart exactly as a Blind cut would have built it once the
 * first `trades` accepted trades had printed — the bubble still forming
 * included, ranked against the bubbles before it; the ES floor over every
 * bubble up to it; the large-print rings clustered from the prints up to it;
 * the oldest trimmed at the same cap. Needs `raw` (Full review payloads);
 * `trades` is held between the fill and the end of the data.
 */
export function bubblesAsOf(B: BubbleChart, trades: number, maxBubbles = MAX_BUBBLES): BubbleChart | null {
  const R = B.raw
  if (!R) return null
  const T = R.trades, TPB = TRADES_PER_BUBBLE
  const nT = Math.max(T.from, Math.min(trades, T.from + T.s.length))
  const nb = bubbleCount(nT), last = nb - 1
  if (nb === 0) return null
  // the payload keeps every bubble the fill's cut showed, so a0 >= B.first
  const a0 = Math.max(0, nb - maxBubbles), j0 = a0 - B.first, jl = last - B.first
  const take = <X>(a: X[]) => a.slice(j0, jl + 1)
  const o = take(B.o), h = take(B.h), l = take(B.l), c = take(B.c), t = take(B.t)
  const vol = take(B.vol), dir = take(B.dir), px = take(B.px), lvl0 = take(R.lvl0)
  const k = last - a0
  let kept = R.kept.filter(q => q[0] <= last)
  const live = nT - last * TPB
  if (live < TPB) {
    // the bubble still forming: its trades so far
    const s = last * TPB - T.from, e = nT - 1 - T.from
    const b = bar40(T.px, T.v, s, e, B.lpt)
    o[k] = pyRound(b.o, 2); h[k] = pyRound(b.h, 2); l[k] = pyRound(b.l, 2); c[k] = pyRound(b.c, 2)
    t[k] = T.s0 + T.s[e]; vol[k] = pyRound(b.vol, 0); dir[k] = b.dir; px[k] = pyRound(b.px, 2)
    const win = B.vol.slice(Math.max(0, last - B.cfg.lookback) - B.first, jl).sort((x, y) => x - y)
    lvl0[k] = rankLevel(win, b.vol, B.cfg.medium_pct, B.cfg.large_pct)
    kept = kept.filter(q => q[0] < last)
    if (b.lpSide !== 0 && !isRepeat(kept, 0, last, b.lpSide, b.lpVol, b.px)) kept.push([last, b.lpSide, b.lpVol, b.px])
  }
  const fl = B.cfg.floor != null && R.vol_top ? npPercentileLinearTop([...R.vol_top, ...B.vol.slice(0, jl), vol[k]], nb, B.cfg.floor) : null
  return {
    first: a0, n: nb, live_trades: live, live_lvl: lvl0[k], lpt: B.lpt,
    o, h, l, c, t, vol, dir, px,
    lvl: lvl0.map((lv, i) => (fl != null && lv === 2 && vol[i] < fl ? 1 : lv)),
    sizes: B.sizes,
    marks: clusterMarks(kept, B.lpt, a0),
    cfg: B.cfg,
  }
}

/**
 * `replayFromUs` (Full review: the fill, Sierra µs): also return `raw` for
 * Play forward, and trim the oldest bubbles from where a Blind cut at the fill
 * would, so every later cut can be rebuilt from this one chart.
 */
export function bubbles40t(ticks: TickFrame, root: OfRoot, maxBubbles = MAX_BUBBLES, opts: { replayFromUs?: number } = {}): BubbleChart | null {
  const cfg = BUBBLE_CFG[root]
  if (ticks.n === 0) return null

  // ---- accept records (DeltaBubbleScidRecordToTrade) ----
  const N = ticks.n
  const apx = new Float64Array(N), asv = new Float64Array(N), aus = new Float64Array(N)
  let n = 0
  for (let i = 0; i < N; i++) {
    const raw = ticks.px[i], v = ticks.v[i], b = ticks.bv[i], a = ticks.av[i]
    let d = a > b ? 1 : b > a ? -1 : 0
    if (d === 0 && ticks.nt[i] === 1) {
      if (ticks.hh[i] > 0 && raw >= ticks.hh[i]) d = 1
      else if (ticks.ll[i] > 0 && raw <= ticks.ll[i]) d = -1
    }
    if (!(raw > 0 && v > 0 && b + a > 0 && d !== 0)) continue
    apx[n] = root === 'ES' ? rint(raw / TICK) * TICK : raw
    asv[n] = d * v; aus[n] = ticks.us[i]
    n++
  }
  if (n === 0) return null

  const TPB = TRADES_PER_BUBBLE
  const nb = bubbleCount(n)
  const o = new Float64Array(nb), h = new Float64Array(nb), l = new Float64Array(nb), c = new Float64Array(nb)
  const vol = new Float64Array(nb), dom = new Int8Array(nb), bpx = new Float64Array(nb)
  const lpSide = new Int8Array(nb), lpVol = new Float64Array(nb), tEnd = new Float64Array(nb)

  for (let g = 0; g < nb; g++) {
    const s = g * TPB, e = Math.min(s + TPB, n) - 1
    const b = bar40(apx, asv, s, e, cfg.lpt)
    o[g] = b.o; h[g] = b.h; l[g] = b.l; c[g] = b.c
    vol[g] = b.vol; dom[g] = b.dir; bpx[g] = b.px; lpSide[g] = b.lpSide; lpVol[g] = b.lpVol
    tEnd[g] = ptSec(aus[e])
  }

  // ---- size/colour level: rank vs the previous L bubbles ----
  const LB = cfg.lookback
  const pm = Math.min(Math.max(cfg.mediumPct, 1), 98)
  const pl = Math.min(Math.max(cfg.largePct, pm + 1), 99)
  const lvl = new Int8Array(nb)
  const win: number[] = []
  for (let i = 0; i < nb; i++) {
    lvl[i] = rankLevel(win, vol[i], pm, pl)
    insertSorted(win, vol[i])
    if (win.length > LB) removeSorted(win, vol[i - LB])
  }
  const liveLvl = lvl[nb - 1]
  const replayFrom = opts.replayFromUs
  const lvl0 = replayFrom != null ? Array.from(lvl) : null
  if (cfg.floor != null) {
    const fl = npPercentileLinear(vol, cfg.floor)
    for (let i = 0; i < nb; i++) if (lvl[i] === 2 && vol[i] < fl) lvl[i] = 1
  }

  // ---- large-print marks: dedupe, then cluster, then threshold ----
  const kept: KeptPrint[] = []
  let keptFrom = 0                             // kept[] is ascending in bar; dedupe looks back <= 5 bars
  for (let k = 0; k < nb; k++) {
    if (lpSide[k] === 0) continue
    while (keptFrom < kept.length && kept[keptFrom][0] < k - 5) keptFrom++
    if (!isRepeat(kept, keptFrom, k, lpSide[k], lpVol[k], bpx[k])) kept.push([k, lpSide[k], lpVol[k], bpx[k]])
  }

  // the trim counts back from the newest bubble, or (Play forward) from the one forming at the fill,
  // keeping at least the lookback before it so a forming bubble can be ranked
  let atFill = n
  if (replayFrom != null) { atFill = 0; while (atFill < n && aus[atFill] < replayFrom) atFill++ }
  const a0 = Math.max(0, bubbleCount(atFill) - (replayFrom != null ? Math.max(maxBubbles, LB + 1) : maxBubbles))
  const marks = clusterMarks(kept, cfg.lpt, a0)
  // Output rounding mirrors the reference's JSON (prices to 0.01, volume whole).
  const sl = (x: ArrayLike<number>, nd: number | null = null) => {
    const out = Array.from(x).slice(a0)
    return nd == null ? out : out.map(v => pyRound(v, nd))
  }
  let raw: BubbleRaw | null = null
  if (lvl0) {
    const from = Math.max(0, bubbleCount(atFill) - 1) * TPB, s0 = from < n ? ptSec(aus[from]) : 0
    const s: number[] = []
    for (let i = from; i < n; i++) s.push(ptSec(aus[i]) - s0)
    raw = {
      lvl0: lvl0.slice(a0),
      vol_top: cfg.floor != null ? topVolumes(vol, a0, nb, cfg.floor) : null,
      kept,
      trades: { from, s0, s, px: Array.from(apx.subarray(from, n)), v: Array.from(asv.subarray(from, n)) },
    }
  }
  return {
    first: a0, n: nb, live_trades: n - (nb - 1) * TPB, live_lvl: liveLvl, lpt: cfg.lpt,
    o: sl(o, 2), h: sl(h, 2), l: sl(l, 2), c: sl(c, 2), t: sl(tEnd),
    vol: sl(vol, 0), dir: sl(dom) as (1 | -1)[], px: sl(bpx, 2), lvl: sl(lvl),
    sizes: [...BUBBLE_SIZES],
    marks,
    cfg: { lookback: LB, medium_pct: pm, large_pct: pl, floor: cfg.floor },
    ...(raw ? { raw } : {}),
  }
}

/**
 * The volumes the ES floor can reach among the bubbles before `a0`: at a cut
 * of n bubbles the percentile reads only the n − ⌊(n − 1)·q/100⌋ largest
 * (npPercentileLinearTop), and that only grows with n, up to `nb`.
 */
function topVolumes(vol: Float64Array, a0: number, nb: number, q: number): number[] {
  const k = Math.min(a0, nb - Math.floor((nb - 1) * (q / 100)) + 1)
  return Array.from(vol.subarray(0, a0)).sort((x, y) => y - x).slice(0, k)
}
