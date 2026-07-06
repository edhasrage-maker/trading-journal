/**
 * Backfill entry_atr_1m + post-exit continuation for PUBLIC-project trades from
 * the shared bar feed (ohlcv_bars, keyed by the mini root NQ/ES). Complements
 * backfill-excursion-from-bars.ts (which fills high/low_during_position) — this
 * fills the two bar-derived fields that import leaves null when the day's bars
 * weren't in the DB yet:
 *   - entry_atr_1m               (Wilder ATR-10 at entry, liveAtr)
 *   - post_exit_favorable_pts    (postExitExtension, 30-min window)
 *   - post_exit_against_pts
 * using src/lib/atr.ts's EXACT logic, so the numbers match the app.
 *
 * Run AFTER the bar feed has the day's bars:
 *   npx tsx scripts/public-bar-feed.ts <date>
 *   npx tsx scripts/backfill-public-trade-metrics.ts --date=YYYY-MM-DD --dry-run
 *   npx tsx scripts/backfill-public-trade-metrics.ts --date=YYYY-MM-DD
 *
 * Only fills fields that are currently NULL (idempotent; never overwrites).
 * Bars are looked up by chartSeriesRoot(symbol) because the public feed stores
 * under the mini root (NQ/ES), not the micro/dated contract (MNQU6.CME).
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { chartSeriesRoot } from '../src/lib/futures-symbols'
import { fetchAllBars, liveAtr, postExitExtension, type AtrBar } from '../src/lib/atr'
import { todayPT } from '../src/lib/pt-time'

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
const dateArg = argv.find(a => a.startsWith('--date='))?.split('=')[1] ?? todayPT()

interface TradeRow {
  id: string
  symbol: string | null
  direction: 'long' | 'short' | null
  entry_time: string | null
  exit_time: string | null
  exit_price: number | null
  entry_atr_1m: number | null
  post_exit_favorable_pts: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const { data: day } = await sb.from('trading_days').select('id').eq('date', dateArg).maybeSingle()
  if (!day) { console.log(`No trading_day for ${dateArg} in public DB.`); return }

  const { data: trades, error } = await sb
    .from('trades')
    .select('id, symbol, direction, entry_time, exit_time, exit_price, entry_atr_1m, post_exit_favorable_pts')
    .eq('trading_day_id', day.id)
    .order('entry_time', { ascending: true })
  if (error) { console.error('fetch trades:', error.message); process.exit(1) }

  // One bars-of-day fetch per root, cached.
  const barCache = new Map<string, AtrBar[]>()
  async function barsFor(symbol: string): Promise<{ root: string; bars: AtrBar[] }> {
    const root = chartSeriesRoot(symbol)
    if (!barCache.has(root)) barCache.set(root, await fetchAllBars(sb, root, dateArg))
    return { root, bars: barCache.get(root)! }
  }

  console.log(`[backfill-public-trade-metrics] ${dateArg}${dryRun ? '  (dry-run)' : ''}`)
  let filled = 0
  for (const t of (trades ?? []) as TradeRow[]) {
    if (!t.symbol || !t.entry_time) continue
    const { root, bars } = await barsFor(t.symbol)
    if (!bars.length) { console.log(`  ${t.entry_time.slice(11, 16)} ${t.symbol} → no ${root} bars`); continue }

    const update: Record<string, number> = {}
    if (t.entry_atr_1m == null) {
      const atr = liveAtr(bars, new Date(t.entry_time), 10)
      if (atr != null) update.entry_atr_1m = r2(atr)
    }
    if (t.post_exit_favorable_pts == null) {
      const pe = postExitExtension(bars, { direction: t.direction, exit_price: t.exit_price, exit_time: t.exit_time }, 30)
      if (pe) {
        update.post_exit_favorable_pts = r2(pe.continued_favorable_pts)
        update.post_exit_against_pts = r2(pe.continued_against_pts)
      }
    }
    if (Object.keys(update).length === 0) { console.log(`  ${t.entry_time.slice(11, 16)} ${t.symbol} → nothing to fill`); continue }

    console.log(`  ${t.entry_time.slice(11, 16)} ${t.symbol.padEnd(11)} atr=${update.entry_atr_1m ?? '(kept)'}  postFav=${update.post_exit_favorable_pts ?? '-'}  postAg=${update.post_exit_against_pts ?? '-'}`)
    if (!dryRun) {
      const { error: uerr } = await sb.from('trades').update(update).eq('id', t.id)
      if (uerr) console.error(`    update failed: ${uerr.message}`)
      else filled++
    }
  }
  console.log(dryRun ? '(dry-run — no writes)' : `Updated ${filled} trade(s).`)
}

main().catch(e => { console.error(e); process.exit(1) })
