/**
 * Backfill bar-derived MFE/MAE on historical_trades from a Sierra-exported
 * 1-minute CSV.
 *
 * Why this exists: the Tradezella export populates `position_mfe` /
 * `position_mae` / `price_mfe` / `price_mae`, but the trader explicitly
 * distrusts those values (different conventions, sometimes computed from
 * different bar granularities than what the chart shows). For uniform
 * MFE/MAE math across native + historical trades, this script computes
 * `high_during_position` and `low_during_position` directly from the same
 * 1m bars the rest of the journal already uses.
 *
 * Approach (hybrid CSV + .scid):
 *   - Stream the CSV once into a sorted [{ utcMs, high, low }] array
 *   - Convert CSV's PT wall-clock to UTC (DST-aware via Intl.DateTimeFormat)
 *   - For each historical_trade with open_at + close_at:
 *       * If openMs ≤ CSV's last bar:    binary-search the CSV array
 *       * Else (CSV gap, post-2026-03):   readScidBars() on NQM6.CME.scid
 *       * Take max(high) → high_during_position, min(low) → low_during_position
 *   - Update in PAGE-sized batches via service-role
 *
 * Why hybrid: the CSV is continuous-contract-stitched data spanning two
 * years, but ends 2026-03-20 — that leaves ~6 weeks of recent trades with
 * no coverage. NQM6.CME.scid is the live front month from ~mid-March 2026
 * onward, so it perfectly fills the tail. Going all-.scid would require a
 * 4-contract roll-date picker (NQU5/Z5/H6/M6) which we skipped here — the
 * CSV already covers the bulk correctly.
 *
 * Trades on dates neither source covers stay null; analytics treats them
 * the same way it treats native trades missing excursion data (gray dash,
 * counted in N-of-N "with capture data" denominators).
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-historical-mfe.ts [csv-path] \
 *     [--dry-run] [--force] [--limit=N]
 *
 *   --force    overwrite existing high/low_during_position values
 *              (default: only fill trades where both fields are null)
 *   --limit=N  process at most N trades — useful for verifying timezone math
 *              against the existing position_mfe figures before a full run
 *
 * Schema dependency: requires the 2026-06-08 migration
 *   supabase/migrations/20260608_historical_trades_excursion_columns.sql
 * to have been applied first (adds the two numeric(10,2) columns).
 */

