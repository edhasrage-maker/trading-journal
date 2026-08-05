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
import { sessionWindow, type SessionKind } from './session-levels'

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
  /** Cumulative RTH volume after each RTH bar, indexed by bar number.
   *
   *  Exists so a session still in progress can be compared with prior days AT
   *  THE SAME POINT of the day. Comparing today's running total against ten
   *  COMPLETED days measures how far through the session we are, not how busy
   *  the tape is — two hours into a 6.5-hour day that reads ~40% and calls a
   *  normal morning "very quiet". */
  rth_cum_vol: number[]
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
  /** Study-native IB-fade ATR: mean(High−Low of the last 10 IB 1-min bars) for
   *  the ACTIVE session's IB. NOT Wilder — atr_at_ib_close (Wilder-10) runs ~3%
   *  smaller. Powers the IB/ATR-regime lens in ib-day-type.ts. Null until the
   *  IB has printed ≥10 bars. */
  meanHL10: number | null
  /** Trailing-10 average of `atr_at_ib_close` — an IB-CLOSE-basis baseline.
   *  Kept because market_context stores it, but note it is NOT the right
   *  denominator for `atr_1m` (see atr_eod_10d_avg). */
  atr_10d_avg: number | null
  /** Trailing-10 average of `atr_at_eod` — the SAME-BASIS baseline for
   *  `atr_1m`. Both are the Wilder ATR-10 at the 12:59 PT bar, so the ratio is
   *  a true "vs typical" and a normal day lands near 1.0×. Dividing atr_1m by
   *  atr_10d_avg instead compares a full-session average against the busiest
   *  hour's, which reads ~0.77× on an ordinary day. Derived per request, never
   *  persisted — no schema column. */
  atr_eod_10d_avg: number | null
  rth_open: number | null
  ib_close_price: number | null
  day_range: number | null         // RTH high-low (matches ADR basis)
  current_price: number | null     // last close on the target PT date
}

/** Built ONCE. Constructing an Intl.DateTimeFormat is expensive and this runs
 *  per bar — a three-week window is ~30k calls, a multi-year analysis millions.
 *  The options are constant, so there was never a reason to rebuild it. */
const PT_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

/** UTC ms → America/Los_Angeles wall-clock parts. DST-aware via Intl. */
function utcMsToPtParts(ms: number): { date: string; sec: number } {
  const fmt = PT_PARTS_FMT
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
    rth_cum_vol: [],
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
      // Snapshot the running total so a partial day can be matched against
      // prior days at the same bar index (see rth_cum_vol).
      agg.rth_cum_vol.push(agg.volume)
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
  atr_eod_10d_avg: number | null
  rth_open: number | null
  ib_close_price: number | null
  day_range: number | null
  current_price: number | null
  rth_bar_count: number
}

/**
 * Trailing-baseline lengths, in sessions. Today never counts toward its own.
 *
 * These were all 10. They are now per-metric, matched to the trader's Sierra
 * studies by measurement against a live chart (ES, 2026-08-04) — a baseline that
 * disagrees with the chart the trader watches all session is a number they stop
 * believing, even when the maths is sound:
 *
 *   RVOL 20 — chart read 111.85; trailing-20 reproduces 111.5%, trailing-10 gives
 *             103.8%.
 *   ADR  14 — chart read 77.35; trailing-14 gives 77.14, trailing-10 gives 81.88
 *             (the old value, which is why the app showed 81.9).
 *   ATR  10 — chart's ATR-10-1min read 2.92 against the app's 2.9. Already agreed;
 *             left alone.
 *
 * IB stays at 10 deliberately. The chart's IB Avg of 51.58 sits between
 * trailing-5 (58.05) and trailing-10 (49.25) and matches no clean length, so
 * there is nothing here to match it to — guessing a lookback to close a gap
 * would be fitting noise. Today's IB SIZE already reproduces exactly (50.25),
 * so the window definition is right; only the averaging length is unknown.
 */
const LOOKBACK_RVOL = 20
const LOOKBACK_ADR = 14
const LOOKBACK_ATR = 10
const LOOKBACK_IB = 10

/** Trailing metrics per day, chronological. Mirrors the backfill exactly:
 *  today never counts toward its own trailing average. */
