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
 */
import type { OfRoot, TickFrame } from './ticks'
import { TICK } from './ticks'
import { npPercentileLinear, pyRound, rint } from './pymath'
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

export function bubbles40t(ticks: TickFrame, root: OfRoot, maxBubbles = MAX_BUBBLES): BubbleChart | null {
  const cfg = BUBBLE_CFG[root]
  if (ticks.n === 0) return null

  // ---- accept records (DeltaBubbleScidRecordToTrade) ----
  const N = ticks.n
  const apx = new Float64Array(N), av = new Float64Array(N), ad = new Int8Array(N), aus = new Float64Array(N)
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
    av[n] = v; ad[n] = d; aus[n] = ticks.us[i]
    n++
  }
  if (n === 0) return null

  const TPB = TRADES_PER_BUBBLE
  const nb = Math.floor((n - 1) / TPB) + 1
  const o = new Float64Array(nb), h = new Float64Array(nb), l = new Float64Array(nb), c = new Float64Array(nb)
  const vol = new Float64Array(nb), dom = new Int8Array(nb), bpx = new Float64Array(nb)
  const lpSide = new Int8Array(nb), lpVol = new Float64Array(nb), tEnd = new Float64Array(nb)

  for (let g = 0; g < nb; g++) {
    const s = g * TPB, e = Math.min(s + TPB, n) - 1
    o[g] = apx[s]; c[g] = apx[e]
    let hi = -Infinity, lo = Infinity, buy = 0, sell = 0
    // largest print per side; ties -> newest (later index wins on >=)
    let bigBuyV = 0, bigBuyP = NaN, bigSellV = 0, bigSellP = NaN
    let hasBuy = false, hasSell = false
    for (let k = s; k <= e; k++) {
      const p = apx[k]
      if (p > hi) hi = p
      if (p < lo) lo = p
      if (ad[k] > 0) {
        buy += av[k]
        if (!hasBuy || av[k] >= bigBuyV) { bigBuyV = av[k]; bigBuyP = p; hasBuy = true }
      } else {
        sell += av[k]
        if (!hasSell || av[k] >= bigSellV) { bigSellV = av[k]; bigSellP = p; hasSell = true }
      }
    }
    h[g] = hi; l[g] = lo
    const dm = buy >= sell ? 1 : -1
    dom[g] = dm
    vol[g] = dm > 0 ? buy : sell
    const L = cfg.lpt
    const hb = bigBuyV >= L, hs = bigSellV >= L
    const useBuy = (dm > 0 && hb) || (!(dm < 0 && hs) && (hb || hs) && bigBuyV >= bigSellV && hb)
    const useSell = !useBuy && (hb || hs)
    if (useBuy) { bpx[g] = rint(bigBuyP / TICK) * TICK; lpSide[g] = 1; lpVol[g] = bigBuyV }
    else if (useSell) { bpx[g] = rint(bigSellP / TICK) * TICK; lpSide[g] = -1; lpVol[g] = bigSellV }
    else { bpx[g] = c[g]; lpSide[g] = 0; lpVol[g] = 0 }
    tEnd[g] = utcToPtMs(sierraUsToUtcSecMs(aus[e])) / 1000
  }

  // ---- size/colour level: rank vs the previous L bubbles ----
  const LB = cfg.lookback
  const pm = Math.min(Math.max(cfg.mediumPct, 1), 98)
  const pl = Math.min(Math.max(cfg.largePct, pm + 1), 99)
  const lvl = new Int8Array(nb)
  const win: number[] = []
  for (let i = 0; i < nb; i++) {
    if (i >= 1) {
      const cnt = win.length
      if (cnt > 1) {
        const mi = Math.min(Math.max(Math.ceil((pm / 100.0) * (cnt - 1)), 0), cnt - 1)
        const li = Math.min(Math.max(Math.ceil((pl / 100.0) * (cnt - 1)), 0), cnt - 1)
        const x = vol[i]
        lvl[i] = x > win[li] ? 2 : x >= win[mi] ? 1 : 0
      }
    }
    insertSorted(win, vol[i])
    if (win.length > LB) removeSorted(win, vol[i - LB])
  }
  const liveLvl = lvl[nb - 1]
  if (cfg.floor != null) {
    const fl = npPercentileLinear(vol, cfg.floor)
    for (let i = 0; i < nb; i++) if (lvl[i] === 2 && vol[i] < fl) lvl[i] = 1
  }

  // ---- large-print marks: dedupe, then cluster, then threshold ----
  type Q = [number, number, number, number]   // [bar, side, vol, px]
  const kept: Q[] = []
  let keptFrom = 0                             // kept[] is ascending in bar; dedupe looks back <= 5 bars
  for (let k = 0; k < nb; k++) {
    if (lpSide[k] === 0) continue
    const sd = lpSide[k], vv = lpVol[k], pp = bpx[k]
    while (keptFrom < kept.length && kept[keptFrom][0] < k - 5) keptFrom++
    let dup = false
    for (let j = keptFrom; j < kept.length; j++) {
      const q = kept[j]
      if (q[1] === sd && rint(q[2]) === rint(vv) && Math.abs(q[0] - k) <= 5 && Math.abs(q[3] - pp) <= 2 * TICK) { dup = true; break }
    }
    if (!dup) kept.push([k, sd, vv, pp])
  }
  const clusters: Q[] = []
  for (const [k, sd, vv, pp] of kept) {
    let cl: Q | null = null
    for (let j = clusters.length - 1; j >= 0; j--) {
      const q = clusters[j]
      if (q[1] === sd && Math.abs(k - q[0]) <= 24 && Math.abs(pp - q[3]) <= 0.51 * TICK) { cl = q; break }
    }
    if (cl === null) clusters.push([k, sd, vv, pp])
    else if (vv > cl[2]) { cl[0] = k; cl[2] = vv; cl[3] = pp }
  }

  const a0 = Math.max(0, nb - maxBubbles)
  const marks: LargePrintMark[] = []
  for (const q of clusters) {
    if (q[2] >= cfg.lpt && q[0] >= a0 - 1) marks.push({ g: q[0], side: q[1] as 1 | -1, vol: rint(q[2]), px: q[3] })
  }
  // Output rounding mirrors the reference's JSON (prices to 0.01, volume whole).
  const sl = (x: ArrayLike<number>, nd: number | null = null) => {
    const out = Array.from(x).slice(a0)
    return nd == null ? out : out.map(v => pyRound(v, nd))
  }
  return {
    first: a0, n: nb, live_trades: n - (nb - 1) * TPB, live_lvl: liveLvl, lpt: cfg.lpt,
    o: sl(o, 2), h: sl(h, 2), l: sl(l, 2), c: sl(c, 2), t: sl(tEnd),
    vol: sl(vol, 0), dir: sl(dom) as (1 | -1)[], px: sl(bpx, 2), lvl: sl(lvl),
    sizes: [...BUBBLE_SIZES],
    marks,
    cfg: { lookback: LB, medium_pct: pm, large_pct: pl, floor: cfg.floor },
  }
}
