/**
 * Backfill market_context for every date in historical_trades + trading_days
 * using a HYBRID data source:
 *   - Sierra-exported 1m CSV (continuous-contract NQ) for the bulk
 *   - NQM6.CME.scid for the post-CSV tail (typically the most recent ~6
 *     weeks where the user hasn't re-exported a fresh CSV)
 *
 * Why this exists: Tradezella history doesn't carry RVol/IB/ADR/ATR, so
 * those historical trades all bucket under "Unknown" in the analytics
 * Performance-by-Market-Condition charts. Plus the day-type classifier
 * needs IB-close snapshot fields (rvol_at_ib_close, atr_at_ib_close, etc.)
 * to honestly classify days "by 07:30 PT" rather than with EOD hindsight.
 *
 * Approach:
 *   1. Stream CSV → per-day aggregates (RTH + overnight) + Wilder ATR-10
 *   2. Stream NQM6.scid bars in [csv_end_ms, now] → same aggregations,
 *      same days Map (resets prevClose at boundary to avoid back-adjusted
 *      CSV vs raw .scid TR inflation)
 *   3. Compute trailing-10 metrics (rvol/adr/ib_vs_10d/atr_10d) continuously
 *   4. Upsert market_context for every distinct date in historical_trades
 *      UNION trading_days (so native + historical dates both get filled)
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-market-context-from-csv.ts [csv-path] [--dry-run] [--force] [--csv-only]
 *
 *   --force      overwrite existing market_context rows. Default: skip
 *                rows already populated (preserves prep-AI extracted values).
 *   --csv-only   skip the .scid fallback (debug aid; recent days stay null).
 *
 * Defaults to D:\Documents\Trading\Trading Journal\docs\NQ_1m _R24_Market Data_5.04.26.csv.
 */

