/**
 * Compute a day's Market Context volatility/volume stats (RVOL, ADR, ATR, IB
 * size, day range, IB-close snapshots) directly from 1-minute bars — the same
 * definitions the historical backfill uses (scripts/backfill-market-context-
 * from-csv.ts), extracted here so the LIVE prep/EOD flow can auto-fill them
 * from `.scid` bars instead of the user uploading a Sierra screenshot.
 *
 * Faithful to the backfill so a live-computed day matches a backfilled one:
 *   - PT session anchoring (RTH 06:30–13:00, IB 06:30–07:29), DST-aware.
 *   - Wilder ATR-10 streamed continuously across days (no session reset).
 *   - Trailing-10 baselines for RVOL / ADR / IB-vs-10d / rvol_at_ib_close.
 *
 * Give it a window of bars covering the target day plus ≥10 prior trading days
 * (the caller reads ~3 weeks of `.scid`), then call contextStatsForDate().
 */
import type { OneMinBar } from './scid-reader'

// RTH in PT (06:30 → 13:00). IB is the first 60 mins (06:30 → 07:29).
const RTH_OPEN_SEC = 6 * 3600 + 30 * 60   // 23400
const IB_CLOSE_SEC = 7 * 3600 + 30 * 60   // 27000
const RTH_CLOSE_SEC = 13 * 3600           // 46800
const SEC_RTH_OPEN = RTH_OPEN_SEC         // 06:30 — rth_open
const SEC_IB_LAST = 7 * 3600 + 29 * 60    // 07:29 — ib_close_price + atr_at_ib_close
const SEC_RTH_LAST = 12 * 3600 + 59 * 60  // 12:59 — atr_at_eod
const ATR_PERIOD = 10                      // Wilder ATR-10

interface DayAggregate {
  date: string
  volume: number
  high: number
  low: number
  ib_high: number | null
  ib_low: number | null
  ib_volume: number
  rth_open: number | null
  ib_close_price: number | null
  atr_at_ib_close: number | null
  atr_at_eod: number | null
  last_close: number | null   // last close on this PT calendar date (any session)
  rth_bar_count: number
  on_high: number | null
  on_low: number | null
}

export interface DayContextStats {
  date: string
  /** true = the target day's own session bars were used; false = pre-session
   *  estimate carried from the most recent completed day (adr/atr only). */
  realized: boolean
  rvol: number | null              // percent vs trailing-10 avg RTH volume
  ib_size: number | null
  ib_vs_10d_avg: number | null
  adr: number | null
  atr_1m: number | null            // Wilder ATR-10 at EOD (12:59 PT)
  rvol_at_ib_close: number | null  // percent vs trailing-10 avg IB volume
  atr_at_ib_close: number | null
  atr_10d_avg: number | null
  rth_open: number | null
  ib_close_price: number | null
  day_range: number | null         // RTH high-low (matches ADR basis)
  current_price: number | null     // last close on the target PT date
}

/** UTC ms → America/Los_Angeles wall-clock parts. DST-aware via Intl. */
function utcMsToPtParts(ms: number): { date: string; sec: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const p: Record<string, string> = {}
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value
  const hour = p.hour === '24' ? 0 : parseInt(p.hour)
  const sec = hour * 3600 + parseInt(p.minute) * 60 + parseInt(p.second)
  return { date: `${p.year}-${p.month}-${p.day}`, sec }
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  const Y = dt.getUTCFullYear()
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const D = String(dt.getUTCDate()).padStart(2, '0')
  return `${Y}-${M}-${D}`
}

/** Next weekday (Mon-Fri) on or after a date — Fri-late/weekend ETH → Monday. */
function nextWeekday(date: string): string {
  let cur = date
  for (let i = 0; i < 8; i++) {
    const [y, m, d] = cur.split('-').map(Number)
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
    if (dow >= 1 && dow <= 5) return cur
    cur = addDays(cur, 1)
  }
  return cur
}

