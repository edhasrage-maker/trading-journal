/**
 * Apply the stop/target levels that recap runs ALREADY read, but never wrote.
 *
 *   npx tsx scripts/backfill-detected-levels.ts                 # dry run (prod)
 *   npx tsx scripts/backfill-detected-levels.ts --apply
 *   npx tsx scripts/backfill-detected-levels.ts --apply --all-users
 *   npx tsx scripts/backfill-detected-levels.ts --env=local --apply
 *
 * Every "Coach is reading…" run since level detection landed has been reading
 * the planned stop and target off each entry frame and storing them in
 * trades.recording_commentary.detected_levels — but only the local ffmpeg UI
 * ever offered to apply them, so on the hosted app they piled up unused while
 * the trader typed the same numbers in by hand.
 *
 * This walks those stored reads and fills the EMPTY stop_price / tp1_price
 * columns, under exactly the rule the live path now uses: lib/frame-levels
 * re-checks each read against the trade's real fill and direction, and only a
 * "high" read writes itself. A value the trader entered is never touched.
 *
 * One caveat worth knowing: reads stored before this change never recorded the
 * order labels' point distances, so the strongest check — do the distances come
 * back to the actual fill? — cannot run on them. The geometry and equality
 * guards still do. Re-running the recap on a day is strictly better than
 * backfilling it; this is for history you don't want to pay to re-read.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { guardFrameLevels, autoApplicableFields } from '../src/lib/frame-levels.ts'

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

const APPLY = has('apply')
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

const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
// Default to the owner alone — the prod DB is multi-tenant and a sweep across
// every account is a deliberate choice, not a default.
const USER_ID = has('all-users') ? null : (argVal('user') ?? OWNER_USER_ID)

async function main() {
  console.log(`db=${isProd ? 'PROD (public)' : 'dev (local)'}  user=${USER_ID ?? 'ALL USERS'}  mode=${APPLY ? 'APPLY' : 'dry run'}\n`)

  let q = sb.from('trades')
    .select('id, user_id, entry_time, direction, entry_price, stop_price, tp1_price, recording_commentary')
    .not('recording_commentary', 'is', null)
    .order('entry_time', { ascending: false })
  if (USER_ID) q = q.eq('user_id', USER_ID)
  const { data, error } = await q
  if (error) throw error

  let scanned = 0, hadLevels = 0, wrote = 0
  const held: Record<string, number> = {}
  const writes: Array<Promise<unknown>> = []

  for (const t of data ?? []) {
    scanned++
    let rc = t.recording_commentary
    if (typeof rc === 'string') { try { rc = JSON.parse(rc) } catch { rc = null } }
    const stored = rc && typeof rc === 'object' ? rc.detected_levels : null
    if (!stored || typeof stored !== 'object') continue
    hadLevels++

    const guarded = guardFrameLevels(stored, t)
    if (!guarded) continue
    const fields = autoApplicableFields(guarded.levels, t)
    const keys = Object.keys(fields)
    if (keys.length === 0) {
      // Say why nothing happened — silent no-ops read as "nothing was there".
      const why = guarded.levels.confidence !== 'high'
        ? `read was ${guarded.levels.confidence}`
        : 'columns already filled'
      held[why] = (held[why] ?? 0) + 1
      continue
    }

    wrote++
    console.log(`${String(t.entry_time).slice(0, 19)} ${String(t.direction).padEnd(5)} @ ${t.entry_price}  →  ${keys.map(k => `${k}=${fields[k as keyof typeof fields]}`).join('  ')}`)
    if (APPLY) {
      writes.push(sb.from('trades').update({
        ...fields,
        recording_commentary: { ...rc, detected_levels: guarded.levels, auto_applied: keys },
      }).eq('id', t.id))
    }
  }

  if (APPLY && writes.length > 0) {
    const results = await Promise.allSettled(writes)
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) console.warn(`\n${failed} write(s) failed`)
  }

  console.log(`\nscanned ${scanned} commented trades · ${hadLevels} carried a stored read`)
  console.log(`${APPLY ? 'filled' : 'would fill'} ${wrote}`)
  for (const [why, n] of Object.entries(held)) console.log(`  held back — ${why}: ${n}`)
  if (!APPLY && wrote > 0) console.log('\nRe-run with --apply to write these.')
}

main().catch(e => { console.error(e); process.exit(1) })
