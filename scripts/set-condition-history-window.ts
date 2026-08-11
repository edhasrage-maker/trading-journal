/**
 * Set (or clear) the Morning Conditions history window for ONE user.
 *
 * The 20260728 migration added `condition_lookup_meta.history_start_date` —
 * a per-user lower bound on the history the lookup aggregates. NULL = all
 * history (the default, and what every row currently has). This sets it for
 * a single account and NOBODY else, then you re-run the refresh so the
 * buckets rebuild from the windowed history:
 *
 *   npx tsx scripts/set-condition-history-window.ts                 # dry run (owner, 2026-01-01)
 *   npx tsx scripts/set-condition-history-window.ts --apply         # write it
 *   npx tsx scripts/set-condition-history-window.ts --apply --date=2025-06-01
 *   npx tsx scripts/set-condition-history-window.ts --apply --clear # back to all-history
 *   npx tsx scripts/refresh-condition-lookup.ts                     # then ALWAYS this
 *
 * Prod (.env.public-feed) only — the dev schema is single-tenant and has no
 * per-user meta rows worth windowing.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const APPLY = argv.includes('--apply')
const CLEAR = argv.includes('--clear')
const DATE = CLEAR ? null : (argVal('date') ?? '2026-01-01')

for (const line of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.PUBLIC_SUPABASE_URL!,
  process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID

async function main() {
  const { data: before, error: readErr } = await sb
    .from('condition_lookup_meta')
    .select('user_id, history_start_date')
    .eq('user_id', USER_ID)
    .maybeSingle()
  if (readErr) throw readErr
  if (!before) throw new Error(`no condition_lookup_meta row for user ${USER_ID} — has the lookup ever run for them?`)

  console.log(`user ${USER_ID}`)
  console.log(`  history_start_date: ${before.history_start_date ?? 'NULL (all history)'} → ${DATE ?? 'NULL (all history)'}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply, then run refresh-condition-lookup.')
    return
  }

  const { error } = await sb
    .from('condition_lookup_meta')
    .update({ history_start_date: DATE })
    .eq('user_id', USER_ID)
  if (error) throw error

  const { data: others } = await sb
    .from('condition_lookup_meta')
    .select('user_id, history_start_date')
    .neq('user_id', USER_ID)
  console.log('\nWritten. Everyone else (untouched):')
  for (const o of others ?? []) console.log(`  ${o.user_id}: ${o.history_start_date ?? 'NULL (all history)'}`)
  console.log('\nNow rebuild the buckets from the windowed history:')
  console.log('  npx tsx scripts/refresh-condition-lookup.ts')
}

main().catch(e => { console.error(e); process.exit(1) })
