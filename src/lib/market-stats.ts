/**
 * Auto-compute Market Context stats from ohlcv_bars when they're missing.
 *
 * - ATR-10 (1m): Wilder's ATR over the latest 10 closed 1-min bars at 07:30
 *   PT on the prep date. Self-contained — just today's bars.
 * - ADR: average of (high - low) over the cash session (06:30-13:00 PT) on
 *   each available prior trading day, up to 10 days back. Returns null if
 *   fewer than 3 days are available (anything less wouldn't be meaningful).
 *   Adds a `samples` count so the UI can flag "computed from N days, not 10".
 * - RVOL: NOT auto-computed here — convention (% vs ratio) and 10-day window
 *   semantics need to be confirmed with the user first.
 */

import { ptDateSodToUtcMs } from './pt-time'

const RTH_START_SOD = 6 * 3600 + 30 * 60   // 06:30 PT
const RTH_END_SOD   = 13 * 3600            // 13:00 PT
const IB_END_SOD    = 7 * 3600 + 30 * 60   // 07:30 PT (read ATR here on prep day)

export interface AdrResult {
  adr: number | null
  samples: number          // how many trading days went into the average
}

export interface Atr1mResult {
  atr_1m: number | null
  // True when the value comes from a full 10-bar warmup; false when the bar
  // count was short (e.g. prep run before 07:30 PT or sparse import).
  full_warmup: boolean
}

/** Wilder's ATR-10 on 1-minute bars at the prep-day's 07:30 PT cutoff. */
export async function computeAtr1m(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  symbol: string,
  date: string,                            // YYYY-MM-DD
): Promise<Atr1mResult> {
  const cutoffMs = ptDateSodToUtcMs(date, IB_END_SOD)
  // Need 11 bars to compute 10 true ranges (TR uses prev close). Pull 30 to be
  // safe for sparse data, then take the most recent 11 that close <= cutoff.
  const lookbackMs = cutoffMs - 60 * 60 * 1000  // 1h back
  const { data: bars } = await supabase
    .from('ohlcv_bars')
    .select('ts, high, low, close')
    .eq('symbol', symbol)
    .gte('ts', new Date(lookbackMs).toISOString())
    .lt('ts', new Date(cutoffMs).toISOString())
    .order('ts') as { data: Array<{ ts: string; high: number; low: number; close: number }> | null }

  if (!bars || bars.length < 2) return { atr_1m: null, full_warmup: false }

  // Compute true ranges; we need at least 1 prev close, so start at i=1.
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1]
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prev.close),
      Math.abs(b.low - prev.close),
    )
    trs.push(tr)
  }
  if (trs.length === 0) return { atr_1m: null, full_warmup: false }

  // Wilder: ATR_n = (ATR_{n-1} * (N-1) + TR_n) / N, with seed = simple avg of
  // first N TRs. Use N=10. If we have <10, fall back to simple average of all
  // available TRs and flag full_warmup=false.
  const N = 10
  if (trs.length < N) {
    const avg = trs.reduce((s, v) => s + v, 0) / trs.length
    return { atr_1m: avg, full_warmup: false }
  }
  let atr = trs.slice(0, N).reduce((s, v) => s + v, 0) / N
  for (let i = N; i < trs.length; i++) {
    atr = (atr * (N - 1) + trs[i]) / N
  }
  return { atr_1m: atr, full_warmup: true }
}

/** Average Daily Range over the last N (default 10) cash sessions ending the
 *  day BEFORE the prep date — historical, doesn't include today's incomplete
 *  data. Returns null when fewer than 3 days are available. */
export async function computeAdr(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  symbol: string,
  date: string,
  lookbackDays = 10,
): Promise<AdrResult> {
  // Pull a wide window of bars (cash session only, all priors) and bucket by
  // PT calendar date. The window is `lookbackDays * 2` calendar days back to
  // cover weekends/holidays. lookbackDays × ~1440 bars/day blows past
  // Supabase's 1000-row default, so paginate.
  const endIso = new Date(ptDateSodToUtcMs(date, RTH_START_SOD)).toISOString()
  const startIso = new Date(ptDateSodToUtcMs(date, RTH_START_SOD) - lookbackDays * 2 * 86_400_000).toISOString()

  const PAGE = 1000
  const bars: Array<{ ts: string; high: number; low: number }> = []
  // Cap at 30 pages = 30,000 bars (~20 calendar days fully covered).
  for (let p = 0; p < 30; p++) {
    const { data } = await supabase
      .from('ohlcv_bars')
      .select('ts, high, low')
      .eq('symbol', symbol)
      .gte('ts', startIso)
      .lt('ts', endIso)
      .order('ts')
      .range(p * PAGE, p * PAGE + PAGE - 1) as { data: Array<{ ts: string; high: number; low: number }> | null }
    if (!data || data.length === 0) break
    bars.push(...data)
    if (data.length < PAGE) break
  }

  if (bars.length === 0) return { adr: null, samples: 0 }

  // Group bars by PT calendar date, filter to RTH only, compute daily range.
  const byDate = new Map<string, { hi: number; lo: number }>()
  for (const b of bars) {
    const ms = Date.parse(b.ts)
    const ptDate = ptDateForMs(ms)
    const sod = ptSodForMs(ms)
    if (sod < RTH_START_SOD || sod >= RTH_END_SOD) continue
    const cur = byDate.get(ptDate)
    if (cur == null) byDate.set(ptDate, { hi: b.high, lo: b.low })
    else {
      if (b.high > cur.hi) cur.hi = b.high
      if (b.low < cur.lo) cur.lo = b.low
    }
  }

  // Sort dates descending, take latest N.
  const sortedDates = [...byDate.keys()].sort().reverse().slice(0, lookbackDays)
  if (sortedDates.length < 3) return { adr: null, samples: sortedDates.length }
  const ranges = sortedDates.map(d => {
    const r = byDate.get(d)!
    return r.hi - r.lo
  })
  const adr = ranges.reduce((s, v) => s + v, 0) / ranges.length
  return { adr, samples: ranges.length }
}

// ── PT helpers (duplicated lightweight from session-levels to avoid pulling
// in the full study). DST-aware via Intl. ─────────────────────────────────
const PT_FMT_LIGHT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function ptParts(ms: number): Record<string, string> {
  const m: Record<string, string> = {}
  for (const p of PT_FMT_LIGHT.formatToParts(new Date(ms))) m[p.type] = p.value
  return m
}
function ptDateForMs(ms: number): string {
  const m = ptParts(ms)
  return `${m.year}-${m.month}-${m.day}`
}
function ptSodForMs(ms: number): number {
  const m = ptParts(ms)
  return Number(m.hour) * 3600 + Number(m.minute) * 60 + Number(m.second)
}
