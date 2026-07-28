/**
 * Re-parent trades that are filed under the wrong `trading_day`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/import-sc-log` pins EVERY parsed row to the single `date` chosen in the
 * import form (the open thread in CLAUDE.md: "Importer multi-day-log merge").
 * Feed it a Sierra log that spans more than one session and the whole log lands
 * on one day. That has already happened at least twice in the live journal:
 *
 *   2025-08-27  430 rows, 57 distinct PT entry dates (2025-05-27 → 2025-08-27),
 *               51 accounts, one `created_at` instant. Only 4 rows genuinely
 *               belong to that date.
 *   2023-06-12  397 rows, 18 distinct PT entry dates, 1 account.
 *
 * Plus a long tail of smaller merges — 1,172 rows across 37 trading days in
 * total. The rows themselves are fine: every one has a distinct
 * `sierra_trade_id` and a real `entry_time`. Only the parent is wrong. So this
 * repairs attribution; it deletes nothing and merges nothing.
 *
 * The damage is not to totals (the mis-filed rows are −$1,889 of $98,487) but to
 * every PER-DAY and PER-CONDITION aggregate: `market_context` conditions,
 * `condition_lookup` buckets, the Day Character tables, day win-rate, and the
 * coach's day-level reads all attribute three months of trading to one session.
 * See docs/findings-expanded-ib-day.md for how badly it distorted the Pt 23
 * IB-day-character study.
 *
 * WHAT COUNTS AS MIS-FILED
 * ------------------------
 * A trading day in this journal is the PT CALENDAR day (`sessionUtcWindow` in
 * src/lib/pt-time.ts anchors 00:00:00 → 23:59:59 PT), so a row's correct parent
 * is the PT calendar date of its `entry_time`, DST-exact via Intl.
 *
 * Deliberately conservative: only rows more than ONE day away from their parent
 * are moved. Rows exactly one day off are reported and left alone — that
 * population is small, plausibly intentional (evening ETH opens logged against
 * the adjacent session, hand-entered trades), and not worth a blind rewrite.
 * Nothing about a multi-day import blob is one day off.
 *
 * Usage:
 *   npx tsx scripts/repair-misdated-trades.ts              # dry run (default)
 *   npx tsx scripts/repair-misdated-trades.ts --apply      # write
 *   npx tsx scripts/repair-misdated-trades.ts --apply --env=local
 *   npx tsx scripts/repair-misdated-trades.ts --user=<uuid>
 *
 * (tsx, not `node --experimental-strip-types` — this imports the app's own
 * pt-time helper and those modules import each other extensionlessly.)
 *
 * Prod is MULTI-TENANT and the service-role key bypasses RLS, so every read and
 * write here is scoped to `--user` (default: the journal owner). Target
 * `trading_days` rows are created when the date has none — 472 of the 1,172 rows
 * point at dates the journal never recorded.
 *
 * Reversible: `--apply` writes a backup JSON of every (trade id → original
 * trading_day_id) move to scripts/.repair-backups/ before touching anything.
 *
 * AFTERWARDS: `trading_days.stats_json` self-heals (the
 * trg_trades_invalidate_day_stats trigger nulls the cache on both the old and
 * the new parent). These do NOT self-heal and want a follow-up:
 *   - newly created days have no `market_context` → their trades sit out the
 *     condition buckets until `scripts/backfill-ib-day-type.ts` and the
 *     market-context backfill run for those dates;
 *   - `condition_lookup` is stale until refreshed (Settings → Condition Lookup
 *     → "Refresh now", or the nightly cron).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { todayPT } from '../src/lib/pt-time.ts'

const DEFAULT_USER = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const ENV_FILE = args.includes('--env=local') ? '.env.local' : '.env.public-feed'
const USER = (args.find(a => a.startsWith('--user='))?.slice(7)) || DEFAULT_USER

for (const line of readFileSync(join(process.cwd(), ENV_FILE), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const URL = process.env.PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) throw new Error(`missing Supabase URL/service-role key in ${ENV_FILE}`)
const sb = createClient(URL, KEY)

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRow = Record<string, any>

/** Page past Supabase's 1000-row cap, ordered by id so paging is deterministic. */
async function pageAll(table: string, cols: string): Promise<AnyRow[]> {
  const out: AnyRow[] = []
  for (let p = 0; p < 100; p++) {
    const { data, error } = await sb
      .from(table).select(cols).eq('user_id', USER)
      .order('id', { ascending: true }).range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data?.length) break
    out.push(...(data as AnyRow[]))
    if (data.length < 1000) break
  }
  return out
}

const dayMs = 86_400_000
const daysApart = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / dayMs)

