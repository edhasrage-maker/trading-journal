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