function computeMetrics(days: Map<string, DayAggregate>): DayMetrics[] {
  const sorted = Array.from(days.values())
    .filter(d => d.rth_bar_count >= 60)      // full-IB sessions only, like the backfill
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  const trailVol: number[] = [], trailRange: number[] = [], trailIb: number[] = []
  const trailIbVol: number[] = [], trailAtrIb: number[] = [], trailAtrEod: number[] = []
  // Prior days' cumulative-volume curves, so a day still in progress is measured
  // against where those days stood at the SAME bar of the session.
  const trailCumVol: number[][] = []
  const out: DayMetrics[] = []

  for (const d of sorted) {
    const range = d.high - d.low
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length

    // RVOL, time-matched. Take each prior day's volume through the same number
    // of RTH bars as today has printed; on a COMPLETE day every curve is at its
    // final value, so this is identical to the old whole-day ratio. Mid-session
    // it stops reporting the clock: comparing a third of a session against ten
    // finished ones returned ~40% and labelled a busy morning "very quiet".
    const barIdx = Math.max(0, d.rth_bar_count - 1)
    const priorAtBar = trailCumVol
      .map(c => (c.length ? c[Math.min(barIdx, c.length - 1)] : null))
      .filter((v): v is number => v != null && v > 0)
    const volSoFar = d.rth_cum_vol.length ? d.rth_cum_vol[Math.min(barIdx, d.rth_cum_vol.length - 1)] : d.volume
    const rvol = priorAtBar.length >= LOOKBACK_RVOL ? (volSoFar / avg(priorAtBar)) * 100 : null
    const adr = trailRange.length >= LOOKBACK_ADR ? avg(trailRange) : null
    const ibSize = (d.ib_high != null && d.ib_low != null) ? d.ib_high - d.ib_low : null
    const ibVs10d = (ibSize != null && trailIb.length >= LOOKBACK_IB) ? ibSize / avg(trailIb) : null
    const rvolAtIb = (trailIbVol.length >= LOOKBACK_IB && trailIbVol.reduce((s, v) => s + v, 0) > 0)
      ? (d.ib_volume / avg(trailIbVol)) * 100 : null
    const atrIb10d = trailAtrIb.length >= LOOKBACK_ATR ? avg(trailAtrIb) : null
    const atrEod10d = trailAtrEod.length >= LOOKBACK_ATR ? avg(trailAtrEod) : null

    out.push({
      date: d.date,
      rvol, ib_size: ibSize, ib_vs_10d_avg: ibVs10d, adr,
      atr_1m: d.atr_at_eod,
      rvol_at_ib_close: rvolAtIb,
      atr_at_ib_close: d.atr_at_ib_close,
      atr_10d_avg: atrIb10d,
      atr_eod_10d_avg: atrEod10d,
      rth_open: d.rth_open,
      ib_close_price: d.ib_close_price,
      day_range: Number.isFinite(range) ? range : null,
      current_price: d.last_close,
      rth_bar_count: d.rth_bar_count,
    })

    trailVol.push(d.volume)
    trailRange.push(range)
    // Only COMPLETE sessions become a baseline. A partial day in the trailing
    // window would drag every later comparison down — the same error this
    // change fixes, one level up.
    if (d.rth_cum_vol.length >= 300) trailCumVol.push(d.rth_cum_vol)
    if (ibSize != null) trailIb.push(ibSize)
    if (d.ib_volume > 0) trailIbVol.push(d.ib_volume)
    if (d.atr_at_ib_close != null) trailAtrIb.push(d.atr_at_ib_close)
    if (d.atr_at_eod != null) trailAtrEod.push(d.atr_at_eod)
    // Each window is trimmed to ITS OWN length now, not a shared 10.
    if (trailVol.length > LOOKBACK_RVOL) trailVol.shift()
    if (trailCumVol.length > LOOKBACK_RVOL) trailCumVol.shift()
    if (trailRange.length > LOOKBACK_ADR) trailRange.shift()
    if (trailIb.length > LOOKBACK_IB) trailIb.shift()
    if (trailIbVol.length > LOOKBACK_IB) trailIbVol.shift()
    if (trailAtrIb.length > LOOKBACK_ATR) trailAtrIb.shift()
    if (trailAtrEod.length > LOOKBACK_ATR) trailAtrEod.shift()
  }
  return out
}

/**
 * Active-session IB size + full-session range for `date`, computed directly
 * from the bars using the SHARED session-window definitions in session-levels.ts
 * (single source of truth for the RTH/Asia/London windows). Asia's IB sits on
 * D-1 (17:00–18:00) and its range crosses midnight (17:00 D-1 → 02:00 D); the
 * `addDays`/inWin logic handles the two-date span.
 *
 * Also computes the study-native `meanHL10` = mean(High−Low of the last 10 IB
 * 1-min bars), the ATR the IB-fade study divides the IB range by for its regime
 * bands. This is a simple mean of the trailing-10 bar ranges (NOT Wilder true
 * range, and NOT streamed across days) — it matches the study exactly, whereas
 * `atr_at_ib_close` (Wilder-10) runs ~3% smaller. "Last 10" is by bar time, so
 * the definitive value is fixed once the IB closes; while the IB is still
 * printing it reflects the last 10 bars seen so far, and it stays null until at
 * least 10 IB bars exist.
 */
