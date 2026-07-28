import { openSync, readSync, fstatSync, closeSync } from 'fs'

/**
 * Delta-by-price (footprint) reader for Sierra Chart .scid tick files.
 *
 * Companion to `scid-reader.ts`, which only surfaces trade PRICE. Delta needs
 * the two volume-split fields that reader ignores:
 *
 *   Record: 40 bytes (see scid-reader.ts for the full layout)
 *     [20] float   Close       trade price, stored scaled (×100 for ES/NQ)
 *     [24] uint32  NumTrades
 *     [28] uint32  TotalVolume
 *     [32] uint32  BidVolume   contracts traded at the bid  (aggressive SELL)
 *     [36] uint32  AskVolume   contracts traded at the ask  (aggressive BUY)
 *
 *   delta = AskVolume − BidVolume
 *
 * WHY THIS IS A SEPARATE FILE, not a function added to scid-reader.ts:
 * ROW HEIGHT is the whole ballgame. A footprint chart draws 1-point rows on ES;
 * the raw ticks are 0.25. Binning at the tick makes a single large seller look
 * like four unremarkable ones — the same session that reads "−1,465 into the
 * zone" at 1-point rows reads as noise at 0.25. Aggregation granularity is not
 * a detail of the reader, it is the measurement, so it is an explicit required
 * argument here rather than an optional knob bolted onto a price reader.
 *
 * Binning is done in SCALED INTEGER space (the file's own units) so that row
 * boundaries are exact. Doing `Math.floor(7467.75 / 1)` on IEEE doubles that
 * came out of a float32 read puts ticks in the wrong row often enough to move
 * a row total by a few hundred contracts.
 *
 * One pass over the file yields BOTH the price rows and a 1-minute bar series.
 * The detector needs the bars for its did-price-hold-after check, and these
 * files run to gigabytes — re-reading to get them is the single most expensive
 * thing this module could do.
 */

const HEADER_SIZE = 56
const RECORD_SIZE = 40
// Microseconds between SCID epoch (1899-12-30) and Unix epoch (1970-01-01).
const SCID_EPOCH_OFFSET_US = 25569 * 86400 * 1_000_000

/** One price row of the footprint. Covers `[price, price + rowHeight)`. */
export interface DeltaRow {
  /** Low edge of the row, in price units. */
  price: number
  /** AskVolume − BidVolume summed over the row. Negative = net aggressive selling. */
  delta: number
  /** TotalVolume summed over the row. */
  volume: number
  /** NumTrades summed over the row. */
  trades: number
  /** First and last timestamp (ms) that traded in this row. */
  firstMs: number
  lastMs: number
}

/** Minimal OHLC-less bar — the detector only needs the excursion and the close. */
export interface DeltaBar {
  /** Minute-aligned epoch ms. */
  ts: number
  high: number
  low: number
  close: number
}

export interface DeltaByPriceResult {
  /** Ascending by price. Only rows that actually traded are present. */
  rows: DeltaRow[]
  /** Ascending by ts. Same window as `rows`, for the hold check. */
  bars: DeltaBar[]
  /** Net delta over the whole window. */
  sessionDelta: number
  /** Total contracts over the whole window. */
  sessionVolume: number
  /** Records consumed (after dropping non-price marker records). */
  tickCount: number
  /** Overall span of the FILE, so callers can say "no data for this day". */
  fileFirstMs: number | null
  fileLastMs: number | null
}