import { createReadStream, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'

const DEFAULT_CSV = 'D:\\Documents\\Trading\\Trading Journal\\docs\\NQ_1m _R24_Market Data_5.04.26.csv'
// Same .scid that backfill-historical-mfe.ts uses for its post-CSV tail.
// Currently NQM6 (June 2026) is front-month from mid-March 2026 onward.
const FALLBACK_SCID = 'D:\\SierraCharts\\Data\\NQM6.CME.scid'

// Column indices in the Sierra export. Verified against the header row.
const COL_DATE = 0
const COL_TIME = 1
const COL_HIGH = 3
const COL_LOW = 4
const COL_CLOSE = 5            // "Last" — close of the 1m bar
const COL_VOLUME = 6
const COL_ATR = 16             // Sierra's own ATR — kept for backwards-compat
                               // (atr_1m). We also compute Wilder's ATR-10
                               // ourselves below so atr_at_ib_close /
                               // atr_at_eod don't depend on Sierra's study
                               // config at export time.

// RTH in PT (06:30:00 → 13:00:00). IB is the first 60 mins (06:30 → 07:29).
const RTH_OPEN_SEC = 6 * 3600 + 30 * 60         // 23400
const IB_CLOSE_SEC = 7 * 3600 + 30 * 60         // 27000
const RTH_CLOSE_SEC = 13 * 3600                 // 46800
// Specific bar timestamps we snapshot at:
const SEC_RTH_OPEN = RTH_OPEN_SEC               // 06:30 PT — rth_open captured
const SEC_IB_LAST  = 7 * 3600 + 29 * 60         // 07:29 PT — last IB bar; ib_close_price + atr_at_ib_close captured
const SEC_RTH_LAST = 12 * 3600 + 59 * 60        // 12:59 PT — last RTH bar; atr_at_eod captured

// Wilder's ATR period — locked to 10 to match the user's spec ("ATR-10").
const ATR_PERIOD = 10

// Load .env.local same way scripts/import-tradezella.ts does.
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const csvOnly = argv.includes('--csv-only')
const csvPath = argv.find(a => !a.startsWith('--')) ?? DEFAULT_CSV

interface DayAggregate {
  date: string                // YYYY-MM-DD trading day this aggregate covers
  // ---- RTH (06:30-13:00 PT) ----
  volume: number              // full-RTH volume
  high: number                // RTH high
  low: number                 // RTH low
  ib_high: number | null      // 06:30-07:29 high
  ib_low: number | null       // 06:30-07:29 low
  ib_volume: number           // 06:30-07:29 volume (for rvol_at_ib_close)
  atr_last_sierra: number | null   // Sierra's ATR at the last RTH bar (12:59 PT)
  rth_open: number | null     // close of 06:30 bar (effectively the open print)
  ib_close_price: number | null    // close of 07:29 bar
  atr_at_ib_close: number | null   // our Wilder ATR-10 at the 07:29 bar
  atr_at_eod: number | null        // our Wilder ATR-10 at the 12:59 bar
  rth_bar_count: number
  // ---- Overnight (15:00 PT prior weekday → 06:30 PT today) ----
  // Per-trading-day aggregate: combines ETH-late carry-in from prior
  // weekday + ETH-early bars of today.
  on_high: number | null
  on_low: number | null
  on_bar_count: number
}

/** Normalize "2024-3-20" → "2024-03-20". The Sierra export drops leading zeros. */
function normalizeDate(raw: string): string {
  const [y, m, d] = raw.trim().split('-')
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/** "06:30:00.000000" → 23400. */
function timeToSec(raw: string): number {
  const [hh, mm, ss] = raw.trim().split(':')
  return Number(hh) * 3600 + Number(mm) * 60 + Math.floor(Number(ss))
}

/** Add N calendar days to a YYYY-MM-DD string. Used to lookup "tomorrow"
 *  when a post-RTH ETH bar (sec >= 13:00 PT) carries over into the next
 *  trading day's overnight session. */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  const Y = dt.getUTCFullYear()
  const M = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const D = String(dt.getUTCDate()).padStart(2, '0')
  return `${Y}-${M}-${D}`
}

/** Find the next weekday (Mon-Fri) on or after a date. Used to assign
 *  Friday's post-RTH ETH bars (and Sunday-reopen bars) to Monday's
 *  overnight aggregate. CME equity index futures are closed Saturday +
 *  Sunday until 15:00 PT Sunday, so any bar between Fri 13:00 and Sun
 *  15:00 belongs to Monday's overnight. */
function nextWeekday(date: string): string {
  let cur = date
  for (let i = 0; i < 8; i++) {
    const [y, m, d] = cur.split('-').map(Number)
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()  // 0=Sun .. 6=Sat
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
    atr_last_sierra: null, rth_open: null,
    ib_close_price: null, atr_at_ib_close: null, atr_at_eod: null,
    rth_bar_count: 0,
    on_high: null, on_low: null, on_bar_count: 0,
  }
}

interface AggregateResult {
  days: Map<string, DayAggregate>
  /** ATR-10 value at the very last bar processed — feeds the .scid
   *  extension below so Wilder smoothing continues across the boundary
   *  rather than re-seeding from scratch (which would null-out the first
   *  10 .scid days). */
  endingAtr: number | null
}

async function streamAggregate(path: string): Promise<AggregateResult> {
  console.log(`Reading ${path}…`)
  const days = new Map<string, DayAggregate>()
  let lineCount = 0
  let headerSkipped = false

  // ---- Wilder's ATR-10 streaming state ----
  // TR_t = max(H-L, |H - prevClose|, |L - prevClose|)
  // ATR_1 = mean(TR_1..TR_10)            (Wilder seed)
  // ATR_t = ((N-1)*ATR_{t-1} + TR_t) / N (Wilder smoothing)
  //
  // The state is GLOBAL (carries across days) — Wilder's ATR doesn't
  // reset at session boundaries. That matches Sierra's behavior.
  let prevClose: number | null = null
  const trSeed: number[] = []
  let atr10: number | null = null

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const raw of rl) {
    lineCount++
    if (!headerSkipped) { headerSkipped = true; continue }
    if (!raw) continue

    const parts = raw.split(',')
    if (parts.length < 17) continue   // malformed / truncated row

    const sec = timeToSec(parts[COL_TIME])
    const date = normalizeDate(parts[COL_DATE])
    const high = Number(parts[COL_HIGH])
    const low = Number(parts[COL_LOW])
    const close = Number(parts[COL_CLOSE])
    const vol = Number(parts[COL_VOLUME])
    const sierraAtr = Number(parts[COL_ATR])

    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue

    // --- Update Wilder's ATR-10 streaming state ---
    // First bar of the entire stream has no prevClose, so TR = high - low.
    // (Standard simplification — Wilder's formula needs prevClose for
    // the gap terms; without one, the only true range is the bar's
    // own H-L.)
    const tr = prevClose == null
      ? (high - low)
      : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    if (atr10 == null) {
      trSeed.push(tr)
      if (trSeed.length === ATR_PERIOD) {
        atr10 = trSeed.reduce((s, v) => s + v, 0) / ATR_PERIOD
      }
    } else {
      atr10 = ((ATR_PERIOD - 1) * atr10 + tr) / ATR_PERIOD
    }
    prevClose = close

    // --- Classify the bar to a trading day + session ---
    // RTH:          sec in [06:30, 13:00) → today's RTH
    // ETH-early:    sec in [00:00, 06:30) → today's overnight (today's pre-RTH)
    // ETH-late:     sec in [13:00, 24:00) → NEXT weekday's overnight (carries over)
    let tradingDay: string
    let isRTH = false
    let isIB = false
    if (sec >= RTH_OPEN_SEC && sec < RTH_CLOSE_SEC) {
      tradingDay = date
      isRTH = true
      isIB = sec < IB_CLOSE_SEC
    } else if (sec < RTH_OPEN_SEC) {
      // ETH-early — belongs to today's overnight session
      tradingDay = date
    } else {
      // ETH-late — belongs to next weekday's overnight (skips Sat/Sun)
      tradingDay = nextWeekday(addDays(date, 1))
    }

    let agg = days.get(tradingDay)
    if (!agg) {
      agg = emptyAggregate(tradingDay)
      days.set(tradingDay, agg)
    }

    if (isRTH) {
      agg.volume += Number.isFinite(vol) ? vol : 0
      if (high > agg.high) agg.high = high
      if (low < agg.low) agg.low = low
      agg.rth_bar_count += 1
      if (Number.isFinite(sierraAtr)) agg.atr_last_sierra = sierraAtr

      // IB window: 06:30 → 07:29 inclusive
      if (isIB) {
        if (agg.ib_high == null || high > agg.ib_high) agg.ib_high = high
        if (agg.ib_low == null || low < agg.ib_low) agg.ib_low = low
        agg.ib_volume += Number.isFinite(vol) ? vol : 0
      }

      // Snapshot moments — captured on the exact target bars
      if (sec === SEC_RTH_OPEN) agg.rth_open = close
      if (sec === SEC_IB_LAST) {
        agg.ib_close_price = close
        agg.atr_at_ib_close = atr10  // null until seed completes
      }
      if (sec === SEC_RTH_LAST) {
        agg.atr_at_eod = atr10
      }
    } else {
      // Overnight bar — only tracks high/low + bar count
      if (agg.on_high == null || high > agg.on_high) agg.on_high = high
      if (agg.on_low == null || low < agg.on_low) agg.on_low = low
      agg.on_bar_count += 1
    }

    if (lineCount % 100000 === 0) {
      process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${days.size} dates so far\r`)
    }
  }
  process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${days.size} dates total\n`)

  // Drop dates with too few RTH bars (holidays, half-days that don't span IB).
  // Keep half-days but skip anything under 60 bars — IB wasn't fully formed.
  // NB: this filter only checks RTH bar coverage. Overnight-only entries
  // (from CSV start before the first full RTH session) get cleared too.
  for (const [date, agg] of days) {
    if (agg.rth_bar_count < 60) {
      console.log(`  skipping ${date}: only ${agg.rth_bar_count} RTH bars (likely holiday/early-close)`)
      days.delete(date)
    }
  }

  return { days, endingAtr: atr10 }
}

/** UTC ms → America/Los_Angeles wall-clock parts. DST-aware via Intl.
 *  Inverse of the ptWallToUtcMs helper in backfill-historical-mfe.ts. */
function utcMsToPtParts(ms: number): { date: string; sec: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(ms))
  const p: Record<string, string> = {}
  for (const x of parts) p[x.type] = x.value
  const hour = p.hour === '24' ? 0 : parseInt(p.hour)
  const sec = hour * 3600 + parseInt(p.minute) * 60 + parseInt(p.second)
  return { date: `${p.year}-${p.month}-${p.day}`, sec }
}