function sessionIbAndRange(
  bars: OneMinBar[], date: string, session: SessionKind,
): { ibSize: number | null; range: number | null; meanHL10: number | null; realized: boolean } {
  const w = sessionWindow(session)
  const ibStart = addDays(date, w.ibStartOffset), ibEnd = addDays(date, w.ibEndOffset)
  const hlStart = addDays(date, w.hlStartOffset), hlEnd = addDays(date, w.hlEndOffset)
  const inWin = (d: string, s: number, sd: string, ss: number, ed: string, es: number) =>
    sd === ed ? d === sd && s >= ss && s < es
      : d === sd ? s >= ss
      : d === ed ? s < es
      : d > sd && d < ed
  let ibHi = -Infinity, ibLo = Infinity, ibN = 0
  let rHi = -Infinity, rLo = Infinity, rN = 0
  // Per-IB-bar (ms, high−low) so we can average the LAST 10 by bar time.
  const ibBarHL: Array<{ ms: number; hl: number }> = []
  for (const bar of bars) {
    const ms = new Date(bar.ts).getTime()
    if (!Number.isFinite(ms)) continue
    const { date: bd, sec } = utcMsToPtParts(ms)
    if (inWin(bd, sec, ibStart, w.ibStartSec, ibEnd, w.ibEndSec)) {
      if (bar.high > ibHi) ibHi = bar.high; if (bar.low < ibLo) ibLo = bar.low; ibN++
      ibBarHL.push({ ms, hl: bar.high - bar.low })
    }
    if (inWin(bd, sec, hlStart, w.hlStartSec, hlEnd, w.hlEndSec)) {
      if (bar.high > rHi) rHi = bar.high; if (bar.low < rLo) rLo = bar.low; rN++
    }
  }
  let meanHL10: number | null = null
  if (ibBarHL.length >= 10) {
    ibBarHL.sort((a, b) => a.ms - b.ms)
    const last10 = ibBarHL.slice(-10)
    meanHL10 = last10.reduce((s, b) => s + b.hl, 0) / 10
  }
  return { ibSize: ibN ? ibHi - ibLo : null, range: rN ? rHi - rLo : null, meanHL10, realized: ibN > 0 }
}

/**
 * Compute Market Context stats for `date` from a window of 1m bars.
 * Returns realized stats when the target day's session is present; otherwise a
 * pre-session estimate (adr/atr from the most recent completed day). Null when
 * there isn't enough history.
 *
 * `session` re-anchors the IB size + day range to Asia/London (default 'rth' =
 * unchanged). The RTH-baselined comparison metrics (rvol, ib_vs_10d, rvol_at_ib)
 * are nulled for non-RTH sessions — they can't be validly compared to an RTH
 * trailing average overnight (session-aware baselining is deliberately deferred).
 * ADR/ATR carry through as descriptive stats; the UI surfaces them muted.
 */
export function contextStatsForDate(
  bars: OneMinBar[], date: string, session: SessionKind = 'rth',
): DayContextStats | null {
  const metrics = computeMetrics(aggregateBars(bars))
  if (metrics.length === 0) return null

  const target = metrics.find(m => m.date === date)
  let base: DayContextStats
  if (target) {
    base = {
      date,
      realized: true,
      rvol: target.rvol,
      ib_size: target.ib_size,
      ib_vs_10d_avg: target.ib_vs_10d_avg,
      adr: target.adr,
      atr_1m: target.atr_1m,
      rvol_at_ib_close: target.rvol_at_ib_close,
      atr_at_ib_close: target.atr_at_ib_close,
      meanHL10: null, // attached below from the active session's IB
      atr_10d_avg: target.atr_10d_avg,
      atr_eod_10d_avg: target.atr_eod_10d_avg,
      rth_open: target.rth_open,
      ib_close_price: target.ib_close_price,
      day_range: target.day_range,
      current_price: target.current_price,
    }
  } else {
    // Pre-session (e.g. morning prep before the open): today's session hasn't
    // printed, so carry ADR/ATR forward from the latest completed day. Realized
    // fields stay null — they can't exist yet.
    const prior = metrics.filter(m => m.date < date)
    const last = prior.length ? prior[prior.length - 1] : null
    if (!last) return null
    base = {
      date,
      realized: false,
      rvol: null, ib_size: null, ib_vs_10d_avg: null,
      adr: last.adr, atr_1m: last.atr_1m,
      rvol_at_ib_close: null, atr_at_ib_close: null, meanHL10: null,
      atr_10d_avg: last.atr_10d_avg, atr_eod_10d_avg: last.atr_eod_10d_avg,
      rth_open: null, ib_close_price: null,
      day_range: null, current_price: null,
    }
  }

  // Study-native meanHL10 for the ACTIVE session's IB — computed for every
  // session (incl. RTH) so the IB/ATR-regime lens (ib-day-type.ts) always has
  // its exact denominator. Null until the IB has printed ≥10 bars.
  const active = sessionIbAndRange(bars, date, session)
  base.meanHL10 = active.meanHL10

  if (session === 'rth') return base

  return {
    ...base,
    realized: active.realized,
    ib_size: active.ibSize,
    day_range: active.range,
    meanHL10: active.meanHL10,
    rvol: null,
    ib_vs_10d_avg: null,
    rvol_at_ib_close: null,
  }
}
