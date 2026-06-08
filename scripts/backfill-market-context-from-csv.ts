/**
 * Backfill market_context (and a stub trading_days row when missing) for
 * every unique date in historical_trades using a Sierra-exported 1m CSV.
 *
 * Why this exists: Tradezella history doesn't carry RVol/IB/ADR/ATR, so
 * those 132 historical trades all bucket under "Unknown" in the analytics
 * Performance-by-Market-Condition charts. This script reads the local NQ
 * 1m CSV, aggregates per-day RTH stats, and writes market_context rows
 * keyed to a trading_day_id so those trades light up in the buckets.
 *
 * Dates not covered by the CSV (after CSV's max date) are skipped — a
 * second pass against fresh .scid exports can fill the tail later.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-market-context-from-csv.ts [csv-path] [--dry-run]
 *
 * Defaults to D:\SierraCharts\Data\NQ_1m _R24_Market Data_5.04.26.csv.
 */

import { createReadStream, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { createClient } from '@supabase/supabase-js'

const DEFAULT_CSV = 'D:\\SierraCharts\\Data\\NQ_1m _R24_Market Data_5.04.26.csv'

// Column indices in the Sierra export. Verified against the header row.
const COL_DATE = 0
const COL_TIME = 1
const COL_HIGH = 3
const COL_LOW = 4
const COL_VOLUME = 6
const COL_ATR = 16

// RTH in PT (06:30:00 → 13:00:00). IB is the first 60 mins (06:30 → 07:29).
const RTH_OPEN_SEC = 6 * 3600 + 30 * 60         // 23400
const IB_CLOSE_SEC = 7 * 3600 + 30 * 60         // 27000
const RTH_CLOSE_SEC = 13 * 3600                 // 46800

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
const csvPath = argv.find(a => !a.startsWith('--')) ?? DEFAULT_CSV

interface DayAggregate {
  date: string                // YYYY-MM-DD
  volume: number
  high: number
  low: number
  ib_high: number | null
  ib_low: number | null
  atr_last: number | null    // ATR value from the last RTH bar of the day
  rth_bar_count: number
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

async function streamAggregate(path: string): Promise<Map<string, DayAggregate>> {
  console.log(`Reading ${path}…`)
  const days = new Map<string, DayAggregate>()
  let lineCount = 0
  let headerSkipped = false

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
    if (sec < RTH_OPEN_SEC || sec >= RTH_CLOSE_SEC) continue  // outside RTH

    const date = normalizeDate(parts[COL_DATE])
    const high = Number(parts[COL_HIGH])
    const low = Number(parts[COL_LOW])
    const vol = Number(parts[COL_VOLUME])
    const atr = Number(parts[COL_ATR])

    if (!Number.isFinite(high) || !Number.isFinite(low)) continue

    let agg = days.get(date)
    if (!agg) {
      agg = {
        date, volume: 0, high: -Infinity, low: Infinity,
        ib_high: null, ib_low: null, atr_last: null, rth_bar_count: 0,
      }
      days.set(date, agg)
    }

    agg.volume += Number.isFinite(vol) ? vol : 0
    if (high > agg.high) agg.high = high
    if (low < agg.low) agg.low = low
    agg.rth_bar_count += 1
    if (Number.isFinite(atr)) agg.atr_last = atr  // last-write-wins; bars stream in chrono order per date

    // IB window: 06:30 → 07:29 inclusive.
    if (sec >= RTH_OPEN_SEC && sec < IB_CLOSE_SEC) {
      if (agg.ib_high == null || high > agg.ib_high) agg.ib_high = high
      if (agg.ib_low == null || low < agg.ib_low) agg.ib_low = low
    }

    if (lineCount % 100000 === 0) {
      process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${days.size} dates so far\r`)
    }
  }
  process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${days.size} dates total\n`)

  // Drop dates with too few RTH bars (holidays, half-days that don't span IB).
  // Keep half-days but skip anything under 60 bars — IB wasn't fully formed.
  for (const [date, agg] of days) {
    if (agg.rth_bar_count < 60) {
      console.log(`  skipping ${date}: only ${agg.rth_bar_count} RTH bars (likely holiday/early-close)`)
      days.delete(date)
    }
  }

  return days
}

interface DayMetrics {
  date: string
  rvol_percent: number | null   // null when there's no 10-day trailing baseline
  ib_size: number | null
  adr: number | null
  atr_1m: number | null
}

function computeMetrics(days: Map<string, DayAggregate>): Map<string, DayMetrics> {
  // Walk dates in chronological order so trailing windows are cheap.
  const sorted = Array.from(days.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
  const out = new Map<string, DayMetrics>()

  // Trailing-10 deques for volume and range.
  const trailVol: number[] = []
  const trailRange: number[] = []

  for (const d of sorted) {
    const range = d.high - d.low

    const rvolPercent = trailVol.length >= 10
      ? (d.volume / (trailVol.reduce((s, v) => s + v, 0) / trailVol.length)) * 100
      : null
    const adr = trailRange.length >= 10
      ? trailRange.reduce((s, v) => s + v, 0) / trailRange.length
      : null
    const ibSize = (d.ib_high != null && d.ib_low != null) ? d.ib_high - d.ib_low : null

    out.set(d.date, {
      date: d.date,
      rvol_percent: rvolPercent,
      ib_size: ibSize,
      adr,
      atr_1m: d.atr_last,
    })

    // Append AFTER computing today (today doesn't count toward its own trailing avg).
    trailVol.push(d.volume)
    trailRange.push(range)
    if (trailVol.length > 10) trailVol.shift()
    if (trailRange.length > 10) trailRange.shift()
  }
  return out
}

async function backfill(metrics: Map<string, DayMetrics>): Promise<void> {
  const force = argv.includes('--force')

  // Distinct dates that need market_context.
  const { data: histDates } = await sb
    .from('historical_trades')
    .select('trade_date')
  const wanted = Array.from(
    new Set((histDates ?? []).map((r: { trade_date: string | null }) => r.trade_date).filter((d: string | null): d is string => !!d)),
  ).sort() as string[]
  console.log(`historical_trades has ${wanted.length} distinct dates`)

  // Existing trading_days keyed by date so we don't recreate.
  const { data: existingDays } = await sb
    .from('trading_days')
    .select('id, date')
    .in('date', wanted)
  const dayIdByDate = new Map<string, string>()
  for (const r of (existingDays ?? []) as { id: string; date: string }[]) {
    dayIdByDate.set(r.date, r.id)
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
  const payload: Array<{
    trading_day_id: string
    rvol: number | null
    ib_size: number | null
    adr: number | null
    atr_1m: number | null
  }> = []
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
      adr: m.adr,
      atr_1m: m.atr_1m,
    })
  }
  console.log(`  market_context writes: ${payload.length}; ${skippedExisting} already-populated dates skipped; ${missingMetrics} dates skipped (no CSV coverage)`)

  // Sample a few so the user can sanity-check before write.
  for (const row of payload.slice(0, 5)) {
    const date = wanted.find(d => dayIdByDate.get(d) === row.trading_day_id)
    console.log(`    ${date}: rvol=${row.rvol?.toFixed(1) ?? 'null'}% ib=${row.ib_size?.toFixed(2) ?? 'null'} adr=${row.adr?.toFixed(2) ?? 'null'} atr=${row.atr_1m?.toFixed(2) ?? 'null'}`)
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
  const days = await streamAggregate(csvPath)
  console.log(`Aggregated ${days.size} unique RTH dates from CSV`)

  const metrics = computeMetrics(days)
  await backfill(metrics)
  console.log('Done.')
}

main().catch(e => { console.error(e); process.exit(1) })
