import { openSync, readSync, fstatSync, closeSync } from 'fs'
import type { ProfileRow } from './volume-profile'

/**
 * Tick-true volume-at-price from a Sierra .scid file. Node-only (fs).
 *
 * Record layout is documented in scid-reader.ts; the constants are repeated
 * here rather than exported from there so this reader can ship without touching
 * that file. Per trade record: [0] int64 DateTime (µs since 1899-12-30 UTC),
 * [20] float Close = trade price, [28] uint32 TotalVolume, [32] BidVolume,
 * [36] AskVolume.
 *
 * Only Close is used for price. High/Low on a tick record are the ask/bid at
 * the moment of the trade, not a range — reading them as a range is the exact
 * bug that once inflated every bar builder here.
 */

const HEADER_SIZE = 56
const RECORD_SIZE = 40
const SCID_EPOCH_OFFSET_US = 25569 * 86400 * 1_000_000
/** Records per read. ~40 MB per chunk; a full ES RTH session is ~425k records. */
const CHUNK_RECORDS = 1_000_000

export interface ScidProfileResult {
  rows: ProfileRow[]
  trades: number
}

function timeMsAt(fd: number, index: number, buf: Buffer): number {
  readSync(fd, buf, 0, 8, HEADER_SIZE + index * RECORD_SIZE)
  return (Number(buf.readBigInt64LE(0)) - SCID_EPOCH_OFFSET_US) / 1000
}

function lowerBound(fd: number, count: number, targetMs: number): number {
  const buf = Buffer.alloc(8)
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (timeMsAt(fd, mid, buf) < targetMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Volume traded at each price in [startMs, endMs).
 *
 * Prices are snapped to `tick` in integer-tick space, so float noise in the
 * stored Close can never split one price into two rows. Rows come back
 * ascending and contiguous — prices inside the session's range that never
 * traded appear with zero volume, so the profile has no visual holes.
 */
export function readScidVolumeAtPrice(
  path: string,
  startMs: number,
  endMs: number,
  opts: { priceDivisor?: number; tick?: number } = {},
): ScidProfileResult {
  const priceDivisor = opts.priceDivisor ?? 100
  const tick = opts.tick ?? 0.25
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < HEADER_SIZE + RECORD_SIZE) return { rows: [], trades: 0 }
    const count = Math.floor((size - HEADER_SIZE) / RECORD_SIZE)
    const first = lowerBound(fd, count, startMs)
    const last = lowerBound(fd, count, endMs)
    if (last <= first) return { rows: [], trades: 0 }

    const vol = new Map<number, number>()
    const ask = new Map<number, number>()
    const bid = new Map<number, number>()
    let trades = 0
    for (let i = first; i < last; i += CHUNK_RECORDS) {
      const n = Math.min(CHUNK_RECORDS, last - i)
      const buf = Buffer.alloc(n * RECORD_SIZE)
      readSync(fd, buf, 0, n * RECORD_SIZE, HEADER_SIZE + i * RECORD_SIZE)
      for (let k = 0; k < n; k++) {
        const off = k * RECORD_SIZE
        const total = buf.readUInt32LE(off + 28)
        if (total === 0) continue
        const t = Math.round(buf.readFloatLE(off + 20) / priceDivisor / tick)
        vol.set(t, (vol.get(t) ?? 0) + total)
        bid.set(t, (bid.get(t) ?? 0) + buf.readUInt32LE(off + 32))
        ask.set(t, (ask.get(t) ?? 0) + buf.readUInt32LE(off + 36))
        trades++
      }
    }
    if (vol.size === 0) return { rows: [], trades: 0 }

    let minT = Infinity
    let maxT = -Infinity
    for (const t of vol.keys()) { if (t < minT) minT = t; if (t > maxT) maxT = t }
    const rows: ProfileRow[] = []
    for (let t = minT; t <= maxT; t++) {
      rows.push({
        // Round away the binary tail: 7625.000000001 must read 7625.
        price: Math.round(t * tick * 1e6) / 1e6,
        volume: vol.get(t) ?? 0,
        ask: ask.get(t) ?? 0,
        bid: bid.get(t) ?? 0,
      })
    }
    return { rows, trades }
  } finally {
    closeSync(fd)
  }
}
