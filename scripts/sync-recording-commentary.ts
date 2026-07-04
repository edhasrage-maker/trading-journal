/**
 * Copy `trades.recording_commentary` from the owner's PERSONAL Supabase project
 * → the PUBLIC (tapescore) project, matched by trade id.
 *
 * Why a dedicated script (not re-running migrate-to-public): that migration
 * upserts the WHOLE trade row with select('*'), which would clobber any edits
 * made on tapescore since. This touches ONLY the recording_commentary column
 * (a per-row UPDATE), so nothing else on the public rows is disturbed.
 *
 * Trade ids were preserved by the original migration (upsert onConflict 'id'),
 * so id-matching is exact. Rows scoped to TARGET_USER_ID as a safety guard.
 *
 * SOURCE = personal project (read from .env.local: NEXT_PUBLIC_SUPABASE_URL +
 *          SUPABASE_SERVICE_ROLE_KEY).
 * TARGET = public project (creds passed via env so the key never lives in repo).
 *
 * Usage (dry-run first, read the counts):
 *   PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
 *   PUBLIC_SERVICE_ROLE_KEY=sb_secret_... \
 *   TARGET_USER_ID=<your-public-user-uuid> \
 *   node --experimental-strip-types scripts/sync-recording-commentary.ts --dry-run
 *
 *   …then re-run without --dry-run to write. Idempotent.
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

async function main() {
  console.log(`Sync recording_commentary personal → ${TGT_URL} for user ${USER_ID}${dryRun ? '  (DRY RUN — no writes)' : ''}\n`)

  // Pull every personal trade that carries commentary.
  const PAGE = 1000
  const rows: Array<{ id: string; recording_commentary: unknown }> = []
  for (let p = 0; p < 500; p++) {
    const { data, error } = await source
      .from('trades')
      .select('id, recording_commentary')
      .not('recording_commentary', 'is', null)
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('source trades:', error.message); process.exit(1) }
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE) break
  }
  console.log(`Found ${rows.length} personal trades with commentary.`)
  if (dryRun || rows.length === 0) { console.log(dryRun ? '\nDry run — re-run without --dry-run to write.' : '\nNothing to sync.'); return }

  let updated = 0, missing = 0, failed = 0
  for (const r of rows) {
    // Only touch the owner's own migrated row; count no-match rows so a
    // partial/absent migration is visible rather than silent.
    const { data, error } = await target
      .from('trades')
      .update({ recording_commentary: r.recording_commentary })
      .eq('id', r.id)
      .eq('user_id', USER_ID)
      .select('id')
    if (error) { failed++; console.log(`  ✗ ${r.id}: ${error.message}`); continue }
    if (!data || data.length === 0) { missing++; continue }
    updated++
  }
  console.log(`\nDone. Updated ${updated} · not found on public ${missing} · failed ${failed}.`)
  if (missing > 0) console.log('  (not-found rows = trades not present in the public project yet; run migrate-to-public first if that\'s unexpected.)')
}
main().catch(e => { console.error(e); process.exit(1) })
