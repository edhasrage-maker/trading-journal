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
