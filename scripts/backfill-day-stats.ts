/**
 * Backfill the materialized per-day dashboard rollup: walk every trading_days
 * row, run the SHARED pure computeDayStats over its trades + prep ATR, and write
 * the projected rollup into trading_days.stats_json (+ stats_version). Idempotent
 * and safe to re-run — new/edited days self-heal via the DB triggers + the
 * dashboard read-through, so this only needs one run right after the migration.
 *
 * Uses the same computeDayStats / toStoredStats the app reads with, so a
 * backfilled row is byte-identical to a read-through-computed one.
 *
 * Schema dependency: requires migration 20260718_day_stats_materialization
 * (trading_days.stats_json + stats_version) to be applied FIRST on the target DB.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-day-stats.ts [--apply] [--public] [--force] [--limit=N]
 *
 *   (default)  DRY RUN — computes + reports, writes nothing.
 *   --apply    persist stats_json + stats_version.
 *   --public   target the public/cloud DB (.env.public-feed, PUBLIC_* keys).
 *              Default targets the personal DB (.env.local).
 *   --force    recompute + rewrite even rows that already have a current cache.
 *              Default fills only null / stale-version rows.
 *   --limit=N  process at most N days (calibration).
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeDayStats, toStoredStats, STATS_VERSION, type TradeForStats } from '../src/lib/day-stats.ts'

const PUBLIC = process.argv.includes('--public')
const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='))
  return a ? parseInt(a.split('=')[1], 10) : Infinity
})()

// Load the target DB's env file, then pick URL + service-role key.
const envFile = PUBLIC ? '.env.public-feed' : '.env.local'
for (const l of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = PUBLIC ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = PUBLIC ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error(`Missing ${PUBLIC ? 'PUBLIC_SUPABASE_URL/PUBLIC_SUPABASE_SERVICE_ROLE_KEY' : 'NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY'} in ${envFile}`)
  process.exit(1)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(URL, KEY)

const PAGE = 1000
const TRADE_COLS =
  'id, trading_day_id, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, exits_json, mfe_dollars_per_leg'

async function main() {
  console.log(`Target: ${PUBLIC ? 'PUBLIC/cloud' : 'personal'} DB (${envFile})  |  ${APPLY ? 'APPLY' : 'DRY RUN'}${FORCE ? '  |  FORCE' : ''}  |  STATS_VERSION=${STATS_VERSION}`)

  // 1. Page through all trading_days.
  type DayRow = {
    id: string; date: string; eod_pnl: number | null
    day_type: string | null; day_types: string[] | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ai_analysis_json: any; eod_ai_analysis_json: any
    stats_version: number | null; stats_json: unknown
  }
  const days: DayRow[] = []
  for (let p = 0; p < 1000; p++) {
    const { data, error } = await sb
      .from('trading_days')
      .select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json, stats_version, stats_json')
      .order('date', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('trading_days fetch failed:', error.message); process.exit(1) }
    const batch = (data ?? []) as DayRow[]
    days.push(...batch)
    if (batch.length < PAGE) break
  }
  console.log(`fetched ${days.length} trading_days`)

  // 2. Which need work.
  const todo = (FORCE
    ? days
    : days.filter(d => d.stats_json == null || d.stats_version !== STATS_VERSION)
  ).slice(0, LIMIT === Infinity ? undefined : LIMIT)
  console.log(`${todo.length} day(s) to ${FORCE ? '(force) ' : ''}recompute`)
  if (todo.length === 0) { console.log('nothing to do.'); return }

  // 3. Fetch their trades + contexts, chunked by trading_day_id.
  const ids = todo.map(d => d.id)
  const tradesByDay = new Map<string, TradeForStats[]>()
  const atrByDay = new Map<string, number | null>()
  const CHUNK = 50
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    for (let p = 0; p < 50; p++) {
      const { data, error } = await sb
        .from('trades').select(TRADE_COLS).in('trading_day_id', slice)
        .order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) { console.error('trades fetch failed:', error.message); process.exit(1) }
      const batch = (data ?? []) as (TradeForStats & { trading_day_id: string })[]
      for (const t of batch) {
        const arr = tradesByDay.get(t.trading_day_id) ?? []
        arr.push(t); tradesByDay.set(t.trading_day_id, arr)
      }
      if (batch.length < PAGE) break
    }
    const { data: ctx } = await sb.from('market_context').select('trading_day_id, atr_1m').in('trading_day_id', slice)
    for (const c of (ctx ?? []) as { trading_day_id: string; atr_1m: number | null }[]) {
      atrByDay.set(c.trading_day_id, c.atr_1m)
    }
  }

  // 4. Compute + (optionally) write.
  let written = 0, failed = 0
  for (const d of todo) {
    const rollup = computeDayStats(
      { id: d.id, date: d.date, eod_pnl: d.eod_pnl, day_type: d.day_type, day_types: d.day_types, ai_analysis_json: d.ai_analysis_json, eod_ai_analysis_json: d.eod_ai_analysis_json },
      tradesByDay.get(d.id) ?? [],
      atrByDay.get(d.id) ?? null,
    )
    if (!APPLY) continue
    const { error } = await sb
      .from('trading_days')
      .update({ stats_json: toStoredStats(rollup), stats_version: STATS_VERSION })
      .eq('id', d.id)
    if (error) { failed++; if (failed <= 5) console.error(`  write failed ${d.date}:`, error.message) }
    else { written++; if (written % 100 === 0) console.log(`  …${written} written`) }
  }

  if (!APPLY) {
    console.log(`DRY RUN — computed ${todo.length} rollups, wrote nothing. Re-run with --apply to persist.`)
  } else {
    console.log(`APPLIED: wrote ${written}/${todo.length} rows${failed ? `, ${failed} failed` : ''}.`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
