/**
 * Backfill per-trade entry-time ATR + RVOL on both `trades` and
 * `historical_trades`. The analytics ConditionBuckets chart consumes these
 * to bucket each trade by the volatility regime AT THE MINUTE OF ENTRY,
 * rather than by the day's EOD aggregate (which contains lookahead from
 * afternoon volatility the trader hadn't seen yet).
 *
 * Approach:
 *   1. Stream the 1m CSV (continuous-contract NQ, 2024-03-20 → 2026-03-20),
 *      maintaining Wilder's ATR-10 bar-by-bar AND a per-day cumulative
 *      volume tracker from RTH open (06:30 PT) forward.
 *   2. Stream NQM6.scid for the post-CSV tail, continuing both running
 *      states (prevClose resets at the back-adjusted/raw boundary — see
 *      the same note in backfill-market-context-from-csv.ts).
 *   3. For every minute of every RTH session, snapshot { atr10, cumVolFromOpen }
 *      into a Map<date, Map<sec, …>>.
 *   4. For each trade with entry_time ≥ 2025-01-01 and entry_time inside
 *      RTH, look up the corresponding snapshot:
 *         entry_atr_1m = atr10 at (date, sec)
 *         entry_rvol   = today.cumVol / mean(prior-10-days.cumVol at same sec) × 100
 *   5. Write both fields. Trades outside 2025+ stay null (deliberate scope
 *      cut — pre-2025 trades predate the TZ workflow and aren't analytically
 *      important enough to justify the multi-contract .scid plumbing).
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-entry-metrics.ts [--dry-run] [--force] [--limit=N]
 *
 *   --force   overwrite existing entry_atr_1m / entry_rvol values. Default
 *             behavior fills only nulls.
 *   --limit=N process at most N trades per table — useful for calibration.
 *
 * Schema dependency: requires the 2026-06-09 per_trade_entry_metrics migration
 * (adds entry_atr_1m + entry_rvol columns on both tables).
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
const COL_CLOSE = 5
const COL_VOLUME = 6

const RTH_OPEN_SEC = 6 * 3600 + 30 * 60
const RTH_CLOSE_SEC = 13 * 3600
const ATR_PERIOD = 10

// Only backfill 2025+ trades. Pre-2025 native trades predate the TZ
// workflow and aren't worth multi-contract .scid plumbing.
const MIN_TRADE_DATE = '2025-01-01'

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

function normalizeDate(raw: string): string {
  const [y, m, d] = raw.trim().split('-')
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}
function timeToSec(raw: string): number {
  const [hh, mm, ss] = raw.trim().split(':')
  return Number(hh) * 3600 + Number(mm) * 60 + Math.floor(Number(ss))
}

/** UTC ms → America/Los_Angeles wall-clock (date + seconds-of-day). DST-aware. */
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

/** Per-minute snapshot kept for every RTH bar in every covered trading day. */
interface MinuteSnapshot {
  atr10: number | null      // running Wilder ATR-10 (post-seed)
  cumVol: number            // cumulative volume since RTH open today
}

/**
 * The full data structure: date → minute-of-day → snapshot.
 * Size estimate: ~500 days × ~390 RTH bars × ~24 bytes = ~5MB. Easily fits in memory.
 */
type SnapshotMap = Map<string, Map<number, MinuteSnapshot>>

interface StreamState {
  prevClose: number | null
  atr10: number | null
  trSeed: number[]
  currentDate: string | null
  cumVolToday: number
}

function newState(): StreamState {
  return { prevClose: null, atr10: null, trSeed: [], currentDate: null, cumVolToday: 0 }
}

function updateAtr(state: StreamState, high: number, low: number, close: number): void {
  const tr = state.prevClose == null
    ? (high - low)
    : Math.max(high - low, Math.abs(high - state.prevClose), Math.abs(low - state.prevClose))
  if (state.atr10 == null) {
    state.trSeed.push(tr)
    if (state.trSeed.length === ATR_PERIOD) {
      state.atr10 = state.trSeed.reduce((s, v) => s + v, 0) / ATR_PERIOD
    }
  } else {
    state.atr10 = ((ATR_PERIOD - 1) * state.atr10 + tr) / ATR_PERIOD
  }
  state.prevClose = close
}

/** Stream CSV → populate snapshots. Returns the running state at end so the
 *  .scid pass can continue Wilder smoothing across the boundary. */
