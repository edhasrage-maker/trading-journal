// One-shot script: merge 9 duplicate confluence labels into their canonical form.
// Rewrites tags_json.confluences in trades + historical_trades, then deletes
// the 9 victim rows from trade_tags. Idempotent — re-running after merge is
// a no-op (the victim labels won't be found anywhere).
const fs = require('fs')
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { createClient } = require('@supabase/supabase-js')
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// [victim, canonical]
const MERGES = [
  ['2nd Attempt On Trade',                        '2nd Attempt'],
  ['3rd Attempt On The Trade',                    '3rd Attempt'],
  ['Added',                                       'Added to Position'],
  ['Htf Conflluence',                             'HTF Confluence'],
  ['Head And Shoulders',                          'Head & Shoulders'],
  ['Ib Reclaim (Break And Fail)',                 'IB Reclaim (Break & Fail)'],
  ['Intraday S/R',                                'Intraday Support/Resistance'],
  ['Scratched But Price Hit Target',              'Scratched (Price Hit Target)'],
  ["Scratched But Would'Ve Stopped Out",          "Scratched (Would've Stopped Out)"],
]

async function main() {
  const victimToCanon = new Map(MERGES)
  let totalRewrites = 0

  for (const table of ['trades', 'historical_trades']) {
    let page = 0
    while (true) {
      const { data: rows, error } = await sb
        .from(table)
        .select('id, tags_json')
        .order('id')
        .range(page * 1000, page * 1000 + 999)
      if (error) throw error
      if (!rows || rows.length === 0) break

      for (const r of rows) {
        const tj = r.tags_json
        if (!tj || !Array.isArray(tj.confluences)) continue
        let changed = false
        const seen = new Set()
        const next = []
        for (const c of tj.confluences) {
          const canon = victimToCanon.get(c) ?? c
          if (canon !== c) changed = true
          if (!seen.has(canon)) {
            seen.add(canon)
            next.push(canon)
          } else {
            changed = true // dedup after canonicalization
          }
        }
        if (changed) {
          const { error: uerr } = await sb
            .from(table)
            .update({ tags_json: { ...tj, confluences: next } })
            .eq('id', r.id)
          if (uerr) throw uerr
          totalRewrites++
        }
      }

      if (rows.length < 1000) break
      page++
    }
    console.log(`[${table}] scanned through page ${page}, running rewrites = ${totalRewrites}`)
  }

  // Delete the 9 victim rows from trade_tags
  const victims = MERGES.map(([v]) => v)
  const { error: derr, count } = await sb
    .from('trade_tags')
    .delete({ count: 'exact' })
    .eq('category', 'confluences')
    .in('label', victims)
  if (derr) throw derr
  console.log(`Deleted ${count} victim rows from trade_tags.confluences`)
  console.log(`Total rewrites: ${totalRewrites}`)

  // Sanity recount
  const { count: cnt } = await sb
    .from('trade_tags')
    .select('*', { count: 'exact', head: true })
    .eq('category', 'confluences')
  console.log(`Confluences row count after: ${cnt}`)
}

main().catch(e => { console.error(e); process.exit(1) })