function emptyAggregate(date: string): DayAggregate {
  return {
    date,
    volume: 0, high: -Infinity, low: Infinity,
    ib_high: null, ib_low: null, ib_volume: 0,
    rth_open: null, ib_close_price: null, atr_at_ib_close: null, atr_at_eod: null,
    last_close: null, rth_bar_count: 0,
    on_high: null, on_low: null,
  }
}

/** Aggregate 1m bars into per-trading-day RTH + overnight buckets, streaming
 *  Wilder ATR-10 across the whole window. Same logic as the backfill's .scid
 *  path (prevClose starts null; first bar's TR = high-low). */
function aggregateBars(bars: OneMinBar[]): Map<string, DayAggregate> {
  const days = new Map<string, DayAggregate>()
  let prevClose: number | null = null
  const trSeed: number[] = []
  let atr10: number | null = null

  for (const bar of bars) {
    const ms = new Date(bar.ts).getTime()
    if (!Number.isFinite(ms)) continue

    const tr = prevClose == null
      ? (bar.high - bar.low)
      : Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
    if (atr10 == null) {
      trSeed.push(tr)
      if (trSeed.length === ATR_PERIOD) atr10 = trSeed.reduce((s, v) => s + v, 0) / ATR_PERIOD
    } else {
      atr10 = ((ATR_PERIOD - 1) * atr10 + tr) / ATR_PERIOD
    }
    prevClose = bar.close

    const { date, sec } = utcMsToPtParts(ms)

    let tradingDay: string
    let isRTH = false
    let isIB = false
    if (sec >= RTH_OPEN_SEC && sec < RTH_CLOSE_SEC) {
      tradingDay = date; isRTH = true; isIB = sec < IB_CLOSE_SEC
    } else if (sec < RTH_OPEN_SEC) {
      tradingDay = date
    } else {
      tradingDay = nextWeekday(addDays(date, 1))
    }

    let agg = days.get(tradingDay)
    if (!agg) { agg = emptyAggregate(tradingDay); days.set(tradingDay, agg) }

    // last_close tracks the latest print on THIS PT calendar date (for current_price)
    const calAgg = days.get(date) ?? (() => { const a = emptyAggregate(date); days.set(date, a); return a })()
    calAgg.last_close = bar.close

    if (isRTH) {
      agg.volume += Number.isFinite(bar.volume) ? bar.volume : 0
      if (bar.high > agg.high) agg.high = bar.high
      if (bar.low < agg.low) agg.low = bar.low
      agg.rth_bar_count += 1
      if (isIB) {
        if (agg.ib_high == null || bar.high > agg.ib_high) agg.ib_high = bar.high
        if (agg.ib_low == null || bar.low < agg.ib_low) agg.ib_low = bar.low
        agg.ib_volume += Number.isFinite(bar.volume) ? bar.volume : 0
      }
      if (sec === SEC_RTH_OPEN) agg.rth_open = bar.close
      if (sec === SEC_IB_LAST) { agg.ib_close_price = bar.close; agg.atr_at_ib_close = atr10 }
      if (sec === SEC_RTH_LAST) agg.atr_at_eod = atr10
    } else {
      if (agg.on_high == null || bar.high > agg.on_high) agg.on_high = bar.high
      if (agg.on_low == null || bar.low < agg.on_low) agg.on_low = bar.low
    }
  }
  return days
}

interface DayMetrics {
  date: string
  rvol: number | null
  ib_size: number | null
  ib_vs_10d_avg: number | null
  adr: number | null
  atr_1m: number | null
  rvol_at_ib_close: number | null
  atr_at_ib_close: number | null
  atr_10d_avg: number | null
  rth_open: number | null
  ib_close_price: number | null
  day_range: number | null
  current_price: number | null
  rth_bar_count: number
}

/** Trailing-10 metrics per day, chronological. Mirrors the backfill exactly:
 *  today never counts toward its own trailing average. */
