/**
 * Copy the personal `ohlcv_bars` 1-minute feed → the PUBLIC project's shared
 * `ohlcv_bars` table, so cloud (tapescore.app) can render live ATR, Post-Exit
 * continuation, and the Live chart for days that have bars.
 *
 * ohlcv_bars is a SHARED market-data feed in the public schema (no user_id), so
 * rows are copied verbatim and de-duped on the (symbol, ts) primary key. Safe to
 * re-run — it's an idempotent upsert.
 *
 * SOURCE = personal project (read from .env.local).
 * TARGET = public project (pass its URL + NEW secret key via env).
 *
 * Usage (dry-run first):
 *   PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
 *   PUBLIC_SERVICE_ROLE_KEY=sb_secret_... \
 *   node --experimental-strip-types scripts/migrate-bars-to-public.ts --dry-run
 *
 *   …then re-run without --dry-run to write.
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
if (!SRC_URL || !SRC_KEY) { console.error('Missing personal creds in .env.local'); process.exit(1) }
if (!TGT_URL || !TGT_KEY) { console.error('Set PUBLIC_SUPABASE_URL + PUBLIC_SERVICE_ROLE_KEY (the NEW sb_secret_… key).'); process.exit(1) }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const source: any = createClient(SRC_URL, SRC_KEY)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const target: any = createClient(TGT_URL, TGT_KEY)

const dryRun = process.argv.includes('--dry-run')

async function main() {
  console.log(`Copy ohlcv_bars personal → ${TGT_URL}${dryRun ? '  (DRY RUN — no writes)' : ''}\n`)
  const PAGE = 1000
  let total = 0, wrote = 0
  for (let p = 0; p < 5000; p++) {
    // (ts, symbol) is unique (PK is symbol+ts), so this ordering paginates
    // deterministically with no boundary skips/dupes across 69k+ rows.
    const { data, error } = await source
      .from('ohlcv_bars').select('*')
      .order('ts', { ascending: true }).order('symbol', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('source ohlcv_bars:', error.message); process.exit(1) }
    const rows = data ?? []
    if (rows.length === 0) break
    total += rows.length
    if (!dryRun) {
      const { error: upErr } = await target.from('ohlcv_bars').upsert(rows, { onConflict: 'symbol,ts' })
      if (upErr) { console.error(`target ohlcv_bars (page ${p}):`, upErr.message); process.exit(1) }
      wrote += rows.length
    }
    if (p % 10 === 0) console.log(`  …${total} read${dryRun ? '' : `, ${wrote} written`}`)
    if (rows.length < PAGE) break
  }
  console.log(`\n${dryRun ? 'Would copy' : 'Copied'} ${total} bars.${dryRun ? ' Re-run without --dry-run to write.' : ''}`)
}
main().catch(e => { console.error(e); process.exit(1) })
