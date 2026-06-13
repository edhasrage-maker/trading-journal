/**
 * Backfill trades.mfe_dollars_per_leg (and historical_trades.mfe_dollars_per_leg)
 * with the scaling-aware MFE max-possible dollars.
 *
 * Pipeline (mirrors backfill-historical-mfe.ts):
 *   1. Stream the 1m CSV (continuous-contract NQ, 2024-03-20 → 2026-03-20),
 *      keeping per-bar [utcMs, high, low] in a sorted array.
 *   2. Extend with NQM6.scid bars for the post-CSV tail.
 *   3. For each trade with exits_json present:
 *        - Walk the legs chronologically
 *        - For each leg: find the peak high (long) / low (short) in
 *          [windowStart, leg.time] where windowStart = entry_time on first
 *          leg, else previous leg's exit time
 *        - leg_max = max(0, isLong ? peak - entry : entry - peak) × qty × multiplier
 *        - Sum across legs → mfe_dollars_per_leg
 *      For trades WITHOUT exits_json (single-leg or legacy), reuse the
 *      overall trade's high/low_during_position with full quantity (same
 *      as the simple captureComponents formula). Keeps the column dense
 *      so aggregations don't need to fall back per trade.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-per-leg-mfe.ts [--dry-run] [--force] [--limit=N]
 *
 * Defaults to overwrite-existing=false (only fills nulls). Use --force to
 * overwrite (e.g. after fixing a bug in the leg walk).
 *
 * Schema dependency: 2026-06-09 per_leg_mfe_dollars migration applied.
 */

import { createReadStream, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'

const DEFAULT_CSV = 'D:\\Documents\\Trading\\Trading Journal\\docs\\NQ_1m _R24_Market Data_5.04.26.csv'
const FALLBACK_SCID = 'D:\\SierraCharts\\Data\\NQM6.CME.scid'

const COL_DATE = 0
const COL_TIME = 1
const COL_HIGH = 3
const COL_LOW = 4

// Multiplier per symbol — mirrors src/lib/futures-symbols.ts. Hardcoded here
// so the script doesn't pull the whole client lib in.
const MULTIPLIERS: Record<string, number> = {
  NQ: 20, MNQ: 2, ES: 50, MES: 5, YM: 5, MYM: 0.5, RTY: 50, M2K: 5,
}
function symbolToMultiplier(symbol: string | null | undefined): number {
  if (!symbol) return 1
  // Strip exchange suffix (.CME, etc.) and contract month code (M6, U5, …)
  const root = symbol.replace(/\.[A-Z]+$/, '').replace(/[HMUZ]\d+$/, '')
  return MULTIPLIERS[root] ?? 1
}

// Load .env.local
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
const force = argv.includes('--force')
const limitArg = argv.find(a => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity

interface Bar {
  utcMs: number
  high: number
  low: number
}

function ptWallToUtcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(naiveUtc))
  const p: Record<string, string> = {}
  for (const x of parts) p[x.type] = x.value
  const ptHour = p.hour === '24' ? 0 : parseInt(p.hour)
  const ptAsUtc = Date.UTC(
    parseInt(p.year), parseInt(p.month) - 1, parseInt(p.day),
    ptHour, parseInt(p.minute), parseInt(p.second),
  )
  return naiveUtc + (naiveUtc - ptAsUtc)
}

async function streamBars(path: string): Promise<Bar[]> {
  console.log(`Reading ${path}…`)
  const bars: Bar[] = []
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
    if (parts.length < 5) continue
    const dateRaw = parts[COL_DATE].trim()
    const timeRaw = parts[COL_TIME].trim()
    const high = Number(parts[COL_HIGH])
    const low = Number(parts[COL_LOW])
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue
    const [yStr, mStr, dStr] = dateRaw.split('-')
    const year = parseInt(yStr), month = parseInt(mStr), day = parseInt(dStr)
    if (!year || !month || !day) continue
    const [hh, mm, ssRaw] = timeRaw.split(':')
    const ss = ssRaw ? parseInt(ssRaw.split('.')[0]) : 0
    const utcMs = ptWallToUtcMs(year, month, day, parseInt(hh), parseInt(mm), ss)
    bars.push({ utcMs, high, low })
    if (lineCount % 100000 === 0) {
      process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${bars.length.toLocaleString()} bars\r`)
    }
  }
  process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${bars.length.toLocaleString()} bars total\n`)
  bars.sort((a, b) => a.utcMs - b.utcMs)
  return bars
}