/**
 * Extend the CSV-built `days` Map with bars from a Sierra .scid file
 * covering [startMs, endMs). Same aggregation logic as the CSV path,
 * just sourcing bars via readScidBars instead of streaming text.
 *
 * Wilder ATR state carries the CSV's endingAtr, but prevClose is NOT
 * carried — the CSV is back-adjusted continuous-contract data while
 * the .scid is raw NQM6 prices, so any TR computed across that price
 * gap would be enormous and inflate ATR for the next ~20 bars. Cost:
 * one underestimated TR at the boundary. The Wilder smoothing absorbs
 * it within a handful of bars.
 */
function extendAggregateWithScid(
  days: Map<string, DayAggregate>,
  scidPath: string,
  startMs: number,
  endMs: number,
  initialAtr: number | null,
): void {
  console.log(`Reading ${scidPath} [${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}]…`)
  const result = readScidBars(scidPath, startMs, endMs, {
    priceDivisor: 100,
    bucketMs: 60_000,
  })
  console.log(`  ${result.bars.length.toLocaleString()} 1m bars from .scid`)
  if (result.bars.length === 0) return

  let prevClose: number | null = null  // reset at boundary (see docstring)
  let atr10: number | null = initialAtr
  const trSeed: number[] = []
  let datesTouched = 0
  const newDateSet = new Set<string>()

  for (const bar of result.bars) {
    const ms = new Date(bar.ts).getTime()
    if (!Number.isFinite(ms)) continue

    const tr = prevClose == null
      ? (bar.high - bar.low)
      : Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
    if (atr10 == null) {
      trSeed.push(tr)
      if (trSeed.length === ATR_PERIOD) {
        atr10 = trSeed.reduce((s, v) => s + v, 0) / ATR_PERIOD
      }
    } else {
      atr10 = ((ATR_PERIOD - 1) * atr10 + tr) / ATR_PERIOD
    }
    prevClose = bar.close

    const { date, sec } = utcMsToPtParts(ms)

    // Same session classification logic as the CSV path
    let tradingDay: string
    let isRTH = false
    let isIB = false
    if (sec >= RTH_OPEN_SEC && sec < RTH_CLOSE_SEC) {
      tradingDay = date
      isRTH = true
      isIB = sec < IB_CLOSE_SEC
    } else if (sec < RTH_OPEN_SEC) {
      tradingDay = date
    } else {
      tradingDay = nextWeekday(addDays(date, 1))
    }

    let agg = days.get(tradingDay)
    if (!agg) {
      agg = emptyAggregate(tradingDay)
      days.set(tradingDay, agg)
      newDateSet.add(tradingDay)
    }

    if (isRTH) {
      agg.volume += Number.isFinite(bar.volume) ? bar.volume : 0
      if (bar.high > agg.high) agg.high = bar.high
      if (bar.low < agg.low) agg.low = bar.low
      agg.rth_bar_count += 1
      // No Sierra ATR on .scid — leave atr_last_sierra null; the
      // computeMetrics fallback prefers our Wilder atr_at_eod anyway.

      if (isIB) {
        if (agg.ib_high == null || bar.high > agg.ib_high) agg.ib_high = bar.high
        if (agg.ib_low == null || bar.low < agg.ib_low) agg.ib_low = bar.low
        agg.ib_volume += Number.isFinite(bar.volume) ? bar.volume : 0
      }

      if (sec === SEC_RTH_OPEN) agg.rth_open = bar.close
      if (sec === SEC_IB_LAST) {
        agg.ib_close_price = bar.close
        agg.atr_at_ib_close = atr10
      }
      if (sec === SEC_RTH_LAST) {
        agg.atr_at_eod = atr10
      }
    } else {
      if (agg.on_high == null || bar.high > agg.on_high) agg.on_high = bar.high
      if (agg.on_low == null || bar.low < agg.on_low) agg.on_low = bar.low
      agg.on_bar_count += 1
    }
  }

  // Sweep new dates for the same "≥60 RTH bars" filter the CSV stream uses.
  for (const date of newDateSet) {
    const agg = days.get(date)
    if (agg && agg.rth_bar_count < 60) {
      console.log(`  .scid: skipping ${date} — only ${agg.rth_bar_count} RTH bars (incomplete day)`)
      days.delete(date)
    } else if (agg) {
      datesTouched++
    }
  }
  console.log(`  .scid contributed ${datesTouched} new trading days to the aggregate`)
}

