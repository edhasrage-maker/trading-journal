/**
 * Backfill the IB day-CHARACTER read (`ib_meanhl10`, `ib_atr_ratio`,
 * `ib_regime`, `ib_size_band`) onto historical `market_context` rows.
 *
 * Phase 1 classified today's IB live on the prep page and threw the result
 * away on reload. Phase 2 persists it so `condition_lookup` can bucket the
 * trader's ACTUAL trades by day character — but the lookup aggregates HISTORY,
 * so without this backfill the new IB_ATR dimension would sit at n=0 until a
 * year of prep mornings had accumulated.
 *
 * Source of truth is the .scid tick files, NOT the Sierra CSV export. Both
 * quantities here (IB high−low, and meanHL10 = mean high−low of the last 10 IB
 * 1-min bars) live entirely INSIDE the 06:30–07:30 PT hour: no trailing
 * baseline, no Wilder smoothing across days, no cross-contract continuity to
 * preserve. Back-adjustment shifts prices by a constant, which cancels in every
 * range, so raw per-contract .scid data gives identical answers to the
 * back-adjusted continuous CSV — and reading one day at a time from the correct
 * front-month contract is both simpler and covers dates past the CSV's end.
 *
 * The classification itself is NOT reimplemented here: the script reads the
 * day's bars, runs the same `contextStatsForDate` + `classifyIbDayType` +
 * `ibDayTypeColumns` path the prep page runs, and writes what comes back. That
 * is deliberate — a second implementation would drift from the live one, and
 * the whole point is that history and today are bucketed on the same metric.
 *
 * Usage:
 *   npx tsx scripts/backfill-ib-day-type.ts [options]
 *
 * (tsx, not `node --experimental-strip-types`: this reuses the app's own
 * classifier, and those modules import each other extensionlessly, which the
 * bare strip-types ESM resolver rejects.)
 *
 *   --dry-run        classify + report, write nothing
 *   --force          re-classify rows that already have ib_atr_ratio
 *                    (use after retuning REGIME_CUTS_MEANHL10)
 *   --env=local      read .env.local (dev DB) instead of .env.public-feed (prod)
 *   --user=<uuid>    scope to a user; defaults to the one owning the most
 *                    trading_days, so a demo tenant is never touched
 *   --limit=<n>      stop after n classified days (smoke test)
 *
 * Rerunnable and idempotent: without --force it only fills rows that are still
 * null, so an interrupted run resumes where it stopped.
 *
 * AFTER RUNNING: refresh the condition lookup (Settings → Condition Lookup →
 * "Refresh now", or the nightly cron). The lookup's IB_ATR buckets are stale
 * until it re-aggregates.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { readScidBars, type OneMinBar } from '../src/lib/scid-reader.ts'
import { contextStatsForDate } from '../src/lib/market-context-from-bars.ts'
import { classifyIbDayType, ibDayTypeColumns } from '../src/lib/ib-day-type.ts'
import { ptDateSodToUtcMs } from '../src/lib/pt-time.ts'
import { contractFileForDate } from '../src/lib/nq-front-month.ts'

const SC_DATA_DIR = 'D:\\SierraCharts\\Data'

// A complete RTH session is 390 1-min bars; `computeMetrics` already requires
// >= 60 (a full IB) before it will emit a day. Half-days and holidays fall out
// naturally — they'd give an IB that isn't comparable to a normal one.
const MIN_RTH_BARS = 60

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')
const argVal = (name: string): string | null => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const envName = argVal('env') ?? 'public-feed'
const userArg = argVal('user')
const limit = argVal('limit') ? parseInt(argVal('limit')!, 10) : Infinity

// LIVE-FIRST: .env.public-feed points at prod (dmutgkycrjudfejswvhg); .env.local
// is a separate dev DB. Key names differ between the two files.
const envFile = envName === 'local' ? '.env.local' : '.env.public-feed'
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const url = envName === 'local' ? process.env.NEXT_PUBLIC_SUPABASE_URL : process.env.PUBLIC_SUPABASE_URL
const key = envName === 'local' ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error(`Missing Supabase URL/service key in ${envFile}`)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(url, key)

const PAGE = 1000

async function pageAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from(table).select(columns)
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`${table} page ${p}: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
  }
  return out
}

interface DayRow { id: string; date: string; user_id: string | null }
interface CtxRow {
  id: string
  trading_day_id: string
  user_id: string | null
  ib_vs_10d_avg: number | string | null
  ib_atr_ratio: number | string | null
}

/** The day's 1-min bars from the front-month .scid, PT-calendar-day anchored.
 *  Null when the contract file for that date isn't on disk. */
function barsForDate(date: string): OneMinBar[] | null {
  const file = contractFileForDate(date)
  if (!file) return null
  const path = join(SC_DATA_DIR, file)
  if (!existsSync(path)) return null
  // Same PT-day window the app's bar import uses. `contextStatsForDate` needs
  // the whole RTH session (not just the IB) because it only emits a day once
  // >= 60 RTH bars have printed.
  const startMs = ptDateSodToUtcMs(date, 0)
  const endMs = ptDateSodToUtcMs(date, 24 * 3600 - 1)
  return readScidBars(path, startMs, endMs, { priceDivisor: 100, bucketMs: 60_000 }).bars
}

