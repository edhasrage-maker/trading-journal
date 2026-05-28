import { openSync, readSync, fstatSync, closeSync } from 'fs'

/**
 * Reader for Sierra Chart Intraday Data files (.scid).
 *
 * Format (verified against live NQM6.CME.scid, 2026-05):
 *   Header: 56 bytes
 *     [0]  uint32  FileTypeUniqueHeaderID  "SCID"
 *     [4]  uint32  HeaderSize              56
 *     [8]  uint32  RecordSize              40
 *     [12] uint16  Version                 1
 *     ...reserved...
 *   Record: 40 bytes, time-ascending, fixed size
 *     [0]  int64   DateTime   microseconds since 1899-12-30 00:00:00 UTC
 *     [8]  float   Open       (0 for tick records)
 *     [12] float   High       (ask at the trade, for tick data)
 *     [16] float   Low        (bid at the trade, for tick data)
 *     [20] float   Close      (trade price)
 *     [24] uint32  NumTrades
 *     [28] uint32  TotalVolume
 *     [32] uint32  BidVolume
 *     [36] uint32  AskVolume
 *
 * The file is tick-by-tick (one record per trade). We aggregate the Close
 * (trade price) into N-minute OHLCV bars. Prices are stored scaled (×100 for
 * NQ/MNQ — 2993550 == 29935.50); the caller passes the divisor.
 *
 * Records are time-sorted and fixed-size, so we binary-search to the target
 * day rather than scanning the whole (often multi-GB) file.
 */

const HEADER_SIZE = 56
const RECORD_SIZE = 40
// Microseconds between SCID epoch (1899-12-30) and Unix epoch (1970-01-01).
const SCID_EPOCH_OFFSET_US = 25569 * 86400 * 1_000_000

export interface OneMinBar {
  ts: string  // ISO-8601, minute-aligned (UTC)
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface ScidReadResult {
  bars: OneMinBar[]
  tickCount: number
  fileFirstMs: number | null
  fileLastMs: number | null
}

function recordTimeMs(fd: number, index: number): number {
  const buf = Buffer.alloc(8)
  readSync(fd, buf, 0, 8, HEADER_SIZE + index * RECORD_SIZE)
  const micros = Number(buf.readBigInt64LE(0))
  return (micros - SCID_EPOCH_OFFSET_US) / 1000
}

/** First record index whose time is >= targetMs (lower_bound). */
function findFirstAtOrAfter(fd: number, recCount: number, targetMs: number): number {
  let lo = 0
  let hi = recCount
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (recordTimeMs(fd, mid) < targetMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Read bars in [startMs, endMs) from a .scid file, aggregated to `bucketMs`
 * buckets (default 60s = 1-minute). Returns the bars plus the file's overall
 * time span (useful for "no data for this day" messaging).
 */
export function readScidBars(
  path: string,
  startMs: number,
  endMs: number,
  opts: { priceDivisor?: number; bucketMs?: number } = {},
): ScidReadResult {
  const priceDivisor = opts.priceDivisor ?? 100
  const bucketMs = opts.bucketMs ?? 60_000

  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < HEADER_SIZE + RECORD_SIZE) {
      return { bars: [], tickCount: 0, fileFirstMs: null, fileLastMs: null }
    }

    // Validate header magic
    const hdr = Buffer.alloc(HEADER_SIZE)
    readSync(fd, hdr, 0, HEADER_SIZE, 0)
    if (hdr.toString('ascii', 0, 4) !== 'SCID') {
      throw new Error('Not a SCID file (bad magic header)')
    }
    const recordSize = hdr.readUInt32LE(8) || RECORD_SIZE
    if (recordSize !== RECORD_SIZE) {
      throw new Error(`Unexpected SCID record size ${recordSize} (expected ${RECORD_SIZE})`)
    }

    const recCount = Math.floor((size - HEADER_SIZE) / RECORD_SIZE)
    const fileFirstMs = recCount > 0 ? recordTimeMs(fd, 0) : null
    const fileLastMs = recCount > 0 ? recordTimeMs(fd, recCount - 1) : null

    const startIdx = findFirstAtOrAfter(fd, recCount, startMs)

    const bars = new Map<number, OneMinBar>()
    const CHUNK = 8192
    const chunkBuf = Buffer.alloc(CHUNK * RECORD_SIZE)
    let idx = startIdx
    let tickCount = 0

    outer: while (idx < recCount) {
      const toRead = Math.min(CHUNK, recCount - idx)
      readSync(fd, chunkBuf, 0, toRead * RECORD_SIZE, HEADER_SIZE + idx * RECORD_SIZE)
      for (let i = 0; i < toRead; i++) {
        const off = i * RECORD_SIZE
        const micros = Number(chunkBuf.readBigInt64LE(off))
        const tMs = (micros - SCID_EPOCH_OFFSET_US) / 1000
        if (tMs >= endMs) break outer
        const close = chunkBuf.readFloatLE(off + 20) / priceDivisor
        const vol = chunkBuf.readUInt32LE(off + 28)
        const bucket = Math.floor(tMs / bucketMs) * bucketMs
        const bar = bars.get(bucket)
        if (!bar) {
          bars.set(bucket, { ts: new Date(bucket).toISOString(), open: close, high: close, low: close, close, volume: vol })
        } else {
          if (close > bar.high) bar.high = close
          if (close < bar.low) bar.low = close
          bar.close = close
          bar.volume += vol
        }
        tickCount++
      }
      idx += toRead
    }

    const sorted = Array.from(bars.values()).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    return { bars: sorted, tickCount, fileFirstMs, fileLastMs }
  } finally {
    closeSync(fd)
  }
}
