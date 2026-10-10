/**
 * Tick tape — the published copy of the trade stream that lets tapescore.app
 * build Deep Dive without Sierra's .scid files.
 *
 * The local feed agent (scripts/public-bar-feed.ts) writes one chunk per
 * instrument per PT clock hour into a PRIVATE storage bucket, plus one small
 * index per instrument. The hosted route reads them with the server key and
 * runs the SAME snapshot builder the local build runs on .scid, so the two
 * produce identical charts — including the partial entry bar cut at the fill
 * second, which no per-minute summary could reproduce.
 *
 * LOSSLESS. A chunk decodes to exactly the tick frame the .scid reader returns
 * for that hour: every time (µs), trade price, ask, bid, volume, bid/ask volume
 * and trade count, in FILE order (Sierra files can step backwards in time; the
 * snapshot builder depends on that order — see stableSortTicks).
 *
 * Format (before gzip): "TST1", record count, first time, then per record
 * zig-zag varints of: Δtime(µs) · Δprice · ask−price · price−bid (prices in
 * hundredths of a point) · bid volume · ask volume · volume−bid−ask · trades.
 * About 1 MB per instrument per day gzipped.
 *
 * Hundredths are exact for these contracts (0.25 tick; Sierra stores the price
 * as an integer number of hundredths). The publisher doesn't take that on
 * trust: it decodes every chunk and compares it to the source before upload,
 * and refuses to publish one that differs.
 */
import type { OfRoot, TickFrame } from './ticks'
import { fillPtMinutes } from './ticks'
import { ptOffsetMs } from './pt-clock'

export const TAPE_BUCKET = 'tick-tape'
/** Days of tape kept on the site (founder's call, 2026-10-09). */
export const TAPE_KEEP_DAYS = 90

const MAGIC = [0x54, 0x53, 0x54, 0x31] // "TST1"

/** One PT clock hour of one instrument. `ptDate` is the PT CALENDAR date. */
export const tapeChunkKey = (root: OfRoot, ptDate: string, hour: number) => `${root}/${ptDate}/${String(hour).padStart(2, '0')}.tst.gz`
export const tapeIndexKey = (root: OfRoot) => `${root}/index.json`

export interface TapeHourStat {
  /** Trades in the hour. */
  n: number
  hi: number
  lo: number
  /** First trade's price. */
  first: number
  /** Last trade's time — with `n`, tells the feed whether the hour changed. */
  lastUs: number
}
export interface TapeDay {
  /** Any trade in RTH (06:30–13:00 PT) on this date. */
  rth: boolean
  /** Keyed by two-digit PT hour. */
  hours: Record<string, TapeHourStat>
}
export interface TapeIndex {
  v: 1
  root: OfRoot
  updated: string
  /** Keyed by PT calendar date. */
  days: Record<string, TapeDay>
}
export const emptyTapeIndex = (root: OfRoot): TapeIndex => ({ v: 1, root, updated: new Date(0).toISOString(), days: {} })

const zz = (x: number) => (x < 0 ? -2 * x - 1 : 2 * x)
const unzz = (u: number) => (u % 2 === 1 ? -(u + 1) / 2 : u / 2)
const cents = (p: number) => Math.round(p * 100)

export function encodeTape(t: TickFrame): Uint8Array {
  // 8 varints per record, none longer than 8 bytes (a µs timestamp is < 2^53)
  const out = new Uint8Array(4 + 16 + t.n * 64)
  let o = 0
  for (const b of MAGIC) out[o++] = b
  // values reach ~4e15 (µs timestamps), beyond 32-bit shifts: divide instead
  const vi = (x: number) => { while (x >= 128) { out[o++] = (x % 128) | 128; x = Math.floor(x / 128) } out[o++] = x }
  vi(t.n)
  vi(t.n ? t.us[0] : 0)
  let pu = t.n ? t.us[0] : 0, pp = 0
  for (let i = 0; i < t.n; i++) {
    const p = cents(t.px[i])
    vi(zz(t.us[i] - pu)); pu = t.us[i]
    vi(zz(p - pp)); pp = p
    vi(zz(cents(t.hh[i]) - p)); vi(zz(p - cents(t.ll[i])))
    vi(t.bv[i]); vi(t.av[i]); vi(zz(t.v[i] - t.bv[i] - t.av[i])); vi(t.nt[i])
  }
  return out.slice(0, o)
}

export function decodeTape(buf: Uint8Array): TickFrame {
  for (let k = 0; k < 4; k++) if (buf[k] !== MAGIC[k]) throw new Error('not a tick tape chunk')
  let o = 4
  const rv = () => { let x = 0, m = 1, b: number; do { b = buf[o++]; x += (b & 127) * m; m *= 128 } while (b & 128); return x }
  const n = rv()
  const t: TickFrame = {
    n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n), hh: new Float64Array(n),
    ll: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
  }
  let pu = rv(), pp = 0
  for (let i = 0; i < n; i++) {
    pu += unzz(rv()); t.us[i] = pu
    pp += unzz(rv()); const p = pp
    t.px[i] = p / 100
    t.hh[i] = (p + unzz(rv())) / 100
    t.ll[i] = (p - unzz(rv())) / 100
    const bv = rv(), av = rv()
    t.bv[i] = bv; t.av[i] = av; t.v[i] = bv + av + unzz(rv()); t.nt[i] = rv()
  }
  fillPtMinutes(t.us, t.ptMin, n, ptOffsetMs)
  return t
}

/** Index stats for one hour's frame. */
export function tapeHourStat(t: TickFrame): TapeHourStat {
  let hi = -Infinity, lo = Infinity
  for (let i = 0; i < t.n; i++) { const p = t.px[i]; if (p > hi) hi = p; if (p < lo) lo = p }
  return { n: t.n, hi, lo, first: t.px[0], lastUs: t.us[t.n - 1] }
}
