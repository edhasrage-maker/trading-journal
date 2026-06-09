import type { OhlcBar } from './load'

const FIVE_MIN_MS = 5 * 60 * 1000

export type Range1m = { start: number; end: number } // half-open; bars1m[start..end-1]

// Roll 1-minute OHLC bars into 5-minute OHLC bars, aligned to wall-clock 5-minute boundaries.
// Also returns the 1m index range that fed each 5m bar so callers can walk sub-bars.
export function aggregate1mTo5m(bars1m: OhlcBar[]): { bars5m: OhlcBar[]; ranges: Range1m[] } {
  if (bars1m.length === 0) return { bars5m: [], ranges: [] }
  const bars5m: OhlcBar[] = []
  const ranges: Range1m[] = []
  let bucket: OhlcBar | null = null
  let bucketKey = -1
  let bucketStart = 0
  for (let i = 0; i < bars1m.length; i++) {
    const b = bars1m[i]
    const k = Math.floor(new Date(b.ts).getTime() / FIVE_MIN_MS)
    if (k !== bucketKey) {
      if (bucket) {
        bars5m.push(bucket)
        ranges.push({ start: bucketStart, end: i })
      }
      bucketKey = k
      bucketStart = i
      bucket = {
        ts: new Date(k * FIVE_MIN_MS).toISOString(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }
    } else {
      if (b.high > bucket!.high) bucket!.high = b.high
      if (b.low < bucket!.low) bucket!.low = b.low
      bucket!.close = b.close
    }
  }
  if (bucket) {
    bars5m.push(bucket)
    ranges.push({ start: bucketStart, end: bars1m.length })
  }
  return { bars5m, ranges }
}

const PT_HM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
})

const PT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

// True if the bar's timestamp falls in RTH (06:30:00 to 13:00:00 PT, DST-aware).
export function isRTH(tsIso: string): boolean {
  const d = new Date(tsIso)
  const parts = PT_HM.formatToParts(d)
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10)
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10)
  const mins = h * 60 + m
  return mins >= (6 * 60 + 30) && mins < (13 * 60)
}

// YYYY-MM-DD in Pacific time — used to group bars by RTH session day.
export function ptDateKey(tsIso: string): string {
  return PT_DATE.format(new Date(tsIso))
}
