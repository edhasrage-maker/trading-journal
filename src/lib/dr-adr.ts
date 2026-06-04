/**
 * Compute DR_ADR (Daily Range as ratio of Average Daily Range) for the prep
 * page. DR is measured from 6:30 PT to 7:30 PT (the IB window) and divided by
 * the previously-saved market_context.adr.
 *
 * Source of 1-min bars: ohlcv_bars (populated by BarWatcher every ~3 min
 * during RTH, plus on-demand SCID imports). Returns nulls when bars aren't
 * yet available so the UI can render a skeleton instead of stale data.
 */

import { ptDateSodToUtcMs } from './pt-time'

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
