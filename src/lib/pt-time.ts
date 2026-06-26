/**
 * PT timezone helpers, DST-aware via Intl. Used by anything that needs to
 * convert "HH:MM:SS PT on YYYY-MM-DD" → UTC ms (or vice versa) without
 * pulling in date-fns-tz.
 */

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

const PT_DATE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
})

/**
 * The current calendar date in America/Los_Angeles as "YYYY-MM-DD", regardless
 * of the host machine's OS timezone. Use this for "today" links (prep / intraday
 * / EOD) instead of `format(new Date(), 'yyyy-MM-dd')`: the latter trusts the
 * machine clock's local timezone, so a second machine whose OS TZ is mis-set
 * (or any host running in UTC) can file today's prep under the wrong calendar
 * day. This app's trading day is the PT session date, so anchor to PT directly.
 */
export function todayPT(date: Date = new Date()): string {
  const m: Record<string, string> = {}
  for (const p of PT_DATE_FMT.formatToParts(date)) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

/** Convert "HH:MM:SS PT on YYYY-MM-DD" to UTC milliseconds. Tries both UTC-7
 *  (PDT) and UTC-8 (PST) and picks the one whose round-trip through Intl
 *  matches the requested PT date + seconds-of-day. Falls back to PDT on the
 *  pathological case where neither matches (shouldn't happen on real dates). */
export function ptDateSodToUtcMs(dateStr: string, secondsOfDay: number): number {
  for (const offsetHrs of [-7, -8]) {
    const ms = Date.parse(`${dateStr}T00:00:00Z`) - offsetHrs * 3_600_000 + secondsOfDay * 1000
    const parts = PT_FMT.formatToParts(new Date(ms))
    const m: Record<string, string> = {}
    for (const p of parts) m[p.type] = p.value
    const ptDate = `${m.year}-${m.month}-${m.day}`
    const ptSod = Number(m.hour) * 3600 + Number(m.minute) * 60 + Number(m.second)
    if (ptDate === dateStr && ptSod === secondsOfDay) return ms
  }
  return Date.parse(`${dateStr}T00:00:00Z`) + (7 * 3600 + secondsOfDay) * 1000
}

/**
 * UTC bar-fetch window covering the FULL PT trading session for a journal date.
 *
 * The naive `[${date}T00:00:00Z, ${date}T23:59:59Z]` UTC-day window silently
 * drops the post-RTH / overnight (GBX) hours: a trade entered in the PT evening
 * (e.g. 18:00 PT) lands in the EARLY hours of the *next* UTC day, so its bars
 * fall outside that window — leaving GBX trades with no bars for MFE/capture/ATR
 * and no candles on the LiveChart. Anchoring both bounds to the PT calendar day
 * (00:00:00 → 23:59:59 PT, DST-exact) includes the evening session while staying
 * tight enough to avoid bleeding into the NEXT session's RTH.
 */
export function sessionUtcWindow(date: string): {
  start: string; end: string; startMs: number; endMs: number
} {
  const startMs = ptDateSodToUtcMs(date, 0)               // 00:00:00 PT
  const endMs = ptDateSodToUtcMs(date, 24 * 3600 - 1)     // 23:59:59 PT
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
  }
}
