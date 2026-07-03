/**
 * Copy the SHARED condition-lookup tables (condition_thresholds, condition_lookup,
 * lookup_metadata) from the personal project → the PUBLIC project, so tapescore.app's
 * Morning Conditions panel has thresholds to read. These are shared reference data
 * (no user_id) — the owner's lookup is shared to all testers — so rows copy verbatim.
 *
 * Creds: personal from .env.local; public from .env.public-feed (same file the bar
 * feed uses) or PUBLIC_SUPABASE_URL / PUBLIC_(SUPABASE_)SERVICE_ROLE_KEY in the env.
 *
 * Usage (dry-run first):
 *   node --experimental-strip-types scripts/migrate-condition-lookup.ts --dry-run
 *   node --experimental-strip-types scripts/migrate-condition-lookup.ts
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

function loadEnvFile(path: string) {
  try {
    for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  } catch { /* file optional */ }
}
loadEnvFile('.env.local')
loadEnvFile('.env.public-feed')

const SRC_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SRC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TGT_URL = process.env.PUBLIC_SUPABASE_URL
const TGT_KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY || process.env.PUBLIC_SERVICE_ROLE_KEY
if (!SRC_URL || !SRC_KEY) { console.error('Missing personal creds in .env.local'); process.exit(1) }
if (!TGT_URL || !TGT_KEY) { console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_SERVICE_ROLE_KEY (put them in .env.public-feed).'); process.exit(1) }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const source: any = createClient(SRC_URL, SRC_KEY)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const target: any = createClient(TGT_URL, TGT_KEY)
const dryRun = process.argv.includes('--dry-run')

const TABLES = [
  { name: 'condition_thresholds', conflict: 'metric' },
  { name: 'condition_lookup', conflict: 'condition_id' },
  { name: 'lookup_metadata', conflict: 'key' },
]

async function main() {
  console.log(`Copy condition-lookup → ${TGT_URL}${dryRun ? '  (DRY RUN — no writes)' : ''}\n`)
  for (const t of TABLES) {
    const { data, error } = await source.from(t.name).select('*')
    if (error) { console.error(`source ${t.name}: ${error.message}`); process.exit(1) }
    const rows = data ?? []
    console.log(`${t.name.padEnd(22)} ${rows.length} rows`)
    if (dryRun || rows.length === 0) continue
    const { error: upErr } = await target.from(t.name).upsert(rows, { onConflict: t.conflict })
    if (upErr) { console.error(`  ✗ target ${t.name}: ${upErr.message}`); process.exit(1) }
    console.log(`  ✓ wrote ${rows.length}`)
  }
  console.log(dryRun ? '\nDry run complete — re-run without --dry-run to write.' : '\nDone.')
}
main().catch(e => { console.error(e); process.exit(1) })
