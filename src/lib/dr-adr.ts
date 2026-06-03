/**
 * Compute DR_ADR (Daily Range as ratio of Average Daily Range) for the prep
 * page. DR is measured from 6:30 PT to 7:30 PT (the IB window) and divided by
 * the previously-saved market_context.adr.
 *
 * Source of 1-min bars: ohlcv_bars (populated by BarWatcher every ~3 min
 * during RTH, plus on-demand SCID imports). Returns nulls when bars aren't
 * yet available so the UI can render a skeleton instead of stale data.
 */

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** Convert "HH:MM:SS PT on YYYY-MM-DD" to UTC milliseconds, DST-aware. We try
 *  both UTC-7 (PDT) and UTC-8 (PST) and pick the one where the round-trip
 *  through Intl returns the same date + seconds-of-day. */
function ptDateSodToUtcMs(dateStr: string, secondsOfDay: number): number {
  const candidates = [-7, -8]
  for (const offsetHrs of candidates) {
    const ms = Date.parse(`${dateStr}T00:00:00Z`) - offsetHrs * 3_600_000 + secondsOfDay * 1000
    const parts = PT_FMT.formatToParts(new Date(ms))
    const m: Record<string, string> = {}
    for (const p of parts) m[p.type] = p.value
    const ptDate = `${m.year}-${m.month}-${m.day}`
    const ptSod = Number(m.hour) * 3600 + Number(m.minute) * 60 + Number(m.second)
    if (ptDate === dateStr && ptSod === secondsOfDay) return ms
  }
  // Fallback to PDT if neither matched (shouldn't happen on real dates).
  return Date.parse(`${dateStr}T00:00:00Z`) + (7 * 3600 + secondsOfDay) * 1000
}

export interface DrAdrResult {
  dr: number | null
  dr_adr: number | null
  bar_count: number
  symbol_used: string | null
}

/** IB window in seconds-of-day, PT: 06:30 to 07:30. */
const IB_START_SOD = 6 * 3600 + 30 * 60
const IB_END_SOD = 7 * 3600 + 30 * 60

export async function computeDrAdr(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  date: string,                       // YYYY-MM-DD
  symbol: string | null,              // e.g. "MNQM6.CME"; null skips
  adr: number | null,                 // from market_context.adr
): Promise<DrAdrResult> {
  if (!symbol || !adr || adr <= 0) {
    return { dr: null, dr_adr: null, bar_count: 0, symbol_used: symbol }
  }

  const startMs = ptDateSodToUtcMs(date, IB_START_SOD)
  const endMs = ptDateSodToUtcMs(date, IB_END_SOD)
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(endMs).toISOString()

  const { data: bars } = await supabase
    .from('ohlcv_bars')
    .select('high, low')
    .eq('symbol', symbol)
    .gte('ts', startIso)
    .lt('ts', endIso)
    .order('ts') as { data: Array<{ high: number; low: number }> | null }

  if (!bars || bars.length === 0) {
    return { dr: null, dr_adr: null, bar_count: 0, symbol_used: symbol }
  }

  let hi = -Infinity
  let lo = Infinity
  for (const b of bars) {
    if (b.high > hi) hi = b.high
    if (b.low < lo) lo = b.low
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    return { dr: null, dr_adr: null, bar_count: bars.length, symbol_used: symbol }
  }
  const dr = hi - lo
  return {
    dr,
    dr_adr: dr / adr,
    bar_count: bars.length,
    symbol_used: symbol,
  }
}