export interface ReadDeltaOptions {
  /** Divisor for the stored price. 100 for ES/NQ/MNQ. */
  priceDivisor?: number
  /**
   * Row height in PRICE units — 1 for ES, ~5 for NQ. Required: there is no
   * defensible default, and picking one silently is the exact failure this
   * module exists to prevent.
   */
  rowHeight: number
  /** Bar bucket for the returned series. Default 60s. */
  bucketMs?: number
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
 * Read the delta-by-price profile for `[startMs, endMs)`, binned to
 * `opts.rowHeight` price rows, plus a bar series over the same window.
 *
 * Records are time-sorted and fixed-size, so we binary-search to the window
 * rather than scanning a multi-GB file from the start.
 */
export function readDeltaByPrice(
  path: string,
  startMs: number,
  endMs: number,
  opts: ReadDeltaOptions,
): DeltaByPriceResult {
  const priceDivisor = opts.priceDivisor ?? 100
  const bucketMs = opts.bucketMs ?? 60_000
  if (!(opts.rowHeight > 0)) {
    throw new Error(`readDeltaByPrice: rowHeight must be > 0 (got ${opts.rowHeight})`)
  }
  // Row width in the file's own scaled-integer units, so binning is exact.
  const rowUnit = Math.round(opts.rowHeight * priceDivisor)
  if (rowUnit < 1) {
    throw new Error(
      `readDeltaByPrice: rowHeight ${opts.rowHeight} is finer than the stored price resolution`,
    )
  }

  const empty: DeltaByPriceResult = {
    rows: [], bars: [], sessionDelta: 0, sessionVolume: 0,
    tickCount: 0, fileFirstMs: null, fileLastMs: null,
  }

  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < HEADER_SIZE + RECORD_SIZE) return empty

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
    if (recCount === 0) return { ...empty, fileFirstMs, fileLastMs }

    // Keyed by the row's scaled-integer low edge.
    const rows = new Map<number, DeltaRow>()
    const bars = new Map<number, DeltaBar>()
    let sessionDelta = 0
    let sessionVolume = 0
    let tickCount = 0

    let idx = findFirstAtOrAfter(fd, recCount, startMs)
    const CHUNK = 8192
    const chunkBuf = Buffer.alloc(CHUNK * RECORD_SIZE)

    outer: while (idx < recCount) {
      const toRead = Math.min(CHUNK, recCount - idx)
      readSync(fd, chunkBuf, 0, toRead * RECORD_SIZE, HEADER_SIZE + idx * RECORD_SIZE)
      for (let i = 0; i < toRead; i++) {
        const off = i * RECORD_SIZE
        const micros = Number(chunkBuf.readBigInt64LE(off))
        const tMs = (micros - SCID_EPOCH_OFFSET_US) / 1000
        if (tMs >= endMs) break outer

        const rawPrice = chunkBuf.readFloatLE(off + 20)
        // Session-boundary marker records carry no price (see scid-reader.ts).
        if (!Number.isFinite(rawPrice) || rawPrice <= 0) continue

        const trades = chunkBuf.readUInt32LE(off + 24)
        const volume = chunkBuf.readUInt32LE(off + 28)
        const bidVol = chunkBuf.readUInt32LE(off + 32)
        const askVol = chunkBuf.readUInt32LE(off + 36)
        const delta = askVol - bidVol

        // float32 → double leaves values like 746699.9999; round to the file's
        // integer grid BEFORE flooring or ticks land one row low.
        const priceInt = Math.round(rawPrice)
        const rowInt = Math.floor(priceInt / rowUnit) * rowUnit

        const existing = rows.get(rowInt)
        if (!existing) {
          rows.set(rowInt, {
            price: rowInt / priceDivisor,
            delta, volume, trades,
            firstMs: tMs, lastMs: tMs,
          })
        } else {
          existing.delta += delta
          existing.volume += volume
          existing.trades += trades
          if (tMs < existing.firstMs) existing.firstMs = tMs
          if (tMs > existing.lastMs) existing.lastMs = tMs
        }

        const px = priceInt / priceDivisor
        const bucket = Math.floor(tMs / bucketMs) * bucketMs
        const bar = bars.get(bucket)
        if (!bar) bars.set(bucket, { ts: bucket, high: px, low: px, close: px })
        else {
          if (px > bar.high) bar.high = px
          if (px < bar.low) bar.low = px
          bar.close = px
        }

        sessionDelta += delta
        sessionVolume += volume
        tickCount++
      }
      idx += toRead
    }

    return {
      rows: Array.from(rows.values()).sort((a, b) => a.price - b.price),
      bars: Array.from(bars.values()).sort((a, b) => a.ts - b.ts),
      sessionDelta,
      sessionVolume,
      tickCount,
      fileFirstMs,
      fileLastMs,
    }
  } finally {
    closeSync(fd)
  }
}
