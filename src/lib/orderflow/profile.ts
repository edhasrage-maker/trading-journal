/**
 * Volume profiles and value areas.
 *
 *  valueAreaTicks — the reference server's value_area(): 1-tick rows, POC =
 *    first max, expand toward the larger neighbour (up on a tie) until 70% of
 *    volume; returns row prices (VAH is the top row's price). Used for the
 *    prior-RTH pVAH / pVAL / pPOC levels.
 *  volumeProfile — the reference viewer's profileFor(): rows of `g` ticks,
 *    same expansion, VAH reported as the TOP EDGE of its row. Used for the
 *    chart's profile and the developing POC / VAH / VAL.
 */
import type { Bar1m, VapRow } from './bars'

export function valueAreaTicks(ticks: ArrayLike<number>, vols: ArrayLike<number>, share = 0.70) {
  const n = ticks.length
  if (n === 0) return null
  let tot0 = 0
  for (let i = 0; i < n; i++) tot0 += vols[i]
  if (tot0 <= 0) return null
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i++) { if (ticks[i] < lo) lo = ticks[i]; if (ticks[i] > hi) hi = ticks[i] }
  const vv = new Float64Array(hi - lo + 1)
  for (let i = 0; i < n; i++) vv[ticks[i] - lo] += vols[i]
  let i = 0
  for (let k = 1; k < vv.length; k++) if (vv[k] > vv[i]) i = k
  let a = i, b = i, acc = vv[i]
  let tot = 0
  for (let k = 0; k < vv.length; k++) tot += vv[k]
  while (acc < share * tot) {
    const left = a > 0 ? vv[a - 1] : -1
    const right = b < vv.length - 1 ? vv[b + 1] : -1
    if (right >= left) { b++; acc += vv[b] } else { a--; acc += vv[a] }
  }
  return { poc: (lo + i) / 4, vah: (lo + b) / 4, val: (lo + a) / 4 }
}

export interface VolumeProfile {
  /** Row size in ticks. */
  g: number
  /** Row bottoms, in ticks, ascending and contiguous. */
  keys: number[]
  vols: number[]
  /** Index of the POC row, and of the value area's low / high rows. */
  poc: number; lo: number; hi: number
  max: number
  pocPx: number; vahPx: number; valPx: number
}

/** Profile of the 1m bars whose time is in [t0, t1) (PT-clock seconds). */
export function volumeProfile(m1: Bar1m[], vap: VapRow[][], t0: number, t1: number, g: number): VolumeProfile | null {
  const m = new Map<number, [number, number]>()
  m1.forEach((b, i) => {
    if (b.t >= t0 && b.t < t1) {
      vap[i].forEach(([tk, bb, aa]) => {
        const k = Math.floor(tk / g) * g
        const e = m.get(k) || [0, 0]
        e[0] += bb; e[1] += aa
        m.set(k, e)
      })
    }
  })
  if (!m.size) return null
  let kmin = Infinity, kmax = -Infinity
  for (const k of m.keys()) { if (k < kmin) kmin = k; if (k > kmax) kmax = k }
  const keys: number[] = [], vols: number[] = []
  for (let k = kmin; k <= kmax; k += g) { keys.push(k); const e = m.get(k); vols.push(e ? e[0] + e[1] : 0) }
  let mx = -Infinity
  for (const v of vols) if (v > mx) mx = v
  const i = vols.indexOf(mx)
  let lo = i, hi = i, acc = vols[i]
  const tot = vols.reduce((a, b) => a + b, 0)
  while (acc < 0.7 * tot) {
    const Lv = lo > 0 ? vols[lo - 1] : -1, Rv = hi < vols.length - 1 ? vols[hi + 1] : -1
    if (Rv >= Lv) { hi++; acc += vols[hi] } else { lo--; acc += vols[lo] }
  }
  return { g, keys, vols, poc: i, lo, hi, max: vols[i], pocPx: keys[i] / 4, vahPx: (keys[hi] + g) / 4, valPx: keys[lo] / 4 }
}

export type ProfileWindow = 'session' | 'on' | 'prior'

/** The viewer's three profile windows, from the payload's session times. */
export function profileWindow(which: ProfileWindow, times: { profile_anchor: number; eth_start: number; rth_open: number; prior_open: number; prior_close: number }): [number, number] {
  if (which === 'session') return [times.profile_anchor, Infinity]
  if (which === 'on') return [times.eth_start, times.rth_open]
  return [times.prior_open, times.prior_close]
}