interface DayMetrics {
  date: string
  rvol_percent: number | null   // null when there's no 10-day trailing baseline
  ib_size: number | null
  ib_vs_10d_avg: number | null  // today's IB size / trailing-10 avg IB size
  adr: number | null
  atr_1m: number | null         // EOD ATR from our Wilder-10 (falls back to Sierra's column)
  // --- IB-close snapshot fields (07:29 PT) ---
  rvol_at_ib_close: number | null   // percent: IB-window vol / trailing-10 avg IB-window vol × 100
  atr_at_ib_close: number | null    // Wilder ATR-10 at 07:29
  atr_10d_avg: number | null        // trailing-10 avg of atr_at_ib_close
  rth_open: number | null
  ib_close_price: number | null
  // --- Structural levels needed by derive-day-types ---
  pdh: number | null            // prior weekday's RTH high
  pdl: number | null            // prior weekday's RTH low
  ibh: number | null            // today's IB high
  ibl: number | null            // today's IB low
  onh: number | null            // overnight high (ETH-late prior + ETH-early today)
  onl: number | null            // overnight low
}

function computeMetrics(days: Map<string, DayAggregate>): Map<string, DayMetrics> {
  // Walk dates in chronological order so trailing windows are cheap.
  const sorted = Array.from(days.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
  const out = new Map<string, DayMetrics>()

  // Trailing-10 deques. Each metric gets its own window so missing values
  // on a given day don't desync the others (e.g. holiday half-day with no
  // formed IB still has full-day volume).
  const trailVol: number[] = []
  const trailRange: number[] = []
  const trailIb: number[] = []
  const trailIbVol: number[] = []
  const trailAtrIb: number[] = []
  // Prior weekday's RTH high/low — used for PDH/PDL. Tracks the most
  // recent fully-aggregated weekday so Monday's PDH = Friday's RTH high.
  let prevDayHigh: number | null = null
  let prevDayLow: number | null = null

  for (const d of sorted) {
    const range = d.high - d.low

    const rvolPercent = trailVol.length >= 10
      ? (d.volume / (trailVol.reduce((s, v) => s + v, 0) / trailVol.length)) * 100
      : null
    const adr = trailRange.length >= 10
      ? trailRange.reduce((s, v) => s + v, 0) / trailRange.length
      : null
    const ibSize = (d.ib_high != null && d.ib_low != null) ? d.ib_high - d.ib_low : null
    const ibVs10d = (ibSize != null && trailIb.length >= 10)
      ? ibSize / (trailIb.reduce((s, v) => s + v, 0) / trailIb.length)
      : null

    // IB-close snapshots
    const rvolAtIb = (trailIbVol.length >= 10 && trailIbVol.reduce((s, v) => s + v, 0) > 0)
      ? (d.ib_volume / (trailIbVol.reduce((s, v) => s + v, 0) / trailIbVol.length)) * 100
      : null
    const atrIb10d = (trailAtrIb.length >= 10)
      ? trailAtrIb.reduce((s, v) => s + v, 0) / trailAtrIb.length
      : null

    // ATR EOD — prefer our Wilder-10 snapshot at 12:59, fall back to
    // Sierra's last-bar ATR if the streamer didn't seed in time (e.g.
    // very first days of the CSV).
    const atrEod = d.atr_at_eod ?? d.atr_last_sierra

    out.set(d.date, {
      date: d.date,
      rvol_percent: rvolPercent,
      ib_size: ibSize,
      ib_vs_10d_avg: ibVs10d,
      adr,
      atr_1m: atrEod,
      rvol_at_ib_close: rvolAtIb,
      atr_at_ib_close: d.atr_at_ib_close,
      atr_10d_avg: atrIb10d,
      rth_open: d.rth_open,
      ib_close_price: d.ib_close_price,
      pdh: prevDayHigh,
      pdl: prevDayLow,
      ibh: d.ib_high,
      ibl: d.ib_low,
      onh: d.on_high,
      onl: d.on_low,
    })

    // Append AFTER computing today (today doesn't count toward its own trailing avg).
    trailVol.push(d.volume)
    trailRange.push(range)
    if (ibSize != null) trailIb.push(ibSize)
    if (d.ib_volume > 0) trailIbVol.push(d.ib_volume)
    if (d.atr_at_ib_close != null) trailAtrIb.push(d.atr_at_ib_close)
    if (trailVol.length > 10) trailVol.shift()
    if (trailRange.length > 10) trailRange.shift()
    if (trailIb.length > 10) trailIb.shift()
    if (trailIbVol.length > 10) trailIbVol.shift()
    if (trailAtrIb.length > 10) trailAtrIb.shift()

    // Today becomes tomorrow's PDH/PDL.
    prevDayHigh = d.high
    prevDayLow = d.low
  }
  return out
}

async function backfill(metrics: Map<string, DayMetrics>): Promise<void> {
  const force = argv.includes('--force')

  // Distinct dates that need market_context. Union of:
  //   - historical_trades.trade_date (TZ-imported trades)
  //   - trading_days.date (native prep + EOD work — including recent days
  //     like 6/5 and 6/8 the user wants IB-close fields populated for)
  // This way the .scid fallback path actually feeds the recent native
  // days, not just whatever ancient TZ dates happen to overlap.
  const { data: histDates } = await sb
    .from('historical_trades')
    .select('trade_date')
  const { data: nativeDates } = await sb
    .from('trading_days')
    .select('date')
  const wantedSet = new Set<string>()
  for (const r of (histDates ?? []) as { trade_date: string | null }[]) {
    if (r.trade_date) wantedSet.add(r.trade_date)
  }
  for (const r of (nativeDates ?? []) as { date: string | null }[]) {
    if (r.date) wantedSet.add(r.date)
  }
  const wanted = Array.from(wantedSet).sort()
  console.log(`wanted dates: ${wanted.length} (historical_trades ∪ trading_days)`)

  // Existing trading_days keyed by date so we don't recreate.
  // Chunk the .in() to keep the URL under the practical cap — `wanted`
  // can be 1500+ entries now that it unions historical + native dates.
  const dayIdByDate = new Map<string, string>()
  const DATE_CHUNK = 400
  for (let i = 0; i < wanted.length; i += DATE_CHUNK) {
    const chunk = wanted.slice(i, i + DATE_CHUNK)
    const { data } = await sb
      .from('trading_days')
      .select('id, date')
      .in('date', chunk)
    for (const r of (data ?? []) as { id: string; date: string }[]) {
      dayIdByDate.set(r.date, r.id)
    }
  }
  console.log(`  ${dayIdByDate.size} dates already have a trading_days row; ${wanted.length - dayIdByDate.size} stubs to create`)

  // Create stub trading_days rows for the missing dates.
  const missingDates = wanted.filter(d => !dayIdByDate.has(d))
  if (missingDates.length > 0 && !dryRun) {
    const { data: inserted, error } = await sb
      .from('trading_days')
      .insert(missingDates.map(date => ({ date })))
      .select('id, date')
    if (error) throw new Error(`trading_days stub insert: ${error.message}`)
    for (const r of (inserted ?? []) as { id: string; date: string }[]) {
      dayIdByDate.set(r.date, r.id)
    }
    console.log(`  inserted ${inserted?.length ?? 0} trading_days stubs`)
  } else if (missingDates.length > 0) {
    console.log(`  [dry-run] would insert ${missingDates.length} trading_days stubs`)
  }

  // Find which trading_day_ids ALREADY have a market_context. Those were
  // most likely populated by /api/extract-context from a prep screenshot,
  // which we trust as the authoritative source. Skip them by default; pass
  // --force to overwrite (e.g. if you re-export the CSV with later dates).
  const allIds = Array.from(dayIdByDate.values())
  const hasContextIds = new Set<string>()
  // .in() has a practical URL-length cap; chunk to be safe.
  const ID_CHUNK = 500
  for (let i = 0; i < allIds.length; i += ID_CHUNK) {
    const chunk = allIds.slice(i, i + ID_CHUNK)
    const { data: ctxRows } = await sb
      .from('market_context')
      .select('trading_day_id')
      .in('trading_day_id', chunk)
    for (const r of (ctxRows ?? []) as { trading_day_id: string }[]) {
      hasContextIds.add(r.trading_day_id)
    }
  }
  console.log(`  ${hasContextIds.size} of ${allIds.length} mapped trading_days already have market_context${force ? ' (--force: will overwrite)' : ' (will skip)'}`)

  // Build market_context payload — skip existing rows unless --force.
  // PayloadRow mirrors the new market_context schema (after the 2026-06-08
  // ib_close columns migration). When the migration hasn't been applied
  // yet, the upsert will error on the new columns — apply the SQL in the
  // Supabase dashboard first.
  interface PayloadRow {
    trading_day_id: string
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
    pdh: number | null
    pdl: number | null
    ibh: number | null
    ibl: number | null
    onh: number | null
    onl: number | null
  }
  const payload: PayloadRow[] = []
  let missingMetrics = 0
  let skippedExisting = 0
  for (const date of wanted) {
    const m = metrics.get(date)
    if (!m) { missingMetrics++; continue }
    const id = dayIdByDate.get(date)
    if (!id) { missingMetrics++; continue }
    if (!force && hasContextIds.has(id)) { skippedExisting++; continue }
    payload.push({
      trading_day_id: id,
      rvol: m.rvol_percent,
      ib_size: m.ib_size,
      ib_vs_10d_avg: m.ib_vs_10d_avg,
      adr: m.adr,
      atr_1m: m.atr_1m,
      rvol_at_ib_close: m.rvol_at_ib_close,
      atr_at_ib_close: m.atr_at_ib_close,
      atr_10d_avg: m.atr_10d_avg,
      rth_open: m.rth_open,
      ib_close_price: m.ib_close_price,
      pdh: m.pdh,
      pdl: m.pdl,
      ibh: m.ibh,
      ibl: m.ibl,
      onh: m.onh,
      onl: m.onl,
    })
  }
  console.log(`  market_context writes: ${payload.length}; ${skippedExisting} already-populated dates skipped; ${missingMetrics} dates skipped (no CSV coverage)`)

  // Sample the MOST RECENT 5 so the user can sanity-check against days
  // they actually remember trading. Payload is built in ascending date
  // order (from `wanted.sort()`), so slice(-5) gives the newest covered
  // dates in the CSV. The earliest CSV days (2024-03 seed period) are
  // less interesting since you can't easily verify their stats from memory.
  for (const row of payload.slice(-5)) {
    const date = wanted.find(d => dayIdByDate.get(d) === row.trading_day_id)
    console.log(`    ${date}:`)
    console.log(`      rvol=${row.rvol?.toFixed(0) ?? '—'}% rvol@IB=${row.rvol_at_ib_close?.toFixed(0) ?? '—'}% adr=${row.adr?.toFixed(1) ?? '—'}`)
    console.log(`      ib=${row.ib_size?.toFixed(1) ?? '—'} (${row.ib_vs_10d_avg?.toFixed(2) ?? '—'}× 10d) ATR-EOD=${row.atr_1m?.toFixed(2) ?? '—'} ATR@IB=${row.atr_at_ib_close?.toFixed(2) ?? '—'} ATR-10d=${row.atr_10d_avg?.toFixed(2) ?? '—'}`)
    console.log(`      rth_open=${row.rth_open ?? '—'} ib_close=${row.ib_close_price ?? '—'}`)
    console.log(`      PDH/PDL=${row.pdh ?? '—'}/${row.pdl ?? '—'} ONH/ONL=${row.onh ?? '—'}/${row.onl ?? '—'} IBH/IBL=${row.ibh ?? '—'}/${row.ibl ?? '—'}`)
  }

  if (dryRun) {
    console.log('[dry-run] no DB writes performed.')
    return
  }

  // Upsert keyed on trading_day_id (market_context has it as a unique FK).
  const CHUNK = 500
  let written = 0
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK)
    const { error } = await sb
      .from('market_context')
      .upsert(chunk, { onConflict: 'trading_day_id' })
    if (error) { console.error('  market_context upsert error:', error.message); break }
    written += chunk.length
  }
  console.log(`  wrote ${written} market_context rows`)
}

