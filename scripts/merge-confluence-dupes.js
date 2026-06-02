// Merge duplicate tag labels into their canonical form, per category.
// Rewrites tags_json[<category>] in trades + historical_trades, then deletes
// the victim rows from trade_tags. Idempotent — re-running after a merge is
// a no-op (the victim labels won't be found anywhere). New batches are
// appended to MERGES; previously-completed entries simply find no work.
const fs = require('fs')
for (const l of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const { createClient } = require('@supabase/supabase-js')
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// [category, victim_label, canonical_label]
const MERGES = [
  // confluences (initial batch — Tradezella case/wording variants)
  ['confluences', '2nd Attempt On Trade',                        '2nd Attempt'],
  ['confluences', '3rd Attempt On The Trade',                    '3rd Attempt'],
  ['confluences', 'Added',                                       'Added to Position'],
  ['confluences', 'Htf Conflluence',                             'HTF Confluence'],
  ['confluences', 'Head And Shoulders',                          'Head & Shoulders'],
  ['confluences', 'Ib Reclaim (Break And Fail)',                 'IB Reclaim (Break & Fail)'],
  ['confluences', 'Intraday S/R',                                'Intraday Support/Resistance'],
  ['confluences', 'Scratched But Price Hit Target',              'Scratched (Price Hit Target)'],
  ['confluences', "Scratched But Would'Ve Stopped Out",          "Scratched (Would've Stopped Out)"],
  // trade_management (Tradezella long-form variants of curated labels)
  ['trade_management', 'Missed Target And Price Came Back',                'Missed Target (Price Came Back)'],
  ['trade_management', 'Tp2 Early Exit - Scared To Give Back Gains',       'TP2 Early Exit (Scared to Give Back)'],
  ['trade_management', 'Tp2 - 2 Heiken Ashi Flips Against Me',             'TP2 2 Heiken-Ashi Flips Against'],
  // mistakes
  ['mistakes', 'Greedy - Price Almost Hit Tp But Reversed',                'Greedy (Price Almost Hit TP)'],
]

async function main() {
  // Bucket by category so each pass rewrites only the relevant tags_json array.
  const byCat = new Map()
  for (const [cat, victim, canon] of MERGES) {
    if (!byCat.has(cat)) byCat.set(cat, new Map())
    byCat.get(cat).set(victim, canon)
  }

  let grandTotal = 0
  for (const [cat, victimToCanon] of byCat.entries()) {
    let cTotal = 0
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
          if (!tj || !Array.isArray(tj[cat])) continue
          let changed = false
          const seen = new Set()
          const next = []
          for (const c of tj[cat]) {
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
              .update({ tags_json: { ...tj, [cat]: next } })
              .eq('id', r.id)
            if (uerr) throw uerr
            cTotal++
          }
        }

        if (rows.length < 1000) break
        page++
      }
    }
    console.log(`[${cat}] rewrote ${cTotal} rows`)

    // Delete the victim rows from trade_tags for this category
    const victims = [...victimToCanon.keys()]
    const { error: derr, count } = await sb
      .from('trade_tags')
      .delete({ count: 'exact' })
      .eq('category', cat)
      .in('label', victims)
    if (derr) throw derr
    console.log(`[${cat}] deleted ${count} victim trade_tags rows`)

    const { count: cnt } = await sb
      .from('trade_tags')
      .select('*', { count: 'exact', head: true })
      .eq('category', cat)
    console.log(`[${cat}] row count after: ${cnt}`)

    grandTotal += cTotal
  }

  console.log(`Total trade/historical_trade rewrites: ${grandTotal}`)
}

main().catch(e => { console.error(e); process.exit(1) })
