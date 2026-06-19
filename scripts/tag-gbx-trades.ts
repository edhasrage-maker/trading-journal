/**
 * Tag every out-of-RTH trade (RTH = 06:30–13:00 PT) with day_type='GBX', on
 * both `trades` and `historical_trades`, and register the 'GBX' day_type tag
 * in the library.
 *
 * GBX is a per-trade SESSION attribute: most trading days are mixed (RTH +
 * GBX trades), so it lives in each trade's tags_json.day_type — NOT at the day
 * level (that would mislabel mixed days). Merges into existing tags_json and
 * never clobbers a trade that already has a different day_type.
 *
 *   npx tsx scripts/tag-gbx-trades.ts            # dry run (default)
 *   npx tsx scripts/tag-gbx-trades.ts --commit   # write
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const commit = process.argv.includes('--commit')

function ptMin(ms: number): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false })
  const o: Record<string, string> = {}; for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value
  const h = o.hour === '24' ? 0 : parseInt(o.hour)
  return h * 60 + parseInt(o.minute)
}
const isOutRth = (ms: number) => { const m = ptMin(ms); return m < 390 || m >= 780 }  // <06:30 or >=13:00 PT

async function loadAll(table: string, cols: string) {
  const PAGE = 1000; const out: any[] = []  // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 50; p++) {
    const { data } = await sb.from(table).select(cols).range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || !data.length) break
    out.push(...data); if (data.length < PAGE) break
  }
  return out
}

async function main() {
  console.log(commit ? 'MODE: COMMIT\n' : 'MODE: DRY RUN (pass --commit to write)\n')

  // 1. Register the GBX tag in the library.
  if (commit) {
    const { error } = await sb.from('trade_tags').upsert(
      { category: 'day_type', label: 'GBX', sort_order: 50, description: 'Trade taken during the Globex / overnight session — entry outside RTH (06:30–13:00 PT). Session attribute, applied per-trade.' },
      { onConflict: 'category,label' },
    )
    console.log(error ? `tag register FAILED: ${error.message}` : 'GBX day_type tag registered')
  } else {
    console.log('[dry] would register GBX day_type tag')
  }

  // 2. Tag out-of-RTH trades on both tables.
  for (const [table, tsCol] of [['trades', 'entry_time'], ['historical_trades', 'open_at']] as const) {
    const rows = await loadAll(table, `id, ${tsCol}, tags_json`)
    const out = rows.filter(r => r[tsCol] && isOutRth(Date.parse(r[tsCol])))
    let already = 0, hasOther = 0
    const updates: { id: string; tags_json: Record<string, unknown> }[] = []
    for (const r of out) {
      const tj = (r.tags_json && typeof r.tags_json === 'object') ? r.tags_json : {}
      if (tj.day_type === 'GBX') { already++; continue }
      if (tj.day_type) { hasOther++; continue }  // never clobber an existing day_type
      updates.push({ id: r.id, tags_json: { ...tj, day_type: 'GBX' } })
    }
    console.log(`\n${table}: out-of-RTH=${out.length} · already GBX=${already} · has other day_type (skipped)=${hasOther} · to set=${updates.length}`)
    if (commit && updates.length) {
      const BATCH = 200; let wrote = 0
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH)
        const res = await Promise.all(batch.map(u => sb.from(table).update({ tags_json: u.tags_json }).eq('id', u.id)))
        for (const r of res) { if (r.error) console.error(`  update err: ${r.error.message}`); else wrote++ }
      }
      console.log(`  ${table}: wrote ${wrote}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
