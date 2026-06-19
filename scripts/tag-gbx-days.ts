/**
 * Day-level GBX chip: set trading_days.day_types += 'GBX' for PURE GBX days
 * (every trade that day was outside RTH). Pure-only on purpose — adding GBX to
 * mixed RTH+GBX days would attribute that day's RTH P&L to GBX in the day-type
 * analytics. Mixed days keep their RTH day type; their GBX trades stay tagged
 * per-trade (already done by tag-gbx-trades.ts).
 *
 *   npx tsx scripts/tag-gbx-days.ts            # dry run
 *   npx tsx scripts/tag-gbx-days.ts --commit   # write
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
const isOutRth = (ms: number) => { const m = ptMin(ms); return m < 390 || m >= 780 }

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
  console.log(commit ? 'MODE: COMMIT\n' : 'MODE: DRY RUN\n')
  const trades = await loadAll('trades', 'trading_day_id, entry_time')
  const byDay = new Map<string, boolean[]>()
  for (const t of trades) {
    if (!t.trading_day_id || !t.entry_time) continue
    const arr = byDay.get(t.trading_day_id) ?? []
    arr.push(isOutRth(Date.parse(t.entry_time)))
    byDay.set(t.trading_day_id, arr)
  }
  const pureDayIds = [...byDay.entries()].filter(([, flags]) => flags.length > 0 && flags.every(Boolean)).map(([id]) => id)
  console.log(`Pure-GBX days: ${pureDayIds.length}`)

  const days = await loadAll('trading_days', 'id, date, day_type, day_types')
  const dayById = new Map(days.map(d => [d.id, d]))
  let toUpdate = 0
  for (const id of pureDayIds) {
    const d = dayById.get(id); if (!d) continue
    const cur: string[] = Array.isArray(d.day_types) ? d.day_types : []
    if (cur.includes('GBX')) continue
    const next = [...cur, 'GBX']
    // Only set the legacy singular day_type on truly-untagged days, so we don't
    // flip the calendar's primary color on days that already have an RTH type.
    const update: { day_types: string[]; day_type?: string } = { day_types: next }
    if (!d.day_type && cur.length === 0) update.day_type = 'GBX'
    toUpdate++
    console.log(`  ${d.date}: day_types ${JSON.stringify(cur)} -> ${JSON.stringify(next)}${update.day_type ? '  day_type -> GBX' : ''}`)
    if (commit) {
      const { error } = await sb.from('trading_days').update(update).eq('id', id)
      if (error) console.error(`    update err: ${error.message}`)
    }
  }
  console.log(`\n${commit ? 'Updated' : 'Would update'} ${toUpdate} day(s).`)
}
main().catch(e => { console.error(e); process.exit(1) })