async function streamCsvSnapshots(path: string, snapshots: SnapshotMap): Promise<StreamState> {
  console.log(`Reading ${path}…`)
  const state = newState()
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
    if (parts.length < 7) continue
    const sec = timeToSec(parts[COL_TIME])
    const date = normalizeDate(parts[COL_DATE])
    const high = Number(parts[COL_HIGH])
    const low = Number(parts[COL_LOW])
    const close = Number(parts[COL_CLOSE])
    const vol = Number(parts[COL_VOLUME])
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue

    updateAtr(state, high, low, close)

    // Reset cumulative volume tracker each time we cross into a new RTH session
    if (sec >= RTH_OPEN_SEC && sec < RTH_CLOSE_SEC) {
      if (state.currentDate !== date) {
        state.currentDate = date
        state.cumVolToday = 0
      }
      state.cumVolToday += Number.isFinite(vol) ? vol : 0
      let dayMap = snapshots.get(date)
      if (!dayMap) { dayMap = new Map(); snapshots.set(date, dayMap) }
      dayMap.set(sec, { atr10: state.atr10, cumVol: state.cumVolToday })
    }

    if (lineCount % 100000 === 0) {
      process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${snapshots.size} RTH days so far\r`)
    }
  }
  process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${snapshots.size} RTH days total\n`)
  return state
}

/** Stream the .scid for [startMs, endMs) → extend snapshots. prevClose
 *  intentionally not carried from CSV (back-adjusted vs raw price gap). */
function streamScidSnapshots(
  scidPath: string,
  startMs: number,
  endMs: number,
  initialAtr: number | null,
  snapshots: SnapshotMap,
): void {
  console.log(`Reading ${scidPath} [${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}]…`)
  const result = readScidBars(scidPath, startMs, endMs, { priceDivisor: 100, bucketMs: 60_000 })
  console.log(`  ${result.bars.length.toLocaleString()} 1m bars from .scid`)
  const state = newState()
  state.atr10 = initialAtr
  let added = 0
  for (const bar of result.bars) {
    const ms = new Date(bar.ts).getTime()
    if (!Number.isFinite(ms)) continue
    updateAtr(state, bar.high, bar.low, bar.close)
    const { date, sec } = utcMsToPtParts(ms)
    if (sec >= RTH_OPEN_SEC && sec < RTH_CLOSE_SEC) {
      if (state.currentDate !== date) {
        state.currentDate = date
        state.cumVolToday = 0
      }
      state.cumVolToday += Number.isFinite(bar.volume) ? bar.volume : 0
      let dayMap = snapshots.get(date)
      if (!dayMap) { dayMap = new Map(); snapshots.set(date, dayMap); added++ }
      dayMap.set(sec, { atr10: state.atr10, cumVol: state.cumVolToday })
    }
  }
  console.log(`  .scid contributed ${added} new RTH days`)
}

/** Find the nearest covered minute at or before `sec` on `date`. Trades' entry
 *  times are seconds-precise but bars are minute-aligned, so we floor. */
function lookupSnapshot(snapshots: SnapshotMap, date: string, sec: number): MinuteSnapshot | null {
  const dayMap = snapshots.get(date)
  if (!dayMap) return null
  // Floor to the minute bar containing `sec`.
  const minuteSec = Math.floor(sec / 60) * 60
  return dayMap.get(minuteSec) ?? null
}

/** Compute mean cumVol at `sec` across the prior `n` covered trading days. */
function meanPriorCumVolAtSec(
  snapshots: SnapshotMap,
  sortedDates: string[],
  todayIdx: number,
  sec: number,
  n: number,
): number | null {
  const minuteSec = Math.floor(sec / 60) * 60
  const samples: number[] = []
  for (let i = todayIdx - 1; i >= 0 && samples.length < n; i--) {
    const prior = snapshots.get(sortedDates[i])
    if (!prior) continue
    const snap = prior.get(minuteSec)
    if (!snap) continue
    samples.push(snap.cumVol)
  }
  if (samples.length < n) return null  // need full window for an honest comparison
  return samples.reduce((s, v) => s + v, 0) / samples.length
}

interface TradeRow {
  table: 'trades' | 'historical_trades'
  id: string
  entry_ms: number
  entry_atr_1m: number | null
  entry_rvol: number | null
}

