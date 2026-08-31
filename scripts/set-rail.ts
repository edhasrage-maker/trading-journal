/**
 * Set (or clear) ONE structured rail on a trader's scoring profile.
 *
 * `trader_profile.scoring_profile_json.rails` is what actually gets graded:
 * `resolveRails` reads it, `activeRailIds` decides which of P1..P5 are live,
 * and the EOD prompt renders "NOT TRACKED" for anything null. The prose in
 * `preferences_md` does NOT grade anything (see sync-profile-prose-rails.ts).
 *
 * Cooldown is stored in MINUTES and multiplied by 60 downstream, so 90 seconds
 * is `--value=1.5`. resolveRails -> cooldownSec 90; the prompt renders
 * "P4 = Cooldown after a loss: >= 90s (1.5 min) before re-entry."
 *
 *   npx tsx scripts/set-rail.ts --rail=cooldown_min --value=1.5          # dry run
 *   npx tsx scripts/set-rail.ts --rail=cooldown_min --value=1.5 --apply
 *   npx tsx scripts/set-rail.ts --rail=cooldown_min --clear --apply
 *
 * Prod (.env.public-feed).
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const APPLY = argv.includes('--apply')
const CLEAR = argv.includes('--clear')

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

/** The rails that drive a P-rule, and the P-rule each one turns on. */
const RAIL_PRULE: Record<string, string> = {
  daily_loss_limit: 'P1',
  max_size: 'P2 + P3',
  max_trades: 'P5',
  cooldown_min: 'P4',
}

async function main() {
  const RAIL = argVal('rail')
  if (!RAIL || !(RAIL in RAIL_PRULE)) {
    console.error(`--rail must be one of: ${Object.keys(RAIL_PRULE).join(', ')}`)
    process.exit(1)
  }
  const raw = argVal('value')
  const VALUE = CLEAR ? null : (raw != null && Number.isFinite(parseFloat(raw)) ? parseFloat(raw) : null)
  if (!CLEAR && VALUE == null) { console.error('--value=<number> required (or --clear)'); process.exit(1) }

  const { data, error } = await sb
    .from('trader_profile')
    .select('id, user_id, scoring_profile_json')
    .eq('user_id', USER_ID)
    .maybeSingle()

  if (error) { console.error('read failed:', error.message); process.exit(1) }
  if (!data) { console.error('no trader_profile row for user', USER_ID); process.exit(1) }

  const sp = { ...(data.scoring_profile_json ?? {}) }
  const rails = { ...((sp.rails ?? {}) as Record<string, unknown>) }
  const before = rails[RAIL] ?? null

  console.log(`user ${USER_ID}  profile ${data.id}`)
  console.log(`rails BEFORE: ${JSON.stringify(rails)}`)
  console.log(`\n  ${RAIL}: ${JSON.stringify(before)}  ->  ${JSON.stringify(VALUE)}   (${RAIL_PRULE[RAIL]})`)
  if (RAIL === 'cooldown_min' && VALUE != null) {
    console.log(`  downstream: resolveRails -> cooldownSec ${VALUE * 60}s; P4 becomes a GRADED rail on every trade.`)
  }
  if (VALUE == null) console.log(`  downstream: ${RAIL_PRULE[RAIL]} becomes NOT TRACKED and auto-passes.`)

  if (before === VALUE) { console.log('\nAlready at that value — nothing to do.'); return }
  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return }

  rails[RAIL] = VALUE
  sp.rails = rails
  const { error: upErr } = await sb
    .from('trader_profile')
    .update({ scoring_profile_json: sp })
    .eq('id', data.id)
    .eq('user_id', USER_ID)

  if (upErr) { console.error('write failed:', upErr.message); process.exit(1) }
  console.log(`\nrails AFTER:  ${JSON.stringify(rails)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