function lowerBound(bars: Bar[], target: number): number {
  let lo = 0, hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bars[mid].utcMs < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Walk bars in [windowStartMs, windowEndMs] and return peak high (long) or
 *  peak low (short). Returns null when no bars fall in the window. */
function findFavorablePeak(bars: Bar[], windowStartMs: number, windowEndMs: number, isLong: boolean): number | null {
  let lo = lowerBound(bars, windowStartMs)
  if (lo > 0) lo -= 1  // include bar containing the boundary tick
  const hi = lowerBound(bars, windowEndMs + 60_000)
  if (lo >= bars.length || hi <= 0) return null
  let peak = isLong ? -Infinity : Infinity
  let found = false
  for (let i = Math.max(0, lo); i < hi; i++) {
    const b = bars[i]
    if (isLong) {
      if (b.high > peak) { peak = b.high; found = true }
    } else {
      if (b.low < peak) { peak = b.low; found = true }
    }
  }
  return found ? peak : null
}

interface ExitLeg { time: string; price: number; qty: number }

interface TradeRow {
  table: 'trades' | 'historical_trades'
  id: string
  entry_ms: number
  exit_ms: number | null  // for single-leg fallback bars walk when high/low_during_position is null
  entry_price: number | null
  direction: 'long' | 'short' | null
  quantity: number | null
  symbol: string | null
  exits_json: ExitLeg[] | null
  high_during_position: number | null
  low_during_position: number | null
  mfe_dollars_per_leg: number | null
}

async function fetchTrades(): Promise<TradeRow[]> {
  const PAGE = 1000
  const out: TradeRow[] = []
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('trades')
      .select('id, entry_time, exit_time, entry_price, direction, quantity, symbol, exits_json, high_during_position, low_during_position, mfe_dollars_per_leg')
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('mfe_dollars_per_leg', null)
    const { data, error } = await q
    if (error) { console.error('  fetch trades page', p, error.message); break }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]
    for (const r of rows) {
      if (!r.entry_time) continue
      const ms = Date.parse(r.entry_time)
      if (!Number.isFinite(ms)) continue
      const exitMs = r.exit_time ? Date.parse(r.exit_time) : NaN
      out.push({
        table: 'trades', id: r.id, entry_ms: ms,
        exit_ms: Number.isFinite(exitMs) ? exitMs : null,
        entry_price: r.entry_price, direction: r.direction, quantity: r.quantity,
        symbol: r.symbol, exits_json: r.exits_json,
        high_during_position: r.high_during_position, low_during_position: r.low_during_position,
        mfe_dollars_per_leg: r.mfe_dollars_per_leg,
      })
    }
    if (rows.length < PAGE) break
  }
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('historical_trades')
      .select('id, open_at, close_at, entry_price, side, quantity, symbol, high_during_position, low_during_position, mfe_dollars_per_leg')
      .order('open_at', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('mfe_dollars_per_leg', null)
    const { data, error } = await q
    if (error) { console.error('  fetch historical_trades page', p, error.message); break }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]
    for (const r of rows) {
      if (!r.open_at) continue
      const ms = Date.parse(r.open_at)
      if (!Number.isFinite(ms)) continue
      const closeMs = r.close_at ? Date.parse(r.close_at) : NaN
      out.push({
        table: 'historical_trades', id: r.id, entry_ms: ms,
        exit_ms: Number.isFinite(closeMs) ? closeMs : null,
        entry_price: r.entry_price,
        direction: (r.side === 'long' || r.side === 'short') ? r.side : null,
        quantity: r.quantity, symbol: r.symbol,
        exits_json: null,  // TZ historical trades don't carry exits_json yet
        high_during_position: r.high_during_position, low_during_position: r.low_during_position,
        mfe_dollars_per_leg: r.mfe_dollars_per_leg,
      })
    }
    if (rows.length < PAGE) break
  }
  return out
}

type SkipReason =
  | 'no_direction' | 'no_entry_price' | 'no_quantity'
  | 'bad_leg_time' | 'bar_gap_multileg'
  | 'no_window_end_singleleg' | 'bar_gap_singleleg'

