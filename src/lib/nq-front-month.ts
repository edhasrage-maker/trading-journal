/**
 * NQ front-month resolution + on-demand pivot regime for live SC import, so new
 * trades get structure_5m_regime tagged at import time.
 *
 * The CANONICAL values come from scripts/backfill-structure-regime.ts, which
 * runs the full front-month window per contract. This is a bounded-warmup
 * approximation (one .scid read per imported day) — fast enough for the import
 * path; the backfill can correct any edge cases on a re-run. Keep CONTRACTS in
 * sync with the backfill script.
 */
import { join } from 'path'
import { readScidBars } from './scid-reader'
import { findPivots, structureAt, type Regime, type Pivot } from './market-structure'
import { contractsForRoot, contractFileForRoot, rollInForRoot } from './futures-contracts'

/** Front-month contract .scid filename for a YYYY-MM-DD date, or null if out of
 *  the table's range. */
export function contractFileForDate(date: string): string | null {
  return contractFileForRoot('NQ', date)
}
function rollInForDate(date: string): string | null {
  return rollInForRoot('NQ', date)
}

export interface RegimeSeries {
  times: number[]   // epoch seconds, bar open
  seg: number[]     // all zeros (single contract segment)
  pivots: Pivot[]
  confirmIdx: number[]
}

/**
 * Build a single-segment 5m pivot series for `date`'s front-month contract,
 * from a bounded warmup window (≥ the contract's roll-in) up to the end of
 * `date`. Returns null when the .scid is missing/empty or too short to score.
 */
export function buildDayRegimeSeries(dataDir: string, date: string, warmupDays = 20): RegimeSeries | null {
  const file = contractFileForRoot('NQ', date, dataDir)
  if (!file) return null
  const rollIn = rollInForDate(date)
  const warmStart = new Date(Date.parse(date + 'T00:00:00Z') - warmupDays * 86400000).toISOString().slice(0, 10)
  const start = rollIn && rollIn > warmStart ? rollIn : warmStart
  const endMs = Date.parse(date + 'T00:00:00Z') + 86400000  // end of the trading date (UTC)
  let res
  try { res = readScidBars(join(dataDir, file), Date.parse(start + 'T00:00:00Z'), endMs, { priceDivisor: 100, bucketMs: 300_000 }) }
  catch { return null }
  if (res.bars.length < 10) return null
  const times = res.bars.map(b => Math.floor(Date.parse(b.ts) / 1000))
  const closes = res.bars.map(b => b.close)
  const seg = new Array(closes.length).fill(0)
  const pivots = findPivots(closes, seg, 4)
  return { times, seg, pivots, confirmIdx: pivots.map(p => p.confirmIdx) }
}

/**
 * Cloud fallback for buildDayRegimeSeries: build the same K=4 5m pivot series
 * from 1m `ohlcv_bars` rows (the shared bare-root NQ feed) when no local .scid
 * is readable — e.g. the import ran on a machine without Sierra data, or on
 * the deployed build. Rows must be ts-ascending (the later 1m bar in each 5m
 * bucket supplies the close). A few sessions of warmup is enough for the
 * zig-zag to confirm 2 highs + 2 lows; scripts/backfill-structure-regime.ts
 * (full roll-bounded warmup) remains authoritative.
 */
export function buildRegimeSeriesFrom1mBars(rows: Array<{ ts: string; close: number }>): RegimeSeries | null {
  const buckets = new Map<number, number>() // 5m bucket-open epoch sec → last close
  for (const r of rows) {
    const ms = Date.parse(r.ts)
    if (!Number.isFinite(ms) || !Number.isFinite(r.close)) continue
    buckets.set(Math.floor(ms / 300_000) * 300, r.close)
  }
  if (buckets.size < 10) return null
  const times = [...buckets.keys()].sort((a, b) => a - b)
  const closes = times.map(t => buckets.get(t)!)
  const seg = new Array(closes.length).fill(0)
  const pivots = findPivots(closes, seg, 4)
  return { times, seg, pivots, confirmIdx: pivots.map(p => p.confirmIdx) }
}

/** Regime at an entry instant against a prebuilt day series. Null when the entry
 *  is before the series or >15 min from the nearest bar (data gap). */
export function regimeAtEntry(series: RegimeSeries, entryMs: number): Regime | null {
  const ts = Math.floor(entryMs / 1000)
  let lo = 0, hi = series.times.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (series.times[mid] <= ts) lo = mid + 1; else hi = mid }
  const T = lo - 1
  if (T < 0 || ts - series.times[T] > 900) return null
  return structureAt(series.pivots, series.confirmIdx, series.seg, T)
}

const ATR_PERIOD = 10  // matches scripts/backfill-entry-metrics.ts
const RTH_OPEN_SEC = 6 * 3600 + 30 * 60   // 06:30 PT
const RTH_CLOSE_SEC = 13 * 3600           // 13:00 PT

export interface EntryMetricsSeries {
  times: number[]                                 // epoch sec per 1m bar
  atr: (number | null)[]                          // Wilder ATR-10 per 1m bar
  cumVolByDate: Map<string, Map<number, number>>  // PT date → minute-of-day sec → cumulative RTH volume
  rthDates: string[]                              // sorted PT dates that have RTH volume
}

/** UTC ms → America/Los_Angeles date (YYYY-MM-DD) + seconds-of-day. DST-aware. */
function ptDateMinSec(ms: number): { date: string; sec: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value
  const h = o.hour === '24' ? 0 : parseInt(o.hour)
  return { date: `${o.year}-${o.month}-${o.day}`, sec: h * 3600 + parseInt(o.minute) * 60 + parseInt(o.second) }
}