async function main() {
  console.log(`env=${envFile}  dryRun=${dryRun}  force=${force}`)

  const days = await pageAll<DayRow>('trading_days', 'id, date, user_id')
  const contexts = await pageAll<CtxRow>('market_context', 'id, trading_day_id, user_id, ib_vs_10d_avg, ib_atr_ratio')

  // Default to the tenant owning the most days — the real account. Demo tenants
  // carry rolled-forward copies whose market_context must not be rewritten with
  // real NQ history.
  let userId = userArg
  if (!userId) {
    const tally = new Map<string, number>()
    for (const d of days) if (d.user_id) tally.set(d.user_id, (tally.get(d.user_id) ?? 0) + 1)
    userId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  console.log(`user=${userId ?? '(none — single-tenant)'}`)

  const dateById = new Map(days.filter(d => !userId || d.user_id === userId).map(d => [d.id, d.date]))
  const targets = contexts
    .filter(c => (!userId || c.user_id === userId) && dateById.has(c.trading_day_id))
    .filter(c => force || c.ib_atr_ratio == null)
    .map(c => ({ ...c, date: dateById.get(c.trading_day_id)! }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  console.log(`market_context rows in scope: ${contexts.filter(c => !userId || c.user_id === userId).length}`)
  console.log(`to classify: ${targets.length}${force ? ' (--force: includes already-filled)' : ''}\n`)

  const num = (v: number | string | null): number | null => {
    if (v == null) return null
    const n = typeof v === 'number' ? v : parseFloat(v)
    return Number.isFinite(n) ? n : null
  }

  const updates: Array<{ id: string; date: string; cols: Record<string, unknown> }> = []
  const skipped = { noContract: 0, noBars: 0, shortSession: 0, unclassifiable: 0 }
  const regimeTally: Record<string, number> = {}
  const sizeTally: Record<string, number> = {}
  let processed = 0

  for (const t of targets) {
    if (updates.length >= limit) break
    processed++
    if (processed % 50 === 0) console.log(`  …${processed}/${targets.length}`)

    const bars = barsForDate(t.date)
    if (bars == null) { skipped.noContract++; continue }
    if (bars.length < MIN_RTH_BARS) { skipped.noBars++; continue }

    const stats = contextStatsForDate(bars, t.date, 'rth')
    // `realized: false` means the target day's own session wasn't in the bars —
    // a half-day, a holiday, or a contract file that doesn't reach back far
    // enough. Classifying off a carried-forward estimate would be wrong.
    if (!stats || !stats.realized) { skipped.shortSession++; continue }

    const classification = classifyIbDayType({
      session: 'rth',
      ibRange: stats.ib_size,
      atrMeanHL10: stats.meanHL10,
      // Deliberately null: the Wilder fallback is a labelled ~3% approximation,
      // and `ibDayTypeColumns` rejects it anyway. Passing null makes that
      // explicit rather than relying on the downstream guard.
      atrWilder10: null,
      ibVs10dAvg: num(t.ib_vs_10d_avg),
    })
    const cols = ibDayTypeColumns(classification, stats.meanHL10)
    if (!cols) { skipped.unclassifiable++; continue }

    regimeTally[cols.ib_regime ?? 'null'] = (regimeTally[cols.ib_regime ?? 'null'] ?? 0) + 1
    sizeTally[cols.ib_size_band ?? 'null'] = (sizeTally[cols.ib_size_band ?? 'null'] ?? 0) + 1
    updates.push({
      id: t.id,
      date: t.date,
      cols: {
        ib_meanhl10: cols.ib_meanhl10 == null ? null : Math.round(cols.ib_meanhl10 * 1000) / 1000,
        ib_atr_ratio: Math.round(cols.ib_atr_ratio! * 1000) / 1000,
        ib_regime: cols.ib_regime,
        ib_size_band: cols.ib_size_band,
      },
    })
  }

  console.log(`\nclassified ${updates.length} days`)
  console.log(`  regime: ${JSON.stringify(regimeTally)}`)
  console.log(`  size:   ${JSON.stringify(sizeTally)}`)
  console.log(`  skipped: ${JSON.stringify(skipped)}`)
  if (updates.length) {
    const first = updates[0], last = updates[updates.length - 1]
    console.log(`  span: ${first.date} → ${last.date}`)
    console.log(`  sample: ${first.date} ${JSON.stringify(first.cols)}`)
  }

  if (dryRun) { console.log('\n--dry-run: nothing written'); return }

  let written = 0
  for (const u of updates) {
    const { error } = await sb.from('market_context').update(u.cols).eq('id', u.id)
    if (error) { console.error(`  update ${u.date}: ${error.message}`); continue }
    written++
    if (written % 100 === 0) console.log(`  wrote ${written}/${updates.length}`)
  }
  console.log(`\nwrote ${written} rows.`)
  console.log('NEXT: refresh the condition lookup so the IB_ATR buckets pick this up.')
}

main().catch(e => { console.error(e); process.exit(1) })