type ComputeResult =
  | { ok: true; value: number; path: 'multileg' | 'single_excursion' | 'single_bars' }
  | { ok: false; reason: SkipReason }

/** Compute per-leg max for one trade.
 *
 * Multi-leg path: walk exits_json chronologically, find peak per leg from bars.
 * Single-leg path: prefer pre-backfilled high/low_during_position; otherwise
 *  walk bars [entry_ms, exit_ms]. The bars walk is what makes this script
 *  populate native trades that don't carry exits_json and don't have
 *  high/low_during_position from the historical-MFE backfill (which only runs
 *  on historical_trades). */
function computePerLegMax(t: TradeRow, bars: Bar[]): ComputeResult {
  if (t.direction == null) return { ok: false, reason: 'no_direction' }
  if (t.entry_price == null) return { ok: false, reason: 'no_entry_price' }
  if (t.quantity == null) return { ok: false, reason: 'no_quantity' }
  const mult = symbolToMultiplier(t.symbol)
  const isLong = t.direction === 'long'

  // Multi-leg path — walk exits_json
  if (Array.isArray(t.exits_json) && t.exits_json.length > 0) {
    const legs = [...t.exits_json].sort((a, b) => a.time.localeCompare(b.time))
    let total = 0
    let windowStartMs = t.entry_ms
    for (const leg of legs) {
      const legMs = Date.parse(leg.time)
      if (!Number.isFinite(legMs)) return { ok: false, reason: 'bad_leg_time' }
      const peak = findFavorablePeak(bars, windowStartMs, legMs, isLong)
      if (peak == null) return { ok: false, reason: 'bar_gap_multileg' }
      const exc = isLong ? Math.max(0, peak - t.entry_price) : Math.max(0, t.entry_price - peak)
      total += exc * leg.qty * mult
      windowStartMs = legMs
    }
    return { ok: true, value: total, path: 'multileg' }
  }

  // Single-leg path — prefer pre-backfilled excursion fields, then bars walk.
  const cached = isLong ? t.high_during_position : t.low_during_position
  if (cached != null) {
    const exc = isLong
      ? Math.max(0, cached - t.entry_price)
      : Math.max(0, t.entry_price - cached)
    return { ok: true, value: exc * t.quantity * mult, path: 'single_excursion' }
  }

  // Last resort: walk bars between entry and exit and find the peak. This is
  // what catches the bulk of native trades that don't store excursion fields
  // and don't carry exits_json. Requires exit_time to bound the window.
  if (t.exit_ms == null) return { ok: false, reason: 'no_window_end_singleleg' }
  const peak = findFavorablePeak(bars, t.entry_ms, t.exit_ms, isLong)
  if (peak == null) return { ok: false, reason: 'bar_gap_singleleg' }
  const exc = isLong
    ? Math.max(0, peak - t.entry_price)
    : Math.max(0, t.entry_price - peak)
  return { ok: true, value: exc * t.quantity * mult, path: 'single_bars' }
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, force=${force}, limit=${limit === Infinity ? 'none' : limit}`)
  console.log()

  const bars = await streamBars(DEFAULT_CSV)
  if (bars.length === 0) {
    console.error('No CSV bars parsed — aborting.')
    process.exit(1)
  }
  const csvCutoffMs = bars[bars.length - 1].utcMs + 60_000
  console.log(`CSV bars: ${bars.length.toLocaleString()}, end ${new Date(bars[bars.length - 1].utcMs).toISOString()}`)

  // Extend with .scid for post-CSV trades
  let scidBars: Bar[] = []
  try {
    const startMs = csvCutoffMs
    const endMs = Date.now()
    const r = readScidBars(FALLBACK_SCID, startMs, endMs, { priceDivisor: 100, bucketMs: 60_000 })
    scidBars = r.bars.map(b => ({ utcMs: new Date(b.ts).getTime(), high: b.high, low: b.low }))
    console.log(`SCID bars (post-CSV): ${scidBars.length.toLocaleString()}`)
  } catch (e) {
    console.warn(`  .scid read failed: ${(e as Error).message}; continuing with CSV only`)
  }

  const allBars = [...bars, ...scidBars].sort((a, b) => a.utcMs - b.utcMs)
  console.log(`Total bars: ${allBars.length.toLocaleString()}`)
  console.log()

  console.log('Fetching trades…')
  const trades = await fetchTrades()
  console.log(`Loaded ${trades.length} trade(s) needing backfill${force ? ' (--force)' : ' (only nulls)'}`)
  console.log()

  const updates: Array<{ table: 'trades' | 'historical_trades'; id: string; mfe_dollars_per_leg: number }> = []
  const skipReasons: Record<SkipReason, number> = {
    no_direction: 0, no_entry_price: 0, no_quantity: 0,
    bad_leg_time: 0, bar_gap_multileg: 0,
    no_window_end_singleleg: 0, bar_gap_singleleg: 0,
  }
  const pathCounts: Record<'multileg' | 'single_excursion' | 'single_bars', number> = {
    multileg: 0, single_excursion: 0, single_bars: 0,
  }
  let processed = 0
  let samplesPrinted = 0
  const SAMPLE_N = 5

  for (const t of trades) {
    if (processed >= limit) break
    const r = computePerLegMax(t, allBars)
    if (!r.ok) { skipReasons[r.reason]++; continue }
    const rounded = Math.round(r.value * 100) / 100
    updates.push({ table: t.table, id: t.id, mfe_dollars_per_leg: rounded })
    pathCounts[r.path]++
    processed++
    if (samplesPrinted < SAMPLE_N) {
      const legs = t.exits_json?.length ?? 0
      console.log(`  sample #${samplesPrinted + 1}: ${t.table.padEnd(16)} ${t.direction?.padEnd(5)}  entry=${t.entry_price}  qty=${t.quantity}  legs=${legs}  path=${r.path.padEnd(17)} per-leg-max=$${rounded.toFixed(2)}`)
      samplesPrinted++
    }
  }

  console.log()
  console.log(`Candidates: ${updates.length}`)
  console.log(`  by path:`)
  console.log(`    multileg          (exits_json walk):     ${pathCounts.multileg}`)
  console.log(`    single_excursion  (cached high/low):     ${pathCounts.single_excursion}`)
  console.log(`    single_bars       (entry→exit bars walk): ${pathCounts.single_bars}`)
  const skipTotal = Object.values(skipReasons).reduce((a, b) => a + b, 0)
  console.log(`Skipped: ${skipTotal}`)
  console.log(`  by reason:`)
  console.log(`    no_direction:             ${skipReasons.no_direction}`)
  console.log(`    no_entry_price:           ${skipReasons.no_entry_price}`)
  console.log(`    no_quantity:              ${skipReasons.no_quantity}`)
  console.log(`    bad_leg_time:             ${skipReasons.bad_leg_time}`)
  console.log(`    bar_gap_multileg:         ${skipReasons.bar_gap_multileg}`)
  console.log(`    no_window_end_singleleg:  ${skipReasons.no_window_end_singleleg}`)
  console.log(`    bar_gap_singleleg:        ${skipReasons.bar_gap_singleleg}`)

  if (dryRun) {
    console.log('\nDry run — no writes.')
    return
  }

  // Group by table for clean reporting; update in batches.
  const byTable = new Map<'trades' | 'historical_trades', typeof updates>()
  for (const u of updates) {
    let arr = byTable.get(u.table)
    if (!arr) { arr = []; byTable.set(u.table, arr) }
    arr.push(u)
  }
  let wroteTotal = 0
  for (const [table, arr] of byTable) {
    const BATCH = 200
    let wrote = 0
    for (let i = 0; i < arr.length; i += BATCH) {
      const batch = arr.slice(i, i + BATCH)
      const results = await Promise.all(batch.map(u =>
        sb.from(table).update({ mfe_dollars_per_leg: u.mfe_dollars_per_leg }).eq('id', u.id),
      ))
      for (const r of results) {
        if (r.error) console.error(`  ${table} update failed:`, r.error.message)
        else wrote++
      }
      process.stdout.write(`  ${table}: wrote ${wrote}/${arr.length}\r`)
    }
    console.log(`\n  ${table}: wrote ${wrote}`)
    wroteTotal += wrote
  }
  console.log(`\nDone. Total rows updated: ${wroteTotal}`)
}

main().catch(e => { console.error(e); process.exit(1) })
