/**
 * Compute per-day market_context metrics from raw 1-minute bars.
 *
 * Used by the Tradezella historical backfill — for each trade_date in the
 * imported Tradezella history, we read the corresponding SCID, slice the
 * bars around that date, and derive the same five fields the prep form asks
 * the user to enter manually:
 *
 *   - rvol          today's RTH volume / avg RTH volume over the prior N days
 *   - adr           avg of (RTH high − RTH low) over the prior N days
 *   - ib_size       today's IBH − IBL (first hour of RTH)
 *   - ib_vs_10d_avg today's IB size / avg IB size over the prior N days
 *   - atr_1m        Wilder ATR-10 on the 1-minute series, value at the last
 *                   bar of the target day's RTH (a stable "EOD" reference)
 *
 * Windows are Pacific-time wall-clock (Sierra study defaults):
 *   RTH 06:30–13:00 PT  ·  IB 06:30–07:30 PT
 *
 * Lookback is configurable; 10 trading days is the journal's convention and
 * matches the manual ATR-10 / IB-vs-10d-avg prep fields.
 */

import { DEFAULT_LEVELS_CONFIG, type LevelsConfig, type RawBar } from './session-levels'

const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

function ptInfo(ms: number): { date: string; sod: number } {
  const parts = PT_FMT.formatToParts(new Date(ms))
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  return {
    date: `${m.year}-${m.month}-${m.day}`,
    sod: Number(m.hour) * 3600 + Number(m.minute) * 60 + Number(m.second),
  }
}

interface AnnotatedBar extends RawBar {
  ms: number
  ptDate: string
  sod: number
}

/** Wilder ATR-10 (matches the implementation in session-levels.ts). */
function wilderAtr(bars: AnnotatedBar[], length: number): (number | null)[] {
  const n = bars.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n === 0 || length <= 0 || n < length) return out
  const tr: number[] = new Array(n)
  tr[0] = bars[0].high - bars[0].low
  for (let i = 1; i < n; i++) {
    const b = bars[i]
    const prevClose = bars[i - 1].close
    tr[i] = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
  }
  let sum = 0
  for (let i = 0; i < length; i++) sum += tr[i]
  let atr = sum / length
  out[length - 1] = atr
  for (let i = length; i < n; i++) {
    atr = (atr * (length - 1) + tr[i]) / length
    out[i] = atr
  }
  return out
}

export interface MarketContextMetrics {
  rvol: number | null
  adr: number | null
  ib_size: number | null
  ib_vs_10d_avg: number | null
  atr_1m: number | null
}

export interface ComputeMarketContextOptions {
  lookbackDays?: number  // # of trading days for rolling averages (default 10)
  atrPeriod?: number     // Wilder ATR length (default 10)
  config?: LevelsConfig  // Session window config (defaults match session-levels)
}

/** Internal: per-day RTH stats used to compute multi-day averages. */
interface DailyStats {
  date: string
  rthHigh: number
  rthLow: number
  rthVolume: number
  ibHigh: number
  ibLow: number
  ibValid: boolean
}

/**
 * Compute the five market_context metrics for `targetDatePT` from a lookback
 * window of 1-minute bars. The bars array MUST cover at least targetDatePT
 * AND the prior `lookbackDays` of trading data — caller is responsible for
 * reading enough SCID history (recommend lookbackDays * 1.5 calendar days to
 * account for weekends).
 *
 * Returns nulls for any metric whose required inputs are missing (e.g. no IB
 * bars on target day, or fewer than 2 prior days for averaging).
 */
export function computeMarketContext(
  bars: RawBar[],
  targetDatePT: string,
  options: ComputeMarketContextOptions = {},
): MarketContextMetrics {
  const cfg = options.config ?? DEFAULT_LEVELS_CONFIG
  const lookbackDays = options.lookbackDays ?? 10
  const atrPeriod = options.atrPeriod ?? 10

  // Annotate + sort by time.
  const annotated: AnnotatedBar[] = bars
    .map(b => {
      const ms = new Date(b.ts).getTime()
      const { date, sod } = ptInfo(ms)
      return { ...b, ms, ptDate: date, sod }
    })
    .sort((a, b) => a.ms - b.ms)

  const inRTH = (b: AnnotatedBar) => b.sod >= cfg.rthStartSec && b.sod < cfg.rthEndSec
  const inIB = (b: AnnotatedBar) => b.sod >= cfg.rthStartSec && b.sod < cfg.ibEndSec

  // Aggregate per-day stats. Only days with at least one RTH bar count.
  const byDate = new Map<string, DailyStats>()
  for (const b of annotated) {
    if (!inRTH(b)) continue
    let d = byDate.get(b.ptDate)
    if (!d) {
      d = {
        date: b.ptDate,
        rthHigh: -Infinity,
        rthLow: Infinity,
        rthVolume: 0,
        ibHigh: -Infinity,
        ibLow: Infinity,
        ibValid: false,
      }
      byDate.set(b.ptDate, d)
    }
    if (b.high > d.rthHigh) d.rthHigh = b.high
    if (b.low < d.rthLow) d.rthLow = b.low
    d.rthVolume += b.volume ?? 0
    if (inIB(b)) {
      if (b.high > d.ibHigh) d.ibHigh = b.high
      if (b.low < d.ibLow) d.ibLow = b.low
      d.ibValid = true
    }
  }

  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  const targetIdx = days.findIndex(d => d.date === targetDatePT)

  const out: MarketContextMetrics = {
    rvol: null, adr: null, ib_size: null, ib_vs_10d_avg: null, atr_1m: null,
  }

  if (targetIdx < 0) return out
  const today = days[targetIdx]

  // Today's IB
  if (today.ibValid && isFinite(today.ibHigh) && isFinite(today.ibLow)) {
    out.ib_size = today.ibHigh - today.ibLow
  }

  // Prior-N-day averages. Need at least 2 prior days to mean anything.
  const prior = days.slice(Math.max(0, targetIdx - lookbackDays), targetIdx)
  if (prior.length >= 2) {
    const adrSum = prior.reduce((s, d) => s + (d.rthHigh - d.rthLow), 0)
    out.adr = adrSum / prior.length

    const volSum = prior.reduce((s, d) => s + d.rthVolume, 0)
    // RVOL stored as percentage (100 = average) to match the journal's
    // existing convention; the prep MarketContextForm + analytics buckets
    // both expect this scale.
    if (volSum > 0) out.rvol = (today.rthVolume / (volSum / prior.length)) * 100

    const ibPrior = prior.filter(d => d.ibValid && isFinite(d.ibHigh) && isFinite(d.ibLow))
    if (ibPrior.length >= 2 && out.ib_size != null) {
      const ibSum = ibPrior.reduce((s, d) => s + (d.ibHigh - d.ibLow), 0)
      const ibAvg = ibSum / ibPrior.length
      if (ibAvg > 0) out.ib_vs_10d_avg = out.ib_size / ibAvg
    }
  }

  // ATR-10 (1m, Wilder) — value at the last 1-min bar of the target day's RTH.
  // Computed over the FULL annotated series so warmup is past targetDate by
  // the time we hit the last RTH bar.
  const atrSeries = wilderAtr(annotated, atrPeriod)
  let lastIdx = -1
  for (let i = annotated.length - 1; i >= 0; i--) {
    const b = annotated[i]
    if (b.ptDate === targetDatePT && inRTH(b)) { lastIdx = i; break }
  }
  if (lastIdx >= 0) out.atr_1m = atrSeries[lastIdx] ?? null

  return out
}
