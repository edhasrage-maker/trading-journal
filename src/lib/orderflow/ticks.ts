/**
 * The tick frame every order-flow calculation runs on: one entry per Sierra
 * trade record, time-ascending, front-month only, as struct-of-arrays.
 *
 * Built server-side from .scid (see ./server/scid-ticks.ts). Field meanings
 * follow the .scid trade record: `hh` / `ll` are the ASK / BID at the moment
 * of the trade, not a range; `px` is the trade price.
 */

export type OfRoot = 'NQ' | 'ES'

export const TICK = 0.25

export interface TickFrame {
  n: number
  /** Sierra time: microseconds since 1899-12-30 UTC (exact in a double). */
  us: Float64Array
  /** Trade's PT-clock minute (ms, minute-aligned). See pt-clock.ts. */
  ptMin: Float64Array
  px: Float64Array
  /** Ask at the trade. */
  hh: Float64Array
  /** Bid at the trade. */
  ll: Float64Array
  v: Uint32Array
  bv: Uint32Array
  av: Uint32Array
  nt: Uint32Array
}

/** Microseconds between the Sierra epoch (1899-12-30) and the Unix epoch. */
export const SIERRA_EPOCH_OFFSET_US = 25569 * 86400 * 1_000_000

export const sierraUsToUtcMs = (us: number) => (us - SIERRA_EPOCH_OFFSET_US) / 1000
export const utcMsToSierraUs = (ms: number) => ms * 1000 + SIERRA_EPOCH_OFFSET_US

/** Exact floor(a / b) for non-negative integers held in doubles (< 2^53). */
export function floorDiv(a: number, b: number): number {
  let q = Math.floor(a / b)
  const r = a - q * b
  if (r < 0) q--
  else if (r >= b) q++
  return q
}

/** Sierra µs → UTC epoch ms of the containing whole SECOND. */
export function sierraUsToUtcSecMs(us: number): number {
  return floorDiv(us - SIERRA_EPOCH_OFFSET_US, 1_000_000) * 1000
}

/** Sierra µs → UTC epoch ms of the containing whole MINUTE. */
export function sierraUsToUtcMinMs(us: number): number {
  return floorDiv(us - SIERRA_EPOCH_OFFSET_US, 60_000_000) * 60_000
}

/** Fill `ptMin` (each trade's PT-clock minute, ms) from `us`. The PT offset only
 *  changes on a UTC hour boundary, so it is looked up once per hour. */
export function fillPtMinutes(us: Float64Array, ptMin: Float64Array, n: number, ptOffsetMs: (utcMs: number) => number) {
  let hourKey = NaN, off = 0
  for (let i = 0; i < n; i++) {
    const utcMinMs = sierraUsToUtcMinMs(us[i])
    const hk = Math.floor(utcMinMs / 3_600_000)
    if (hk !== hourKey) { hourKey = hk; off = ptOffsetMs(utcMinMs) }
    ptMin[i] = utcMinMs + off
  }
}

export function emptyTicks(): TickFrame {
  return {
    n: 0, us: new Float64Array(0), ptMin: new Float64Array(0), px: new Float64Array(0),
    hh: new Float64Array(0), ll: new Float64Array(0), v: new Uint32Array(0),
    bv: new Uint32Array(0), av: new Uint32Array(0), nt: new Uint32Array(0),
  }
}

/** Zero-copy view of ticks [i0, i1). */
export function sliceTicks(t: TickFrame, i0: number, i1: number): TickFrame {
  const a = Math.max(0, Math.min(i0, t.n)), b = Math.max(a, Math.min(i1, t.n))
  return {
    n: b - a, us: t.us.subarray(a, b), ptMin: t.ptMin.subarray(a, b), px: t.px.subarray(a, b),
    hh: t.hh.subarray(a, b), ll: t.ll.subarray(a, b), v: t.v.subarray(a, b),
    bv: t.bv.subarray(a, b), av: t.av.subarray(a, b), nt: t.nt.subarray(a, b),
  }
}

