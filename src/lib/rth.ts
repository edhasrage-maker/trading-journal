/**
 * RTH (Regular Trading Hours) helpers, anchored to America/Los_Angeles — the
 * journal's display timezone. RTH for the US equity-index session is
 * 06:30–13:00 PT. Used to flag Globex/overnight (GBX) trades.
 *
 * Deliberately TZ-explicit (Intl with an explicit timeZone), NOT process-local
 * `new Date(...)`, so it behaves identically on any machine or runtime — see
 * the timezone lesson from the SC importer.
 */

const RTH_OPEN_MIN = 6 * 60 + 30   // 06:30 PT
const RTH_CLOSE_MIN = 13 * 60      // 13:00 PT

/** Minutes since PT midnight for an instant (DST-aware). */
function ptMinuteOfDay(ms: number): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value
  const h = o.hour === '24' ? 0 : parseInt(o.hour)
  return h * 60 + parseInt(o.minute)
}

/** True if the timestamp's PT wall-clock falls within RTH (06:30–13:00 PT). */
export function isWithinRth(ts: string | number): boolean {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(ms)) return false
  const m = ptMinuteOfDay(ms)
  return m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN
}

/** True if the timestamp is outside RTH (Globex / overnight). Returns false for
 *  unparseable input, so callers never tag a trade with a bad timestamp. */
export function isOutsideRth(ts: string | number): boolean {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts)
  if (!Number.isFinite(ms)) return false
  return !isWithinRth(ms)
}

/** PT (America/Los_Angeles) calendar date of an instant as a YYYY-MM-DD string.
 *  en-CA formats ISO-style (YYYY-MM-DD), so no manual assembly needed. */
function ptDateString(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms))
}

/** PT offset from UTC (ms) at an instant — e.g. -7h during PDT, -8h during PST.
 *  Derived by diffing the same instant rendered in UTC vs PT wall-clock. */
function ptOffsetMs(ms: number): number {
  const d = new Date(ms)
  const asUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  const asPt = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).getTime()
  return asPt - asUtc
}

/** UTC-ms of the RTH close (13:00 PT) on a YYYY-MM-DD date, DST-aware. NaN for
 *  an unparseable date. */
export function rthCloseMs(dateStr: string): number {
  const guess = Date.parse(`${dateStr}T13:00:00Z`) // 13:00 "UTC" on that date
  if (!Number.isFinite(guess)) return NaN
  // 13:00 PT = 13:00 UTC shifted back by the PT offset at that instant.
  return guess - ptOffsetMs(guess)
}

/** True if `dateStr` (YYYY-MM-DD) is the current PT calendar date. */
export function isTodayPt(dateStr: string): boolean {
  return ptDateString(Date.now()) === dateStr
}

/** True if the RTH close for `dateStr` is still in the future (session not yet
 *  closed by the clock). Past dates → false; today before 13:00 PT → true. */
export function isBeforeRthClose(dateStr: string): boolean {
  const close = rthCloseMs(dateStr)
  return Number.isFinite(close) && Date.now() < close
}