async function fetchTrades(): Promise<TradeRow[]> {
  const PAGE = 1000
  const out: TradeRow[] = []
  // Native trades — entry_time is the source of truth.
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('trades')
      .select('id, entry_time, entry_atr_1m, entry_rvol')
      .gte('entry_time', `${MIN_TRADE_DATE}T00:00:00Z`)
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('entry_atr_1m', null)
    const { data, error } = await q
    if (error) { console.error('  fetch trades page', p, error.message); break }
    const rows = (data ?? []) as { id: string; entry_time: string | null; entry_atr_1m: number | null; entry_rvol: number | null }[]
    for (const r of rows) {
      if (!r.entry_time) continue
      const ms = Date.parse(r.entry_time)
      if (!Number.isFinite(ms)) continue
      out.push({ table: 'trades', id: r.id, entry_ms: ms, entry_atr_1m: r.entry_atr_1m, entry_rvol: r.entry_rvol })
    }
    if (rows.length < PAGE) break
  }
  // Historical trades — open_at is the entry timestamp.
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('historical_trades')
      .select('id, open_at, entry_atr_1m, entry_rvol')
      .gte('open_at', `${MIN_TRADE_DATE}T00:00:00Z`)
      .order('open_at', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('entry_atr_1m', null)
    const { data, error } = await q
    if (error) { console.error('  fetch historical_trades page', p, error.message); break }
    const rows = (data ?? []) as { id: string; open_at: string | null; entry_atr_1m: number | null; entry_rvol: number | null }[]
    for (const r of rows) {
      if (!r.open_at) continue
      const ms = Date.parse(r.open_at)
      if (!Number.isFinite(ms)) continue
      out.push({ table: 'historical_trades', id: r.id, entry_ms: ms, entry_atr_1m: r.entry_atr_1m, entry_rvol: r.entry_rvol })
    }
    if (rows.length < PAGE) break
  }
  return out
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, force=${force}, limit=${limit === Infinity ? 'none' : limit}`)
  console.log(`Trade date floor: ${MIN_TRADE_DATE}`)
  console.log()

  // Step 1: CSV
  const snapshots: SnapshotMap = new Map()
  const endState = await streamCsvSnapshots(DEFAULT_CSV, snapshots)
  console.log(`Wilder ATR-10 at end of CSV: ${endState.atr10?.toFixed(2) ?? 'null'}`)
  console.log()

  // Step 2: .scid extension
  const sortedDates = Array.from(snapshots.keys()).sort()
  const latestCsvDate = sortedDates[sortedDates.length - 1]
  if (latestCsvDate) {
    const [y, m, d] = latestCsvDate.split('-').map(Number)
    const startMs = Date.UTC(y, m - 1, d, 21, 0, 0)
    const endMs = Date.now()
    try {
      streamScidSnapshots(FALLBACK_SCID, startMs, endMs, endState.atr10, snapshots)
    } catch (e) {
      console.warn(`  .scid extension failed: ${(e as Error).message}`)
      console.warn(`  proceeding with CSV-only; recent trades will have null entry metrics`)
    }
  }
  console.log()

  const sortedDatesAfterScid = Array.from(snapshots.keys()).sort()
  const dateIdx = new Map(sortedDatesAfterScid.map((d, i) => [d, i]))
  console.log(`Total covered RTH days: ${sortedDatesAfterScid.length}`)
  console.log()

  // Step 3: Fetch trades to backfill
  console.log('Fetching trades…')
  const trades = await fetchTrades()
  console.log(`Loaded ${trades.length} trade(s) needing backfill${force ? ' (--force: all matching trades)' : ' (only nulls)'}`)
  console.log()

  // Step 4: Per-trade lookup
  const updates: Array<{ table: 'trades' | 'historical_trades'; id: string; entry_atr_1m: number | null; entry_rvol: number | null }> = []
  let skippedOutOfRange = 0, skippedNonRth = 0, skippedNoSnap = 0
  let processed = 0
  let samplesPrinted = 0
  const SAMPLE_N = 5
  for (const t of trades) {
    if (processed >= limit) break
    const { date, sec } = utcMsToPtParts(t.entry_ms)
    if (sec < RTH_OPEN_SEC || sec >= RTH_CLOSE_SEC) { skippedNonRth++; continue }
    const todayIdx = dateIdx.get(date)
    if (todayIdx == null) { skippedOutOfRange++; continue }
    const snap = lookupSnapshot(snapshots, date, sec)
    if (!snap) { skippedNoSnap++; continue }
    const meanPrior = meanPriorCumVolAtSec(snapshots, sortedDatesAfterScid, todayIdx, sec, 10)
    const entryAtr = snap.atr10
    const entryRvol = (meanPrior != null && meanPrior > 0)
      ? (snap.cumVol / meanPrior) * 100
      : null
    updates.push({
      table: t.table, id: t.id,
      entry_atr_1m: entryAtr == null ? null : Math.round(entryAtr * 100) / 100,
      entry_rvol: entryRvol == null ? null : Math.round(entryRvol * 100) / 100,
    })
    processed++
    if (samplesPrinted < SAMPLE_N) {
      const minSec = Math.floor(sec / 60) * 60
      const h = Math.floor(minSec / 3600), mn = Math.floor((minSec % 3600) / 60)
      console.log(`  sample #${samplesPrinted + 1}: ${date} ${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')} PT  ATR=${entryAtr?.toFixed(2) ?? '—'}  RVOL=${entryRvol?.toFixed(0) ?? '—'}%  (table=${t.table})`)
      samplesPrinted++
    }
  }
  console.log()
  console.log(`Candidates: ${updates.length}`)
  console.log(`  skipped — entry outside CSV/.scid date range: ${skippedOutOfRange}`)
  console.log(`  skipped — entry outside RTH (06:30–13:00 PT):  ${skippedNonRth}`)
  console.log(`  skipped — no snapshot at that exact minute:    ${skippedNoSnap}`)

  if (dryRun) {
    console.log('\nDry run — no writes.')
    return
  }

  // Step 5: Write in batches per table.
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
        sb.from(table).update({
          entry_atr_1m: u.entry_atr_1m,
          entry_rvol: u.entry_rvol,
        }).eq('id', u.id),
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