/**
 * Build per-1m-bar Wilder ATR-10 + per-day cumulative RTH volume over a bounded
 * warmup window, STITCHING the front-month across any contract roll inside the
 * window — powers BOTH entry_atr_1m and entry_rvol. Stitching matters right
 * after a roll: each day's volume comes from THAT day's front-month (so RVOL's
 * prior-10-day baseline stays representative), and ATR keeps its warmup across
 * the roll (prevClose resets at each contract boundary so the basis gap isn't a
 * spurious true-range). Default warmup 22d ≈ 10 prior RTH days + buffer. Returns
 * null if no .scid data is available or the series is too short to seed.
 */
export function buildDayEntryMetrics(dataDir: string, date: string, warmupDays = 22): EntryMetricsSeries | null {
  const warmStart = new Date(Date.parse(date + 'T00:00:00Z') - warmupDays * 86400000).toISOString().slice(0, 10)
  const endMs = Date.parse(date + 'T00:00:00Z') + 86400000
  const times: number[] = []
  const atr: (number | null)[] = []
  const cumVolByDate = new Map<string, Map<number, number>>()
  let cur: number | null = null
  const seed: number[] = []
  let curDate: string | null = null
  let cumVol = 0
  // Walk the front-month contracts whose window [prevRoll, roll) intersects
  // [warmStart, end], in time order. ATR (`cur`) carries across; prevClose
  // resets per contract so the roll basis gap isn't a spurious TR.
  const CONTRACTS = contractsForRoot('NQ', dataDir)
  for (let i = 0; i < CONTRACTS.length; i++) {
    const winStart = i === 0 ? '2000-01-01' : CONTRACTS[i - 1].roll
    const winEnd = CONTRACTS[i].roll
    if (winEnd <= warmStart) continue
    const segStartMs = Date.parse((winStart > warmStart ? winStart : warmStart) + 'T00:00:00Z')
    if (segStartMs >= endMs) break
    const segEndMs = Math.min(Date.parse(winEnd + 'T00:00:00Z'), endMs)
    let res
    try { res = readScidBars(join(dataDir, CONTRACTS[i].file), segStartMs, segEndMs, { priceDivisor: 100, bucketMs: 60_000 }) }
    catch { continue }
    let prevClose: number | null = null
    for (const b of res.bars) {
      const tr = prevClose == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
      if (cur == null) {
        seed.push(tr)
        if (seed.length === ATR_PERIOD) cur = seed.reduce((s, v) => s + v, 0) / ATR_PERIOD
      } else {
        cur = ((ATR_PERIOD - 1) * cur + tr) / ATR_PERIOD
      }
      prevClose = b.close
      const ms = Date.parse(b.ts)
      times.push(Math.floor(ms / 1000))
      atr.push(cur)
      // Cumulative RTH volume from the RTH open, reset each new RTH session.
      const { date: pd, sec } = ptDateMinSec(ms)
      if (sec >= RTH_OPEN_SEC && sec < RTH_CLOSE_SEC) {
        if (curDate !== pd) { curDate = pd; cumVol = 0 }
        cumVol += b.volume || 0
        let m = cumVolByDate.get(pd)
        if (!m) { m = new Map(); cumVolByDate.set(pd, m) }
        m.set(Math.floor(sec / 60) * 60, cumVol)
      }
    }
  }
  if (times.length < ATR_PERIOD + 2) return null
  return { times, atr, cumVolByDate, rthDates: [...cumVolByDate.keys()].sort() }
}

/** Wilder ATR-10 at an entry instant. Null when before the series, >15 min from
 *  the nearest bar, or still in the seed window. */
export function atrAtEntry(series: EntryMetricsSeries, entryMs: number): number | null {
  const ts = Math.floor(entryMs / 1000)
  let lo = 0, hi = series.times.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (series.times[mid] <= ts) lo = mid + 1; else hi = mid }
  const T = lo - 1
  if (T < 0 || ts - series.times[T] > 900) return null
  return series.atr[T]
}

/** RVOL at entry = today's cumulative RTH volume at the entry minute ÷ mean of
 *  the prior 10 RTH days' cumVol at the same minute × 100. RTH entries only
 *  (overnight → null); requires a full 10-day prior window. Also null within
 *  ~10 trading days of a contract roll: the new front-month's volume ramp-up
 *  pollutes the baseline, so any ratio there is misleading — null is honest. */
export function rvolAtEntry(series: EntryMetricsSeries, entryMs: number): number | null {
  const { date: pd, sec } = ptDateMinSec(entryMs)
  if (sec < RTH_OPEN_SEC || sec >= RTH_CLOSE_SEC) return null
  const rollIn = rollInForDate(pd)
  if (rollIn && Date.parse(pd + 'T00:00:00Z') - Date.parse(rollIn + 'T00:00:00Z') < 15 * 86400000) return null
  const minuteSec = Math.floor(sec / 60) * 60
  const today = series.cumVolByDate.get(pd)?.get(minuteSec)
  if (today == null) return null
  const samples: number[] = []
  for (let i = series.rthDates.length - 1; i >= 0 && samples.length < 10; i--) {
    const d = series.rthDates[i]
    if (d >= pd) continue
    const v = series.cumVolByDate.get(d)?.get(minuteSec)
    if (v != null) samples.push(v)
  }
  if (samples.length < 10) return null
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length
  return mean > 0 ? (today / mean) * 100 : null
}
