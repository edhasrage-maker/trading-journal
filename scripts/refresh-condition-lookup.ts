/**
 * Recompute the Morning Conditions buckets (condition_thresholds +
 * condition_lookup) for one user, from the command line.
 *
 * Same engine as the "Refresh now" button and the nightly Vercel cron — this is
 * just a way to trigger it without a browser session or CRON_SECRET, which the
 * backfills need: anything that rewrites `market_context` (notably
 * backfill-ib-day-type, whose IB_ATR values are one of the lookup's dimensions)
 * leaves the buckets stale until this runs.
 *
 *   npx tsx scripts/refresh-condition-lookup.ts
 *   npx tsx scripts/refresh-condition-lookup.ts --user=<uuid>
 *   npx tsx scripts/refresh-condition-lookup.ts --env=local
 *
 * Deliberately ONE user at a time (default: the owner). The cron sweeps every
 * tenant because it runs nightly for everyone; a manual run after a backfill
 * should only touch the account whose history actually changed.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { refreshConditionLookup } from '../src/lib/condition-lookup-refresh.ts'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const envName = argVal('env') ?? 'public'
const isProd = envName !== 'local'

// LIVE-FIRST: .env.public-feed points at prod; .env.local is the dev project.
for (const line of readFileSync(isProd ? '.env.public-feed' : '.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  (isProd ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  (isProd ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY)!,
  { auth: { persistSession: false } },
)

// On prod the condition tables are per-user; the dev build runs the single-tenant
// schema where they have no user_id and the engine wants null (a GLOBAL pass).
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = isProd ? (argVal('user') ?? OWNER_USER_ID) : null

async function main() {
  console.log(`db=${isProd ? 'PROD (public)' : 'dev (local)'}  user=${USER_ID ?? 'GLOBAL'}`)
  const t0 = Date.now()
  const r = await refreshConditionLookup(sb, USER_ID)
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(JSON.stringify(r, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