import { createReadStream, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'

const DEFAULT_CSV = 'D:\\Documents\\Trading\\Trading Journal\\docs\\NQ_1m _R24_Market Data_5.04.26.csv'

// Front-month .scid for the tail (post-CSV) trades. Currently NQM6 (June 2026)
// is the front month from ~mid-March 2026 through ~mid-June 2026. When a roll
// happens or when older trades need .scid coverage too, this hybrid would need
// a per-trade contract picker (NQU5/Z5/H6/M6) — we skipped that here because
// the CSV already covers everything ≤ 2026-03-20 and NQM6 alone fills the gap.
const FALLBACK_SCID = 'D:\\SierraCharts\\Data\\NQM6.CME.scid'

// Column indices in the Sierra export (verified against the header row).
const COL_DATE = 0
const COL_TIME = 1
const COL_HIGH = 3
const COL_LOW = 4

// Load .env.local — same pattern as scripts/import-tradezella.ts
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
const csvPath = argv.find(a => !a.startsWith('--')) ?? DEFAULT_CSV

interface Bar {
  utcMs: number
  high: number
  low: number
}

/**
 * Convert a PT wall-clock date/time to UTC ms, DST-aware.
 *
 * Approach: build a "naive" UTC timestamp for the wall-clock fields (i.e.
 * pretend the wall-clock IS UTC), then ask Intl what America/Los_Angeles
 * thinks that instant's wall-clock is. The diff between the original and
 * what PT says is the offset we need to subtract to back out the real UTC.
 *
 * Falls apart inside the "spring forward" hour (02:00 PT March DST start)
 * where wall-clock 02:30 doesn't exist, but the CSV doesn't have bars at
 * that time of day anyway (NQ session is closed 13:15-15:00 PT around
 * that hour, and pre-RTH only starts 03:00 PT) so it's not an issue here.
 */
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
  // Intl can produce hour="24" for midnight in some locales; normalize.
  const ptHour = p.hour === '24' ? 0 : parseInt(p.hour)
  const ptAsUtc = Date.UTC(
    parseInt(p.year), parseInt(p.month) - 1, parseInt(p.day),
    ptHour, parseInt(p.minute), parseInt(p.second),
  )
  const offsetMs = naiveUtc - ptAsUtc  // hours PT is behind UTC, in ms (positive)
  return naiveUtc + offsetMs
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

    // Date: "2024-3-20" — Sierra drops leading zeros
    const [yStr, mStr, dStr] = dateRaw.split('-')
    const year = parseInt(yStr), month = parseInt(mStr), day = parseInt(dStr)
    if (!year || !month || !day) continue

    // Time: "15:00:00.000000" — drop microseconds
    const [hh, mm, ssRaw] = timeRaw.split(':')
    const ss = ssRaw ? parseInt(ssRaw.split('.')[0]) : 0
    const hour = parseInt(hh), minute = parseInt(mm)

    const utcMs = ptWallToUtcMs(year, month, day, hour, minute, ss)
    bars.push({ utcMs, high, low })

    if (lineCount % 100000 === 0) {
      process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${bars.length.toLocaleString()} bars\r`)
    }
  }
  process.stdout.write(`  ${lineCount.toLocaleString()} lines, ${bars.length.toLocaleString()} bars total\n`)

  // Sort by timestamp — CSV is mostly chronological but guarantee it for
  // the binary search.
  bars.sort((a, b) => a.utcMs - b.utcMs)
  return bars
}

/**
 * Find the index of the first bar with utcMs >= target. Returns bars.length
 * if no such bar exists. Standard lower-bound binary search.
 */
function lowerBound(bars: Bar[], target: number): number {
  let lo = 0, hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bars[mid].utcMs < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface HistRow {
  id: string
  open_at: string | null
  close_at: string | null
  trade_date: string | null
  entry_price: number | null
  side: string | null
  high_during_position: number | null
  low_during_position: number | null
  position_mfe: number | null
}

async function fetchHistoricalTrades(): Promise<HistRow[]> {
  const all: HistRow[] = []
  const PAGE = 1000
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('historical_trades')
      .select('id, open_at, close_at, trade_date, entry_price, side, high_during_position, low_during_position, position_mfe')
      .order('trade_date', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('high_during_position', null)
    const { data, error } = await q
    if (error) { console.error('  fetch page', p, 'failed:', error.message); break }
    const rows = (data ?? []) as HistRow[]
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, force=${force}, limit=${limit === Infinity ? 'none' : limit}`)
  console.log()

  const bars = await streamBars(csvPath)
  if (bars.length === 0) {
    console.error('No bars parsed — aborting.')
    process.exit(1)
  }
  const csvStart = new Date(bars[0].utcMs).toISOString()
  const csvEnd = new Date(bars[bars.length - 1].utcMs).toISOString()
  console.log(`CSV bar range (UTC): ${csvStart}  →  ${csvEnd}`)
  console.log()

  console.log('Fetching historical_trades…')
  const trades = await fetchHistoricalTrades()
  console.log(`Loaded ${trades.length} trades${force ? '' : ' (only those still null)'}`)
  console.log()

  // Csv covers up to its last bar; trades after that fall through to the
  // .scid path. Adding the bar interval (60_000ms) means a trade whose open
  // is mid-way through the CSV's final bar still counts as CSV-covered.
  const csvCutoffMs = bars[bars.length - 1].utcMs + 60_000
  console.log(`Routing: openMs ≤ ${new Date(csvCutoffMs).toISOString()} → CSV; else → ${FALLBACK_SCID}`)
  console.log()

  const updates: Array<{ id: string; high_during_position: number; low_during_position: number }> = []
  let skippedNoTime = 0
  let skippedOutOfRange = 0
  let skippedNoBars = 0
  let scidNoFile = 0
  let processed = 0
  let csvSourced = 0
  let scidSourced = 0

  // Sanity sample: for the first N candidates from EACH source, print
  // bar-derived vs TZ position_mfe so the timezone math + .scid fallback
  // both get a smell test before we write. Drop --limit=5 --dry-run to
  // calibrate the CSV path; --limit=N where N is large enough to reach
  // post-CSV trades to calibrate the .scid path.
  const sampleLimit = 5
  let csvSamplesPrinted = 0
  let scidSamplesPrinted = 0

  /**
   * Resolve [highest, lowest] over the bar window for one trade.
   * Returns null when no bars covered the window (out-of-range / file gap).
   */
  function resolveExcursion(openMs: number, closeMs: number): { highest: number; lowest: number; source: 'csv' | 'scid' } | null {
    if (openMs <= csvCutoffMs) {
      // CSV path — binary-search the pre-loaded sorted bar array.
      let lo = lowerBound(bars, openMs)
      if (lo > 0) lo -= 1  // catch the bar containing entry
      const hi = lowerBound(bars, closeMs + 60_000)
      if (lo >= bars.length || hi <= 0) return null
      const slice = bars.slice(Math.max(0, lo), hi)
      if (slice.length === 0) return null
      let highest = -Infinity, lowest = Infinity
      for (const b of slice) {
        if (b.high > highest) highest = b.high
        if (b.low < lowest) lowest = b.low
      }
      if (!Number.isFinite(highest) || !Number.isFinite(lowest)) return null
      return { highest, lowest, source: 'csv' }
    }

    // .scid path — readScidBars handles its own binary search inside the
    // file. Widen the window by one bar on each side for the same reason
    // the CSV path does (entry tick may fall mid-bar).
    try {
      const result = readScidBars(FALLBACK_SCID, openMs - 60_000, closeMs + 60_000, {
        priceDivisor: 100,  // NQ/MNQ prices are scaled ×100 in .scid
        bucketMs: 60_000,
      })
      if (result.bars.length === 0) return null
      let highest = -Infinity, lowest = Infinity
      for (const b of result.bars) {
        if (b.high > highest) highest = b.high
        if (b.low < lowest) lowest = b.low
      }
      if (!Number.isFinite(highest) || !Number.isFinite(lowest)) return null
      return { highest, lowest, source: 'scid' }
    } catch (e) {
      scidNoFile++
      if (scidNoFile === 1) console.warn(`  WARN: readScidBars failed: ${(e as Error).message}`)
      return null
    }
  }

  for (const t of trades) {
    if (processed >= limit) break
    if (!t.open_at || !t.close_at) { skippedNoTime++; continue }
    const openMs = Date.parse(t.open_at)
    const closeMs = Date.parse(t.close_at)
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs < openMs) { skippedNoTime++; continue }

    const r = resolveExcursion(openMs, closeMs)
    if (!r) {
      // Distinguish "no bars in window" from "out of range" cheaply: if
      // openMs falls inside CSV range OR after the start of NQM6 coverage,
      // it's a no-bars-in-window case; otherwise it's truly out of range.
      if (openMs < bars[0].utcMs) skippedOutOfRange++
      else skippedNoBars++
      continue
    }

    updates.push({
      id: t.id,
      high_during_position: Math.round(r.highest * 100) / 100,
      low_during_position: Math.round(r.lowest * 100) / 100,
    })
    processed++
    if (r.source === 'csv') csvSourced++; else scidSourced++

    // Print up to `sampleLimit` samples from each source.
    const isCsvSample = r.source === 'csv' && csvSamplesPrinted < sampleLimit
    const isScidSample = r.source === 'scid' && scidSamplesPrinted < sampleLimit
    if ((isCsvSample || isScidSample) && t.entry_price != null && t.position_mfe != null) {
      const isLong = t.side === 'long'
      const priceMfe = isLong ? r.highest - t.entry_price : t.entry_price - r.lowest
      const idx = r.source === 'csv' ? ++csvSamplesPrinted : ++scidSamplesPrinted
      console.log(
        `  [${r.source}] sample #${idx}: ${t.trade_date} ${t.side}  entry=${t.entry_price}` +
        `  bar-high=${r.highest}  bar-low=${r.lowest}  pts-mfe=${priceMfe.toFixed(2)}` +
        `  (TZ position_mfe=$${t.position_mfe})`
      )
    }
  }

  console.log()
  console.log(`Candidates to update: ${updates.length}  (CSV: ${csvSourced}, .scid: ${scidSourced})`)
  console.log(`  skipped — no time/bad time:    ${skippedNoTime}`)
  console.log(`  skipped — outside both sources: ${skippedOutOfRange}`)
  console.log(`  skipped — no bars in window:   ${skippedNoBars}`)
  if (scidNoFile > 0) console.log(`  .scid read errors: ${scidNoFile}`)

  if (dryRun) {
    console.log('\nDry run — no writes.')
    return
  }

  // Write in batches. .upsert with onConflict='id' handles both the
  // initial backfill (rows exist, just have null in our columns) and any
  // future --force rerun.
  const BATCH = 200
  let wrote = 0
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    // Supabase doesn't let us patch multiple rows with different values in
    // one call without upsert — but upsert requires the full row. Use
    // parallel individual updates throttled by Promise.all over the batch.
    const results = await Promise.all(batch.map(u =>
      sb.from('historical_trades').update({
        high_during_position: u.high_during_position,
        low_during_position: u.low_during_position,
      }).eq('id', u.id),
    ))
    for (const r of results) {
      if (r.error) console.error('  update failed:', r.error.message)
      else wrote++
    }
    process.stdout.write(`  wrote ${wrote}/${updates.length}\r`)
  }
  console.log(`\nDone. Wrote ${wrote} rows.`)
}

main().catch(e => { console.error(e); process.exit(1) })
