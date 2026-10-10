/**
 * Pacific-time wall clock for the order-flow workspace.
 *
 * Charts here run on a "PT clock": PT wall-clock time expressed as if it were
 * UTC epoch time (so 09:30 PT is the epoch value of 09:30Z on that date). The
 * reference server ships every timestamp this way, so the chart axis reads PT
 * without any timezone handling in the browser, and session arithmetic
 * (06:30 open, 15:00 trading-day roll) becomes plain modular arithmetic.
 *
 *   ptMs  : PT wall clock, milliseconds, "as if UTC"
 *   utcMs : a real instant
 */

const PT_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

const HOUR = 3_600_000
const DAY = 86_400_000

// PT's UTC offset only changes on an hour boundary, so it's cached per UTC hour.
const offsetCache = new Map<number, number>()

/** PT offset from UTC (ms; -7h or -8h) in effect at a real instant. */
export function ptOffsetMs(utcMs: number): number {
  const h = Math.floor(utcMs / HOUR)
  const hit = offsetCache.get(h)
  if (hit !== undefined) return hit
  const m: Record<string, string> = {}
  for (const p of PT_PARTS.formatToParts(new Date(h * HOUR))) m[p.type] = p.value
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second)
  const off = asUtc - h * HOUR
  offsetCache.set(h, off)
  return off
}

/** Real instant → PT clock. */
export function utcToPtMs(utcMs: number): number {
  return utcMs + ptOffsetMs(utcMs)
}

/**
 * PT clock → real instant, with pandas'
 * tz_localize('America/Los_Angeles', ambiguous=True, nonexistent='shift_forward'):
 * a repeated wall time (November fall-back) resolves to the DAYLIGHT reading,
 * and a skipped one (March spring-forward) moves to the end of the gap.
 */
export function ptToUtcMs(ptMs: number): number {
  const pdt = ptMs + 7 * HOUR
  const pst = ptMs + 8 * HOUR
  const pdtOk = utcToPtMs(pdt) === ptMs
  if (pdtOk) return pdt
  if (utcToPtMs(pst) === ptMs) return pst
  // In the spring-forward gap: the first real instant after it. The gap is the
  // hour 02:00-03:00 PT; 03:00 PDT is 10:00Z.
  const day = Math.floor(ptMs / DAY) * DAY
  return day + 10 * HOUR
}

/** 'YYYY-MM-DD' of a PT-clock instant. */
export function ptDate(ptMs: number): string {
  return new Date(Math.floor(ptMs / DAY) * DAY).toISOString().slice(0, 10)
}

/** PT-clock midnight of a 'YYYY-MM-DD'. */
export function ptMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

/** Seconds since PT midnight. */
export function ptSecondOfDay(ptMs: number): number {
  return Math.floor((ptMs - Math.floor(ptMs / DAY) * DAY) / 1000)
}

/**
 * CME equity-index trading date of a PT-clock instant: the session that opens
 * at 15:00 PT belongs to the NEXT calendar day (Sunday evening trades as
 * Monday). Matches the reference bars' `tdate` on every one of ~580k minutes.
 */
export function tradingDate(ptMs: number): string {
  return ptDate(ptMs + 9 * HOUR)
}

/** 'HH:MM:SS' of a PT-clock instant. */
export function ptClock(ptMs: number): string {
  return new Date(ptMs).toISOString().slice(11, 19)
}

export const PT_HOUR_MS = HOUR
export const PT_DAY_MS = DAY