async function main() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY not in env — did .env.local load?')
  }
  const { days, endingAtr } = await streamAggregate(csvPath)
  console.log(`Aggregated ${days.size} unique RTH dates from CSV (Wilder ATR-10 ending at ${endingAtr?.toFixed(2) ?? 'null'})`)

  // .scid fallback for the post-CSV tail. Latest day we currently have is
  // the end-of-CSV — start the .scid read from one minute past that day's
  // RTH close so we don't double-count any boundary bars. End at "now".
  if (!csvOnly) {
    const sortedDates = Array.from(days.keys()).sort()
    const latestCsvDate = sortedDates[sortedDates.length - 1]
    if (latestCsvDate) {
      // RTH close of last CSV day in UTC. PDT in summer = UTC-7, PST = UTC-8.
      // Using PT 13:30 (5 min past RTH close to be safe) converted to UTC via
      // Intl. We treat the PT timestamp as naive and let Intl figure out DST.
      const [y, m, d] = latestCsvDate.split('-').map(Number)
      // Approximate: build the UTC ms for that day at 21:00 UTC (14:00 PT-ish
      // — covers both PST and PDT) and start from there. Slight overlap with
      // CSV is harmless (Map operations are idempotent under max/min).
      const startMs = Date.UTC(y, m - 1, d, 21, 0, 0)
      const endMs = Date.now()
      try {
        extendAggregateWithScid(days, FALLBACK_SCID, startMs, endMs, endingAtr)
      } catch (e) {
        console.warn(`  .scid extension failed: ${(e as Error).message}`)
        console.warn(`  proceeding with CSV-only data — recent days won't have IB-close fields`)
      }
    }
  } else {
    console.log('--csv-only: skipping .scid extension')
  }

  const metrics = computeMetrics(days)
  await backfill(metrics)
  console.log('Done.')
}

main().catch(e => { console.error(e); process.exit(1) })