async function main() {
  console.log(`repair-misdated-trades — ${APPLY ? 'APPLY' : 'DRY RUN'} · env ${ENV_FILE} · user ${USER}`)

  const days = await pageAll('trading_days', 'id, date')
  const dateOf = new Map<string, string>(days.map(d => [d.id, d.date]))
  const dayIdFor = new Map<string, string>(days.map(d => [d.date, d.id]))
  const trades = await pageAll('trades', 'id, trading_day_id, entry_time, pnl, sierra_trade_id')
  console.log(`loaded ${days.length} trading_days, ${trades.length} trades`)

  type Move = { id: string; fromDayId: string; fromDate: string; toDate: string; pnl: number; offset: number }
  const moves: Move[] = []
  const adjacent: Move[] = []
  let noEntryTime = 0

  for (const t of trades) {
    const fromDate = dateOf.get(t.trading_day_id)
    if (!fromDate) continue
    if (!t.entry_time) { noEntryTime++; continue }
    const toDate = todayPT(new Date(t.entry_time))   // PT calendar date, DST-exact
    if (toDate === fromDate) continue
    const rec: Move = { id: t.id, fromDayId: t.trading_day_id, fromDate, toDate, pnl: Number(t.pnl ?? 0), offset: daysApart(toDate, fromDate) }
    if (rec.offset > 1) moves.push(rec)
    else adjacent.push(rec)
  }

  console.log(`\ntrades with no entry_time (skipped): ${noEntryTime}`)
  console.log(`exactly 1 day off — REPORTED ONLY, not touched: ${adjacent.length} rows across ${new Set(adjacent.map(m => m.fromDate)).size} days`)
  console.log(`more than 1 day off — TO MOVE: ${moves.length} rows across ${new Set(moves.map(m => m.fromDate)).size} source days`)
  if (!moves.length) { console.log('nothing to repair.'); return }

  const bySource = new Map<string, Move[]>()
  for (const m of moves) {
    if (!bySource.has(m.fromDate)) bySource.set(m.fromDate, [])
    bySource.get(m.fromDate)!.push(m)
  }
  console.log('\nsource days losing rows:')
  for (const [d, ms] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const spread = new Set(ms.map(m => m.toDate)).size
    console.log(`  ${d}  −${String(ms.length).padStart(3)} rows ($${ms.reduce((a, m) => a + m.pnl, 0).toFixed(0)}) → ${spread} dates`)
  }

  const targets = [...new Set(moves.map(m => m.toDate))].sort()
  const missing = targets.filter(d => !dayIdFor.has(d))
  console.log(`\ntarget dates: ${targets.length} (${targets.length - missing.length} existing, ${missing.length} need a trading_days row)`)
  console.log(`  span ${targets[0]} → ${targets[targets.length - 1]}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to perform the repair.')
    return
  }

  // ── Backup first: every move, so the repair can be reversed row by row. ──
  const backupDir = join(process.cwd(), 'scripts', '.repair-backups')
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupDir, `misdated-trades-${stamp}.json`)
  writeFileSync(backupPath, JSON.stringify({ user: USER, env: ENV_FILE, generated_at: new Date().toISOString(), moves }, null, 2))
  console.log(`\nbackup written: ${backupPath}`)

  // ── Create the missing target days. ──
  for (const date of missing) {
    const { data, error } = await sb
      .from('trading_days').insert({ user_id: USER, date }).select('id').single()
    if (error) throw new Error(`create trading_day ${date}: ${error.message}`)
    dayIdFor.set(date, (data as AnyRow).id)
    console.log(`  created trading_day ${date}`)
  }

  // ── Re-parent. One update per target date, batched by id. ──
  const byTarget = new Map<string, Move[]>()
  for (const m of moves) {
    if (!byTarget.has(m.toDate)) byTarget.set(m.toDate, [])
    byTarget.get(m.toDate)!.push(m)
  }
  let moved = 0
  for (const [date, ms] of byTarget) {
    const toDayId = dayIdFor.get(date)
    if (!toDayId) throw new Error(`no trading_day for ${date} after create pass`)
    for (let i = 0; i < ms.length; i += 200) {
      const chunk = ms.slice(i, i + 200)
      const { error } = await sb
        .from('trades').update({ trading_day_id: toDayId })
        .eq('user_id', USER).in('id', chunk.map(m => m.id))
      if (error) throw new Error(`move → ${date}: ${error.message}`)
      moved += chunk.length
    }
  }
  console.log(`\nre-parented ${moved} trades into ${byTarget.size} trading_days.`)

  // ── Verify: re-read and confirm nothing is still >1 day off. ──
  const after = await pageAll('trades', 'id, trading_day_id, entry_time')
  const daysAfter = await pageAll('trading_days', 'id, date')
  const dateAfter = new Map<string, string>(daysAfter.map(d => [d.id, d.date]))
  const stillOff = after.filter(t => {
    const d = dateAfter.get(t.trading_day_id)
    return d && t.entry_time && daysApart(todayPT(new Date(t.entry_time)), d) > 1
  })
  console.log(`verify: rows still >1 day off their trading_day = ${stillOff.length} (expected 0)`)

  console.log(
    '\nNEXT: (1) backfill market_context / IB day-character for the newly created dates ' +
    '(`npx tsx scripts/backfill-ib-day-type.ts`), (2) refresh the condition lookup ' +
    '(Settings → Condition Lookup → "Refresh now"). trading_days.stats_json self-heals via trigger.',
  )
}

main().catch(e => { console.error(e); process.exit(1) })
