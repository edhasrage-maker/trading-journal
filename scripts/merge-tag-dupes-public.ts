/**
 * Merge duplicate tag labels into their canonical form on the PUBLIC/prod DB,
 * SCOPED TO ONE USER.
 *
 * Rewrites tags_json[<category>] across trades + historical_trades, then deletes
 * the victim row from trade_tags. Idempotent: re-running finds no work.
 *
 * Why a new script instead of scripts/merge-confluence-dupes.js: that one targets
 * the personal DB (.env.local) and is unscoped. trade_tags on prod carries a
 * user_id and several accounts have their OWN "FOMO Trade" — a service-role key
 * bypasses RLS, so an unscoped merge here would silently rewrite other traders'
 * journals. Every query below is pinned to --user.
 *
 *   npx tsx scripts/merge-tag-dupes-public.ts --user you@x.com            # dry run
 *   npx tsx scripts/merge-tag-dupes-public.ts --user you@x.com --commit   # write
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)

const arg = (n: string) => {
  const eq = process.argv.find(a => a.startsWith(`--${n}=`))
  if (eq) return eq.split('=').slice(1).join('=')
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const COMMIT = process.argv.includes('--commit')
const userArg = arg('user')

/** [category, victim label, canonical label]. Canonical is the label with the
 *  deeper history — merging INTO the rarely-used one would rewrite hundreds of
 *  rows to save one. Both victims here are seeded defaults (sort_order 2 and 9)
 *  that collide with the trader's own curated labels. */
const MERGES: [string, string, string][] = [
  ['mistakes', 'FOMO Trade', 'FOMO'],
  ['mistakes', 'Revenge Trade', 'Revenge Trading'],
  // Case-only collision: the seeded default (sort 11) vs the trader's own
  // curated label (sort 260, 108 uses). tags_json holds raw strings, so the two
  // casings were two separate tags everywhere downstream.
  ['confluences', 'Follow LTF structure', 'Follow LTF Structure'],
  // Same concept per the trader; 5 uses vs 38 on the long form.
  ['confluences', 'Waited for 2x Failed Attempts', 'Waited For 2x Failed Attempts From Opposing Side'],
  // 5–5 TIE on usage, so "keep the one with more" didn't decide it. Canonical is
  // the short chip: it stays readable in the picker, and the trader confirmed the
  // long form adds no distinct concept. Flipping it later is just another merge.
  ['mistakes', 'No Confirmation of Buyers/Sellers Stepping In', 'No Confirmation'],
]

const TABLES = ['trades', 'historical_trades'] as const

async function resolveUserId(email: string): Promise<string | undefined> {
  const { data } = await sb.auth.admin.listUsers()
  return (data?.users ?? []).find((u: { email?: string; id: string }) => u.email === email)?.id
}

async function main() {
  if (!userArg) { console.error('--user <email> is required (this DB is multi-tenant)'); process.exit(1) }
  const uid = await resolveUserId(userArg)
  if (!uid) { console.error(`user not found: ${userArg}`); process.exit(1) }
  console.log(`PUBLIC DB | ${userArg} | ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`)

  let rewrites = 0, deletions = 0
  for (const [category, victim, canonical] of MERGES) {
    console.log(`── ${category}: "${victim}" → "${canonical}"`)
    for (const table of TABLES) {
      // `.contains()` mangles a jsonb-path array into invalid JSON; the raw
      // `cs` filter with an explicit JSON string is what PostgREST wants.
      const { data, error } = await sb
        .from(table)
        .select('id, tags_json')
        .eq('user_id', uid)
        .filter(`tags_json->${category}`, 'cs', JSON.stringify([victim]))
      if (error) { console.error(`   ${table}: query failed — ${error.message}`); continue }
      const rows = data ?? []
      console.log(`   ${table}: ${rows.length} row(s) carry the victim label`)
      for (const row of rows) {
        const tags = { ...(row.tags_json ?? {}) }
        const arr: string[] = Array.isArray(tags[category]) ? tags[category] : []
        // Replace, then dedup — a trade tagged with BOTH labels must not end up
        // with the canonical twice.
        const next = [...new Set(arr.map(l => (l === victim ? canonical : l)))]
        rewrites++
        if (!COMMIT) { console.log(`     would rewrite ${row.id}: [${arr.join(', ')}] → [${next.join(', ')}]`); continue }
        tags[category] = next
        const { error: upErr } = await sb.from(table).update({ tags_json: tags }).eq('id', row.id).eq('user_id', uid)
        if (upErr) console.error(`     update failed ${row.id}: ${upErr.message}`)
      }
    }
    // Retire the duplicate chip from the trader's own picker (their row only).
    const { data: victimRows } = await sb
      .from('trade_tags').select('id, label').eq('user_id', uid).eq('category', category).eq('label', victim)
    for (const vr of victimRows ?? []) {
      deletions++
      if (!COMMIT) { console.log(`   would delete trade_tags row ${vr.id} ("${victim}")`); continue }
      const { error: delErr } = await sb.from('trade_tags').delete().eq('id', vr.id).eq('user_id', uid)
      if (delErr) console.error(`   delete failed ${vr.id}: ${delErr.message}`)
    }
    console.log('')
  }
  console.log(`${COMMIT ? 'Wrote' : 'Would write'} ${rewrites} tag rewrite(s) and ${deletions} tag-row deletion(s).`)
  if (!COMMIT) console.log('Re-run with --commit to apply.')
}

main().catch(e => { console.error(e); process.exit(1) })
