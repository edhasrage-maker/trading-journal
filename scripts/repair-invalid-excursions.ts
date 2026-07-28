/**
 * Clear stored excursions that the excursion guard would never have written.
 *
 * An MFE/MAE window spans entry through exit, so it must contain the trade's own
 * fill prices. When it doesn't, the bars it came from were a different contract:
 * the shared feed stores one series per mini root and has to pick a contract per
 * date around each quarterly roll, and a trader doesn't necessarily roll on the
 * day market volume does. Measured on real fills, this one rolls before the
 * crossover on some quarters and after it on others — so no per-date table can
 * be exactly right, which is why the check is per-trade (src/lib/excursion-guard.ts).
 *
 * The wrong contract trades at the carry basis (~295 NQ points in Dec 2024), so
 * the stored capture and heat for those trades were meaningless. Clearing them
 * lets backfill-excursion-from-bars.ts recompute from corrected bars; where it
 * still can't produce a valid window it now declines to write one, and the trade
 * honestly shows no capture rather than a confident wrong number.
 *
 *   npx tsx scripts/repair-invalid-excursions.ts --dry-run
 *   npx tsx scripts/repair-invalid-excursions.ts
 *   npx tsx scripts/backfill-excursion-from-bars.ts        # refill
 *
 * Only rows that are BOTH demonstrably wrong AND refillable are touched. Without
 * the second condition this would clear native broker MFE/MAE on trades older
 * than the bar feed and leave nothing in its place.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { excursionContainsFills, EXCURSION_TOLERANCE_POINTS } from '../src/lib/excursion-guard'
import { chartSeriesRoot } from '../src/lib/futures-symbols'

function loadEnv(): void {
  const path = join(process.cwd(), '.env.public-feed')
  if (!existsSync(path)) { console.error('Missing .env.public-feed in repo root.'); process.exit(1) }
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
}
loadEnv()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.PUBLIC_SUPABASE_URL!,
  process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')

// TENANT SCOPING (mandatory). The public project is multi-tenant and this
// service-role key BYPASSES RLS, so an unscoped update hits every user's rows.
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const userArg = argv.find(a => a.startsWith('--user='))
const USER_ID = userArg ? userArg.split('=')[1] : OWNER_USER_ID

interface Row {
  id: string
  symbol: string | null
  entry_time: string | null
  entry_price: number | null
  exit_price: number | null
  high_during_position: number | null
  low_during_position: number | null
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}  user=${USER_ID}  tolerance=${EXCURSION_TOLERANCE_POINTS} pts\n`)

  const rows: Row[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb
      .from('trades')
      .select('id, symbol, entry_time, entry_price, exit_price, high_during_position, low_during_position')
      .eq('user_id', USER_ID)
      .not('high_during_position', 'is', null)
      .order('id', { ascending: true })
      .range(p * 1000, p * 1000 + 999)
    if (error) { console.error('fetch:', error.message); process.exit(1) }
    const batch = (data ?? []) as Row[]
    rows.push(...batch)
    if (batch.length < 1000) break
  }
  console.log(`Trades with a stored excursion: ${rows.length}`)

  // Earliest bar held per root, so nothing is cleared that can't be recomputed.
  const firstBar = new Map<string, string>()
  for (const r of ['NQ', 'ES']) {
    const { data } = await sb.from('ohlcv_bars').select('ts').eq('symbol', r)
      .order('ts', { ascending: true }).limit(1)
    if (data?.[0]) firstBar.set(r, String(data[0].ts).slice(0, 10))
  }
  console.log(`Bar coverage starts: ${[...firstBar].map(([r, d]) => `${r} ${d}`).join(', ')}\n`)

  const invalid = rows.filter(t => !excursionContainsFills(
    Number(t.high_during_position), Number(t.low_during_position), t.entry_price, t.exit_price,
  ))
  const broken = invalid.filter(t => {
    const start = firstBar.get(chartSeriesRoot(String(t.symbol)))
    return start != null && String(t.entry_time).slice(0, 10) >= start
  })

  console.log(`Excursion does not contain its own fills:     ${invalid.length}`)
  console.log(`  ...of those, refillable from existing bars: ${broken.length}   <- will clear`)
  console.log(`Left alone (no bars to recompute from):      ${invalid.length - broken.length}\n`)

  const byMonth = new Map<string, number>()
  for (const t of broken) {
    const k = String(t.entry_time).slice(0, 7)
    byMonth.set(k, (byMonth.get(k) ?? 0) + 1)
  }
  for (const [m, n] of [...byMonth].sort()) console.log(`   ${m}  ${n}`)

  if (dryRun) { console.log('\nDry run — no writes.'); return }
  if (broken.length === 0) { console.log('\nNothing to clear.'); return }

  const BATCH = 200
  let cleared = 0
  for (let i = 0; i < broken.length; i += BATCH) {
    const slice = broken.slice(i, i + BATCH)
    const results = await Promise.all(slice.map(t =>
      sb.from('trades')
        .update({ high_during_position: null, low_during_position: null })
        .eq('id', t.id)
        .eq('user_id', USER_ID),          // scoped on the write, not just the read
    ))
    for (const r of results) { if (r.error) console.error('  update failed:', r.error.message); else cleared++ }
    process.stdout.write(`  cleared ${cleared}/${broken.length}\r`)
  }
  console.log(`\nDone. Cleared ${cleared}. Now run backfill-excursion-from-bars.ts to refill.`)
}

main().catch(e => { console.error(e); process.exit(1) })
