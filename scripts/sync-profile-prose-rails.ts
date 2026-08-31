/**
 * Reconcile the trader-profile PROSE (`trader_profile.preferences_md`) against
 * the STRUCTURED rails (`scoring_profile_json.rails`) for one user.
 *
 * Why this exists: `preferences_md` is injected into every EOD / weekly / coach
 * prompt under "TRADER PROFILE — standing context, RESPECT THIS … Treat this as
 * ground truth". The structured rails drive scoring, but the prose drives what
 * the model SAYS. When a rail is removed from `rails` and left in the prose
 * table, the model keeps asserting it as a live rule — which is exactly how the
 * "mandatory 90-second cooldown is already a rule" line survived the removal of
 * `rails.cooldown_min`.
 *
 * This drops the "## Risk & Rules" table rows whose backing rail is now null.
 * Rows with no backing rail (Risk/trade, Stop, Target, Add to losers) are left
 * alone — they are style, not a graded rail.
 *
 *   npx tsx scripts/sync-profile-prose-rails.ts            # dry run — shows the diff
 *   npx tsx scripts/sync-profile-prose-rails.ts --apply     # write it
 *   npx tsx scripts/sync-profile-prose-rails.ts --apply --user=<uuid>
 *
 * Prod (.env.public-feed).
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const APPLY = argv.includes('--apply')

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

/** Prose table row label -> the rails key that must be non-null for it to stand. */
const ROW_RAIL: Array<{ match: RegExp; railKey: string; label: string }> = [
  { match: /^\|\s*Max position size\s*\|/i,       railKey: 'max_size',        label: 'Max position size' },
  { match: /^\|\s*Max trades\s*\/?\s*day\s*\|/i,  railKey: 'max_trades',      label: 'Max trades/day' },
  { match: /^\|\s*Cooldown between trades\s*\|/i, railKey: 'cooldown_min',    label: 'Cooldown between trades' },
  { match: /^\|\s*Daily loss limit\s*\|/i,        railKey: 'daily_loss_limit', label: 'Daily loss limit' },
]

async function main() {
  const { data, error } = await sb
    .from('trader_profile')
    .select('id, user_id, preferences_md, scoring_profile_json')
    .eq('user_id', USER_ID)
    .maybeSingle()

  if (error) { console.error('read failed:', error.message); process.exit(1) }
  if (!data) { console.error('no trader_profile row for user', USER_ID); process.exit(1) }

  const rails = (data.scoring_profile_json?.rails ?? {}) as Record<string, unknown>
  const lines: string[] = String(data.preferences_md ?? '').split(/\r?\n/)

  const dropped: string[] = []
  const kept = lines.filter(line => {
    const hit = ROW_RAIL.find(r => r.match.test(line.trim()))
    if (!hit) return true
    if (rails[hit.railKey] != null) return true
    dropped.push(`${hit.label}  (rails.${hit.railKey} is null)  ->  ${line.trim()}`)
    return false
  })

  console.log(`user ${USER_ID}  profile ${data.id}`)
  console.log(`rails: ${JSON.stringify(rails)}`)
  if (dropped.length === 0) {
    console.log('\nProse and rails already agree — nothing to drop.')
    return
  }
  console.log(`\nStale prose rows (asserted in the profile, NOT set in rails):`)
  for (const d of dropped) console.log('  - ' + d)

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return }

  const next = kept.join('\n')
  const { error: upErr } = await sb
    .from('trader_profile')
    .update({ preferences_md: next })
    .eq('id', data.id)
    .eq('user_id', USER_ID)

  if (upErr) { console.error('write failed:', upErr.message); process.exit(1) }
  console.log(`\nWrote preferences_md (${lines.length} -> ${kept.length} lines).`)
}

main().catch(e => { console.error(e); process.exit(1) })
