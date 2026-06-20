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

// roll = 8 days before the quarterly 3rd-Friday expiry; front-month in
// [prevRoll, thisRoll). NQ price = MNQ price (index level), so this covers both.
const CONTRACTS = [
  { roll: '2023-03-09', file: 'NQH3.CME.scid' },
  { roll: '2023-06-08', file: 'NQM3.CME.scid' },
  { roll: '2023-09-07', file: 'NQU3.CME.scid' },
  { roll: '2023-12-07', file: 'NQZ3.CME.scid' },
  { roll: '2024-03-07', file: 'NQH4.CME.scid' },
  { roll: '2024-06-13', file: 'NQM4.CME.scid' },
  { roll: '2024-09-12', file: 'NQU4.CME.scid' },
  { roll: '2024-12-12', file: 'NQZ4.CME.scid' },
  { roll: '2025-03-13', file: 'NQH5.CME.scid' },
  { roll: '2025-06-12', file: 'NQM5.CME.scid' },
  { roll: '2025-09-11', file: 'NQU5.CME.scid' },
  { roll: '2025-12-11', file: 'NQz5.CME.scid' },
  { roll: '2026-03-12', file: 'NQH6.CME.scid' },
  { roll: '2026-06-11', file: 'NQM6.CME.scid' },
  { roll: '2026-09-11', file: 'NQU6.CME.scid' },
  { roll: '2026-12-11', file: 'NQZ6.CME.scid' },
]

/** Front-month contract .scid filename for a YYYY-MM-DD date, or null if out of
 *  the table's range. */
export function contractFileForDate(date: string): string | null {
  for (const c of CONTRACTS) if (c.roll > date) return c.file
  return null
}
function rollInForDate(date: string): string | null {
  for (let i = 0; i < CONTRACTS.length; i++) if (CONTRACTS[i].roll > date) return i === 0 ? null : CONTRACTS[i - 1].roll
  return null
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
  const file = contractFileForDate(date)
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