/** Index of the first tick with us >= x. */
export function lowerBoundUs(t: TickFrame, x: number): number {
  let lo = 0, hi = t.n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t.us[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Ticks STRICTLY before `cutoffUs` — the blind cut. A trade stamped in the
 * fill's own second or later is never included, so nothing at or after the
 * fill can leak into the chart.
 */
export function asOf(t: TickFrame, cutoffUs: number): TickFrame {
  return sliceTicks(t, 0, lowerBoundUs(t, cutoffUs))
}

/** True when the frame's times never step backwards. */
export function isTimeSorted(t: TickFrame): boolean {
  for (let i = 1; i < t.n; i++) if (t.us[i] < t.us[i - 1]) return false
  return true
}

/**
 * Stable sort by trade time (`key` 'us') or by PT minute ('ptMin'); returns the
 * frame itself when already in order.
 *
 * Sierra .scid files are not strictly time-ascending: a reconnect can append a
 * block of trades that were already written, so time steps backwards. The
 * reference treats the two halves of its payload differently, and both are
 * mirrored here:
 *   - its tick frame (bubbles, partial bar, volume-at-price) is sorted by time,
 *     stable, which interleaves the repeats with the originals → 'us';
 *   - its completed 1m bars were grouped by minute in FILE order, so the
 *     repeats sit at the end of their minute → 'ptMin'.
 * The difference shows up in order-sensitive fields such as a bar's running
 * delta max.
 */
export function stableSortTicks(t: TickFrame, key: 'us' | 'ptMin'): TickFrame {
  const k = t[key]
  let sorted = true
  for (let i = 1; i < t.n; i++) if (k[i] < k[i - 1]) { sorted = false; break }
  if (sorted) return t
  const idx = Array.from({ length: t.n }, (_, i) => i)
  idx.sort((a, b) => k[a] - k[b] || a - b)
  const take = <A extends Float64Array | Uint32Array>(src: A, out: A) => { for (let k = 0; k < idx.length; k++) out[k] = src[idx[k]]; return out }
  const n = t.n
  return {
    n, us: take(t.us, new Float64Array(n)), ptMin: take(t.ptMin, new Float64Array(n)), px: take(t.px, new Float64Array(n)),
    hh: take(t.hh, new Float64Array(n)), ll: take(t.ll, new Float64Array(n)), v: take(t.v, new Uint32Array(n)),
    bv: take(t.bv, new Uint32Array(n)), av: take(t.av, new Uint32Array(n)), nt: take(t.nt, new Uint32Array(n)),
  }
}

/** Ticks stamped before `cutoffUs`, for frames that may not be time-sorted. */
export function keepBefore(t: TickFrame, cutoffUs: number): TickFrame {
  let n = 0
  for (let i = 0; i < t.n; i++) if (t.us[i] < cutoffUs) n++
  if (n === t.n) return t
  const out: TickFrame = {
    n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n),
    hh: new Float64Array(n), ll: new Float64Array(n), v: new Uint32Array(n),
    bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
  }
  let j = 0
  for (let i = 0; i < t.n; i++) {
    if (t.us[i] >= cutoffUs) continue
    out.us[j] = t.us[i]; out.ptMin[j] = t.ptMin[i]; out.px[j] = t.px[i]; out.hh[j] = t.hh[i]; out.ll[j] = t.ll[i]
    out.v[j] = t.v[i]; out.bv[j] = t.bv[i]; out.av[j] = t.av[i]; out.nt[j] = t.nt[i]; j++
  }
  return out
}

/** Concatenate frames already in time order (e.g. two contracts across a roll). */
export function concatTicks(parts: TickFrame[]): TickFrame {
  const live = parts.filter(p => p.n > 0)
  if (live.length === 1) return live[0]
  const n = live.reduce((s, p) => s + p.n, 0)
  const out: TickFrame = {
    n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n),
    hh: new Float64Array(n), ll: new Float64Array(n), v: new Uint32Array(n),
    bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
  }
  let o = 0
  for (const p of live) {
    out.us.set(p.us, o); out.ptMin.set(p.ptMin, o); out.px.set(p.px, o); out.hh.set(p.hh, o)
    out.ll.set(p.ll, o); out.v.set(p.v, o); out.bv.set(p.bv, o); out.av.set(p.av, o); out.nt.set(p.nt, o)
    o += p.n
  }
  return out
}
