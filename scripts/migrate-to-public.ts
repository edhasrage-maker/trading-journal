/**
 * Migrate the owner's PERSONAL data → the PUBLIC multi-tenant Supabase project,
 * stamping every row with the target user_id and preserving primary-key ids so
 * foreign keys (trading_day_id, etc.) stay intact.
 *
 * SOURCE = personal project (read from .env.local).
 * TARGET = public project (you pass its creds + your public user_id via env, so
 *          the public service key never lives in the repo).
 *
 * Prereqs:
 *   1. Sign up / log in ONCE on tapescore.app so your row exists in the public
 *      project's auth.users. Copy that user's id (Supabase dashboard →
 *      Authentication → Users) → TARGET_USER_ID.
 *   2. Have the public project's URL + service_role key.
 *
 * Usage (ALWAYS dry-run first and read the counts):
 *   PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
 *   PUBLIC_SERVICE_ROLE_KEY=eyJ... \
 *   TARGET_USER_ID=<your-public-user-uuid> \
 *   node --experimental-strip-types scripts/migrate-to-public.ts --dry-run
 *
 *   …then re-run without --dry-run to write. --only=trades,trading_days limits
 *   tables; re-runs are idempotent (upsert on id).
 *
 * NOTE: ohlcv_bars is a SHARED feed in the public schema (not per-user), so it's
 * NOT migrated here — import bars into the public project separately if needed.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const SRC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SRC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TGT_URL = process.env.PUBLIC_SUPABASE_URL
const TGT_KEY = process.env.PUBLIC_SERVICE_ROLE_KEY
const USER_ID = process.env.TARGET_USER_ID
if (!SRC_URL || !SRC_KEY) { console.error('Missing personal creds in .env.local'); process.exit(1) }
if (!TGT_URL || !TGT_KEY || !USER_ID) {
  console.error('Set PUBLIC_SUPABASE_URL, PUBLIC_SERVICE_ROLE_KEY, TARGET_USER_ID (see header).'); process.exit(1)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const source: any = createClient(SRC_URL, SRC_KEY)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const target: any = createClient(TGT_URL, TGT_KEY)

const dryRun = process.argv.includes('--dry-run')
const onlyArg = process.argv.find(a => a.startsWith('--only='))
const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null

// Per-user tables, PARENTS FIRST (children reference trading_day_id). `src`
// overrides the source table name when it differs from the public one.
// `order` is the column to paginate by (must exist on the source table).
const TABLES: Array<{ name: string; src?: string; order: string }> = [
  { name: 'trading_days', order: 'id' },
  { name: 'trade_tags', order: 'id' },
  { name: 'trader_profile', order: 'id' },
  { name: 'historical_trades', order: 'id' },
  { name: 'chart_prefs', order: 'id' },
  { name: 'bar_imports', order: 'id' },
  { name: 'weekly_recap', order: 'id' },
  { name: 'eod_themes_analysis', src: 'eod_themes', order: 'id' },
  { name: 'market_context', order: 'id' },       // FK trading_day_id
  { name: 'daily_prep', order: 'id' },            // FK trading_day_id (or date-keyed)
  { name: 'trades', order: 'id' },                // FK trading_day_id
  { name: 'chart_annotations', order: 'id' },     // FK trading_day_id
]

async function fetchAll(table: string, order: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000
  const out: Record<string, unknown>[] = []
  for (let p = 0; p < 500; p++) {
    const { data, error } = await source.from(table).select('*').order(order, { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`source ${table}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

async function migrateTable(t: { name: string; src?: string; order: string }) {
  const srcName = t.src ?? t.name
  let rows: Record<string, unknown>[]
  try { rows = await fetchAll(srcName, t.order) }
  catch (e) { console.log(`  ⚠ skip ${t.name}: ${(e as Error).message}`); return }
  const stamped = rows.map(r => ({ ...r, user_id: USER_ID }))
  console.log(`${t.name.padEnd(20)} ${stamped.length} rows${srcName !== t.name ? ` (from ${srcName})` : ''}`)
  if (dryRun || stamped.length === 0) return
  let wrote = 0
  for (let i = 0; i < stamped.length; i += 500) {
    const { error } = await target.from(t.name).upsert(stamped.slice(i, i + 500), { onConflict: 'id' })
    if (error) { console.log(`  ✗ target ${t.name}: ${error.message}`); return }
    wrote += stamped.slice(i, i + 500).length
  }
  console.log(`  ✓ wrote ${wrote}`)
}

async function main() {
  console.log(`Migrate personal → ${TGT_URL} as user ${USER_ID}${dryRun ? '  (DRY RUN — no writes)' : ''}\n`)
  for (const t of TABLES) {
    if (only && !only.has(t.name)) continue
    await migrateTable(t)
  }
  console.log(dryRun ? '\nDry run complete — re-run without --dry-run to write.' : '\nDone.')
}
main().catch(e => { console.error(e); process.exit(1) })
