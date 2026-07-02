/**
 * Backfill trades.high_during_position / low_during_position from the shared NQ
 * bar feed (ohlcv_bars) for EXISTING trades whose import carried no excursion
 * data (CSV / NinjaTrader). Once these two fields are filled, all MFE/MAE/capture
 * math lights up automatically (analytics.ts reads them).
 *
 * Same clip logic as backfillExcursionsFromBars() in the CSV import route, but
 * over rows already in the PUBLIC project. Run AFTER the bar feed is populated:
 *   npx tsx scripts/public-bar-feed.ts --days N     # fill the bars first
 *   npx tsx scripts/backfill-excursion-from-bars.ts --dry-run   # preview
 *   npx tsx scripts/backfill-excursion-from-bars.ts             # write
 *
 * Only fills trades where high_during_position IS NULL and entry/exit/symbol are
 * present, and only where the feed actually has bars (root via chartSeriesRoot).
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
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
const limitArg = argv.find(a => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity

interface TradeRow { id: string; symbol: string | null; entry_time: string | null; exit_time: string | null }

async function fetchTrades(): Promise<TradeRow[]> {
  const PAGE = 1000
  const out: TradeRow[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb
      .from('trades')
      .select('id, symbol, entry_time, exit_time')
      .is('high_during_position', null)
      .not('entry_time', 'is', null)
      .not('exit_time', 'is', null)
      .not('symbol', 'is', null)
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('fetch trades:', error.message); break }
    const rows = (data ?? []) as TradeRow[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

async function fetchBars(symbol: string, startIso: string, endIso: string): Promise<Array<{ t: number; high: number; low: number }>> {
  const PAGE = 1000
  const out: Array<{ t: number; high: number; low: number }> = []
  let from = 0
  for (let page = 0; page < 80; page++) {
    const { data, error } = await sb
      .from('ohlcv_bars')
      .select('ts, high, low')
      .eq('symbol', symbol)
      .gte('ts', startIso).lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) break
    const rows = (data ?? []) as Array<{ ts: string; high: number; low: number }>
    for (const b of rows) out.push({ t: Date.parse(b.ts), high: Number(b.high), low: Number(b.low) })
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, limit=${limit === Infinity ? 'none' : limit}\n`)
  const trades = await fetchTrades()
  console.log(`Trades missing excursion (with entry/exit/symbol): ${trades.length}`)

  // Group by (chartSeriesRoot, entry date) so each fetch is ONE session's bars.
  // (A single months-long union window overruns the page cap and starves the
  // later trades of bars — that's why an all-in-one window filled only a few.)
  const byGroup = new Map<string, { root: string; rows: TradeRow[] }>()
  for (const t of trades) {
    const root = chartSeriesRoot(String(t.symbol))
    const date = String(t.entry_time).slice(0, 10)
    const key = `${root}|${date}`
    let g = byGroup.get(key); if (!g) { g = { root, rows: [] }; byGroup.set(key, g) }
    g.rows.push(t)
  }

  const updates: Array<{ id: string; high: number; low: number }> = []
  let noBars = 0
  for (const [, g] of byGroup) {
    let min = Infinity, max = -Infinity
    for (const t of g.rows) { min = Math.min(min, Date.parse(t.entry_time!)); max = Math.max(max, Date.parse(t.exit_time!)) }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue
    // Pad 2 min each side (entry-minute bar included; small slack past exit).
    const bars = await fetchBars(g.root, new Date(min - 120_000).toISOString(), new Date(max + 120_000).toISOString())
    if (bars.length === 0) { noBars += g.rows.length; continue }
    for (const t of g.rows) {
      if (updates.length >= limit) break
      const s = Date.parse(t.entry_time!), e = Date.parse(t.exit_time!)
      let hi = -Infinity, lo = Infinity
      for (const b of bars) {
        if (b.t >= s - 60_000 && b.t <= e) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low }
      }
      if (hi > -Infinity && lo < Infinity) updates.push({ id: t.id, high: Math.round(hi * 100) / 100, low: Math.round(lo * 100) / 100 })
    }
  }

  console.log(`\nComputed excursion for ${updates.length} trade(s). Skipped (no bars for their market/dates): ${noBars}.`)
  if (dryRun) { console.log('Dry run — no writes.'); return }
  if (updates.length === 0) { console.log('Nothing to write.'); return }

  const BATCH = 200
  let wrote = 0
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(u =>
      sb.from('trades').update({ high_during_position: u.high, low_during_position: u.low }).eq('id', u.id),
    ))
    for (const r of results) { if (r.error) console.error('  update failed:', r.error.message); else wrote++ }
    process.stdout.write(`  wrote ${wrote}/${updates.length}\r`)
  }
  console.log(`\nDone. Updated ${wrote} trade(s).`)
}

main().catch(e => { console.error(e); process.exit(1) })
