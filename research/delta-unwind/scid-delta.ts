import { openSync, readSync, fstatSync, closeSync } from 'fs'

/**
 * Delta-aware reader for Sierra Chart Intraday (.scid) files.
 *
 * Same binary format as src/lib/scid-reader.ts, but in addition to aggregating
 * trade price into OHLCV bars it reconstructs the per-bar order-flow delta that
 * the "Delta Unwind Stars" study consumes from a Numbers Bars Calculated Values
 * study:
 *
 *   deltaClose = sum over the bar of (AskVolume - BidVolume)        [signed]
 *   maxDelta   = highest the *running* cumulative delta reached      [>= 0]
 *   minDelta   = lowest  the *running* cumulative delta reached      [<= 0]
 *
 * Record layout (40 bytes, time-ascending):
 *   [0]  int64  DateTime  microseconds since 1899-12-30 UTC
 *   [20] float  Close     trade price (0 / negative on session-marker records)
 *   [28] uint32 TotalVolume
 *   [32] uint32 BidVolume  (volume that hit the bid = sellers)
 *   [36] uint32 AskVolume  (volume that lifted the ask = buyers)
 *
 * FIDELITY NOTES — validate against live Numbers Bars before trusting figures:
 *  1. The running delta line is seeded at 0 at each bar open, so min/max always
 *     bracket 0 (a purely one-sided bar has the opposite extreme == 0). This is
 *     the standard Numbers Bars interpretation; if Sierra is configured to seed
 *     from the first tick instead, one-sided bars will differ slightly.
 *  2. We apply each record's NET (ask-bid) as a single step. If a record
 *     aggregates multiple trades, the intrabar ordering within that record is
 *     lost, so min/max can be marginally understated vs a pure tick stream.
 *  3. Aggressor classification is whatever was captured into the .scid; we do
 *     not reclassify. This matches what Numbers Bars sees on the same data.
 */

const HEADER_SIZE = 56
const RECORD_SIZE = 40
const SCID_EPOCH_OFFSET_US = 25569 * 86400 * 1_000_000

export interface DeltaBar {
  ts: string // ISO-8601, bucket-aligned (UTC)
  open: number
  high: number
  low: number
  close: number
  volume: number
  deltaClose: number // net delta at bar close (signed)
  minDelta: number // lowest running cumulative delta (<= 0)
  maxDelta: number // highest running cumulative delta (>= 0)
}

export interface ScidDeltaResult {
  bars: DeltaBar[]
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

type DeltaAccum = {
  bar: DeltaBar
  running: number // running cumulative delta within the bar
}

/**
 * Read delta bars in [startMs, endMs) from a .scid file, bucketed to `bucketMs`
 * (default 60s = 1-minute). Reconstructs per-bar delta from BidVolume/AskVolume.
 */
export function readScidDeltaBars(
  path: string,
  startMs: number,
  endMs: number,
  opts: { priceDivisor?: number; bucketMs?: number } = {},
): ScidDeltaResult {
  const priceDivisor = opts.priceDivisor ?? 100
  const bucketMs = opts.bucketMs ?? 60_000

  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < HEADER_SIZE + RECORD_SIZE) {
      return { bars: [], tickCount: 0, fileFirstMs: null, fileLastMs: null }
    }

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

    const buckets = new Map<number, DeltaAccum>()
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
        // Skip session-boundary marker records (price 0 / non-finite): no real
        // trade, and their volume fields are not meaningful delta.
        if (!Number.isFinite(close) || close <= 0) continue
        const vol = chunkBuf.readUInt32LE(off + 28)
        const bidVol = chunkBuf.readUInt32LE(off + 32)
        const askVol = chunkBuf.readUInt32LE(off + 36)
        const tickDelta = askVol - bidVol

        const bucketKey = Math.floor(tMs / bucketMs) * bucketMs
        let acc = buckets.get(bucketKey)
        if (!acc) {
          // Seed the running delta line at 0; the first tick moves it off 0.
          const running = tickDelta
          acc = {
            running,
            bar: {
              ts: new Date(bucketKey).toISOString(),
              open: close, high: close, low: close, close,
              volume: vol,
              deltaClose: running,
              minDelta: Math.min(0, running),
              maxDelta: Math.max(0, running),
            },
          }
          buckets.set(bucketKey, acc)
        } else {
          const b = acc.bar
          if (close > b.high) b.high = close
          if (close < b.low) b.low = close
          b.close = close
          b.volume += vol
          acc.running += tickDelta
          if (acc.running > b.maxDelta) b.maxDelta = acc.running
          if (acc.running < b.minDelta) b.minDelta = acc.running
          b.deltaClose = acc.running
        }
        tickCount++
      }
      idx += toRead
    }

    const bars = Array.from(buckets.values())
      .map(a => a.bar)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    return { bars, tickCount, fileFirstMs, fileLastMs }
  } finally {
    closeSync(fd)
  }
}
