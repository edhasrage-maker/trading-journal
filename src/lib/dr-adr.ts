/**
 * DR/ADR — the day's realized range measured against the trader's Average
 * Daily Range. One definition, one unit, used by every surface that shows or
 * buckets it.
 *
 * NUMERATOR — the RTH session range SO FAR (06:30 PT to the last bar, capped
 * at the 13:00 close). This used to measure only the 06:30-07:30 Initial
 * Balance hour while `market_context.day_range` — the value the ledger and the
 * condition lookup both read — is the whole RTH range. The prep ledger's
 * "Range used" row falls back to this function whenever `day_range` is absent,
 * so one label was printing two different quantities depending on which path
 * happened to fire.
 *
 * UNIT — PERCENT, not a ratio. `condition_thresholds.DR_ADR` is cut in percent
 * (median 75.9, tertiles 62.4 / 96.2) because `condition-lookup-refresh` builds
 * it as (day_range / adr) x 100. The prep page was feeding the lookup a RATIO
 * (0.76), which is below every cut, so DR/ADR bucketed LOW/L on 100% of days —
 * one of the five lookup dimensions was pinned to the bottom bucket every
 * session. Ratios and percents must never share a field name again; the unit is
 * in this function's name.
 *
 * Source of 1-min bars: ohlcv_bars (populated by BarWatcher every ~3 min during
 * RTH, plus on-demand SCID imports). Returns nulls when bars aren't yet
 * available so the UI can render a skeleton instead of stale data.
 */

import { ptDateSodToUtcMs } from './pt-time'

export interface DrAdrResult {
  /** Realized RTH range so far, in points. */
  dr: number | null
  /** dr / adr as a PERCENT (75.9 = 75.9% of a normal day's range). */
  dr_adr_pct: number | null
  bar_count: number
  symbol_used: string | null
}

/** RTH window in seconds-of-day, PT: 06:30 to 13:00. */
const RTH_START_SOD = 6 * 3600 + 30 * 60
const RTH_END_SOD = 13 * 3600

/**
 * DR/ADR as a PERCENT — the single definition. `dayRange` and `adr` are both in
 * points and must be on the same basis (RTH range vs RTH ADR).
 */
export function drAdrPercent(
  dayRange: number | null | undefined,
  adr: number | null | undefined,
): number | null {
  const dr = dayRange == null ? null : Number(dayRange)
  const a = adr == null ? null : Number(adr)
  if (dr == null || a == null || !Number.isFinite(dr) || !Number.isFinite(a) || a <= 0) return null
  return (dr / a) * 100
}

export async function computeDrAdr(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  date: string,                       // YYYY-MM-DD
  symbol: string | null,              // e.g. "MNQM6.CME"; null skips
  adr: number | null,                 // from market_context.adr
): Promise<DrAdrResult> {
  if (!symbol || !adr || adr <= 0) {
    return { dr: null, dr_adr_pct: null, bar_count: 0, symbol_used: symbol }
  }

  const startMs = ptDateSodToUtcMs(date, RTH_START_SOD)
  const endMs = ptDateSodToUtcMs(date, RTH_END_SOD)
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
    return { dr: null, dr_adr_pct: null, bar_count: 0, symbol_used: symbol }
  }

  let hi = -Infinity
  let lo = Infinity
  for (const b of bars) {
    if (b.high > hi) hi = b.high
    if (b.low < lo) lo = b.low
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) {
    return { dr: null, dr_adr_pct: null, bar_count: bars.length, symbol_used: symbol }
  }
  const dr = hi - lo
  return {
    dr,
    dr_adr_pct: drAdrPercent(dr, adr),
    bar_count: bars.length,
    symbol_used: symbol,
  }
}