function computeMetrics(days: Map<string, DayAggregate>): DayMetrics[] {
  const sorted = Array.from(days.values())
    .filter(d => d.rth_bar_count >= 60)      // full-IB sessions only, like the backfill
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const trailVol: number[] = [], trailRange: number[] = [], trailIb: number[] = []
  const trailIbVol: number[] = [], trailAtrIb: number[] = []
  const out: DayMetrics[] = []

  for (const d of sorted) {
    const range = d.high - d.low
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
    const rvol = trailVol.length >= 10 ? (d.volume / avg(trailVol)) * 100 : null
    const adr = trailRange.length >= 10 ? avg(trailRange) : null
    const ibSize = (d.ib_high != null && d.ib_low != null) ? d.ib_high - d.ib_low : null
    const ibVs10d = (ibSize != null && trailIb.length >= 10) ? ibSize / avg(trailIb) : null
    const rvolAtIb = (trailIbVol.length >= 10 && trailIbVol.reduce((s, v) => s + v, 0) > 0)
      ? (d.ib_volume / avg(trailIbVol)) * 100 : null
    const atrIb10d = trailAtrIb.length >= 10 ? avg(trailAtrIb) : null

    out.push({
      date: d.date,
      rvol, ib_size: ibSize, ib_vs_10d_avg: ibVs10d, adr,
      atr_1m: d.atr_at_eod,
      rvol_at_ib_close: rvolAtIb,
      atr_at_ib_close: d.atr_at_ib_close,
      atr_10d_avg: atrIb10d,
      rth_open: d.rth_open,
      ib_close_price: d.ib_close_price,
      day_range: Number.isFinite(range) ? range : null,
      current_price: d.last_close,
      rth_bar_count: d.rth_bar_count,
    })

    trailVol.push(d.volume)
    trailRange.push(range)
    if (ibSize != null) trailIb.push(ibSize)
    if (d.ib_volume > 0) trailIbVol.push(d.ib_volume)
    if (d.atr_at_ib_close != null) trailAtrIb.push(d.atr_at_ib_close)
    for (const a of [trailVol, trailRange, trailIb, trailIbVol, trailAtrIb]) if (a.length > 10) a.shift()
  }
  return out
}

/**
 * Compute Market Context stats for `date` from a window of 1m bars.
 * Returns realized stats when the target day's session is present; otherwise a
 * pre-session estimate (adr/atr from the most recent completed day). Null when
 * there isn't enough history.
 */
export function contextStatsForDate(bars: OneMinBar[], date: string): DayContextStats | null {
  const metrics = computeMetrics(aggregateBars(bars))
  if (metrics.length === 0) return null

  const target = metrics.find(m => m.date === date)
  if (target) {
    return {
      date,
      realized: true,
      rvol: target.rvol,
      ib_size: target.ib_size,
      ib_vs_10d_avg: target.ib_vs_10d_avg,
      adr: target.adr,
      atr_1m: target.atr_1m,
      rvol_at_ib_close: target.rvol_at_ib_close,
      atr_at_ib_close: target.atr_at_ib_close,
      atr_10d_avg: target.atr_10d_avg,
      rth_open: target.rth_open,
      ib_close_price: target.ib_close_price,
      day_range: target.day_range,
      current_price: target.current_price,
    }
  }

  // Pre-session (e.g. morning prep before the open): today's session hasn't
  // printed, so carry ADR/ATR forward from the latest completed day. Realized
  // fields stay null — they can't exist yet.
  const prior = metrics.filter(m => m.date < date)
  const last = prior.length ? prior[prior.length - 1] : null
  if (!last) return null
  return {
    date,
    realized: false,
    rvol: null, ib_size: null, ib_vs_10d_avg: null,
    adr: last.adr, atr_1m: last.atr_1m,
    rvol_at_ib_close: null, atr_at_ib_close: null, atr_10d_avg: last.atr_10d_avg,
    rth_open: null, ib_close_price: null,
    day_range: null, current_price: null,
  }
}
