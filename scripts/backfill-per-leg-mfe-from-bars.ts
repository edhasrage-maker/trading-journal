/**
 * Backfill trades.mfe_dollars_per_leg for multi-leg trades by reading the
 * SAME source the live SC-log import uses: ohlcv_bars, fetched per (PT date,
 * symbol) with sessionUtcWindow().
 *
 * Why a second backfill (vs scripts/backfill-per-leg-mfe.ts):
 *   - That script walks a continuous CSV + NQM6.scid series. The scid tail is
 *     hardcoded to NQM6 (June 2026), which expired at the June roll — so it
 *     CAN'T cover post-roll trades (e.g. NQU6 late-June GBX trades).
 *   - More importantly, GBX / post-RTH trades were imported BEFORE the bar
 *     window fix (sessionUtcWindow). Their evening fills land in the early
 *     hours of the next UTC day, so the old `${date}T00:00:00Z..T23:59:59Z`
 *     window missed their bars → mfe_dollars_per_leg stayed null → the read
 *     layer fell back to the harsh full-qty estimate.
 *
 * This script uses the per-date contract bars already in ohlcv_bars (whatever
 * symbol the trade actually traded) and the PT-session window, then runs the
 * canonical perLegMaxDollars() — identical math to the live import. So GBX/
 * overnight multi-leg trades get the same fair per-leg ceiling as RTH ones.
 *
 * Scope: native `trades` only, exits_json.length > 1 (single-leg trades use the
 * simple formula at read time and don't carry this column). Defaults to filling
 * nulls only — which is exactly the GBX set, since RTH multi-leg trades already
 * got a value at import. Use --force to recompute every multi-leg trade.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-per-leg-mfe-from-bars.ts [--dry-run] [--force] [--limit=N]
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { perLegMaxDollars, type BarLike, type ExitLeg } from '../src/lib/analytics.ts'
import { sessionUtcWindow } from '../src/lib/pt-time.ts'
import { isOutsideRth } from '../src/lib/rth.ts'

// Load .env.local
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')
const limitArg = argv.find(a => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity

interface TradeRow {
  id: string
  trading_day_id: string
  date: string
  entry_time: string | null
  entry_price: number | null
  direction: 'long' | 'short' | null
  quantity: number | null
  symbol: string | null
  exits_json: ExitLeg[] | null
  high_during_position: number | null
  low_during_position: number | null
  mfe_dollars_per_leg: number | null
}

async function fetchDayDates(): Promise<Map<string, string>> {
  const PAGE = 1000
  const out = new Map<string, string>()
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb
      .from('trading_days')
      .select('id, date')
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('  fetch trading_days page', p, error.message); break }
    const rows = (data ?? []) as { id: string; date: string }[]
    for (const r of rows) out.set(r.id, r.date)
    if (rows.length < PAGE) break
  }
  return out
}

async function fetchMultiLegTrades(dayDates: Map<string, string>): Promise<TradeRow[]> {
  const PAGE = 1000
  const out: TradeRow[] = []
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('trades')
      .select('id, trading_day_id, entry_time, entry_price, direction, quantity, symbol, exits_json, high_during_position, low_during_position, mfe_dollars_per_leg')
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('mfe_dollars_per_leg', null)
    const { data, error } = await q
    if (error) { console.error('  fetch trades page', p, error.message); break }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]
    for (const r of rows) {
      // Multi-leg only — single-leg trades use the simple read-time formula.
      if (!Array.isArray(r.exits_json) || r.exits_json.length <= 1) continue
      const date = dayDates.get(r.trading_day_id)
      if (!date) continue
      out.push({
        id: r.id, trading_day_id: r.trading_day_id, date,
        entry_time: r.entry_time, entry_price: r.entry_price, direction: r.direction,
        quantity: r.quantity, symbol: r.symbol, exits_json: r.exits_json,
        high_during_position: r.high_during_position, low_during_position: r.low_during_position,
        mfe_dollars_per_leg: r.mfe_dollars_per_leg,
      })
    }
    if (rows.length < PAGE) break
  }
  return out
}

async function fetchSessionBars(symbol: string, date: string): Promise<BarLike[]> {
  const { start, end } = sessionUtcWindow(date)
  const PAGE = 1000
  const out: BarLike[] = []
  let from = 0
  for (let page = 0; page < 10; page++) {
    const { data, error } = await sb
      .from('ohlcv_bars')
      .select('ts, high, low, close')
      .eq('symbol', symbol)
      .gte('ts', start)
      .lte('ts', end)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { console.error(`  bars ${symbol} ${date}:`, error.message); break }
    const rows = (data ?? []) as { ts: string; high: number; low: number; close: number }[]
    for (const b of rows) out.push({ ts: b.ts, high: Number(b.high), low: Number(b.low) })
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, force=${force}, limit=${limit === Infinity ? 'none' : limit}`)
  console.log()

  const dayDates = await fetchDayDates()
  console.log(`Loaded ${dayDates.size} trading day(s)`)
  const trades = await fetchMultiLegTrades(dayDates)
  console.log(`Loaded ${trades.length} multi-leg trade(s)${force ? ' (--force: all)' : ' (only nulls)'}`)
  console.log()

  // Group by (date | symbol) so we fetch each session's bars exactly once.
  const groups = new Map<string, TradeRow[]>()
  for (const t of trades) {
    if (!t.symbol) continue
    const key = `${t.date}|${t.symbol}`
    let arr = groups.get(key)
    if (!arr) { arr = []; groups.set(key, arr) }
    arr.push(t)
  }
  console.log(`Grouped into ${groups.size} (date, symbol) session(s)`)
  console.log()

  const updates: Array<{ id: string; value: number; gbx: boolean; was: number | null }> = []
  let barGap = 0, badInput = 0, processed = 0, gbxCount = 0
  let samples = 0
  const SAMPLE_N = 8
  const gapSessions: string[] = []  // (date, symbol) sessions with zero bars in ohlcv_bars

  for (const [key, rows] of groups) {
    if (processed >= limit) break
    const [date, symbol] = key.split('|')
    const bars = await fetchSessionBars(symbol, date)
    if (bars.length === 0) { barGap += rows.length; gapSessions.push(`${key} (${rows.length} trade${rows.length === 1 ? '' : 's'})`); continue }
    for (const t of rows) {
      if (processed >= limit) break
      // perLegMaxDollars reads entry_price/direction/quantity/entry_time/exits_json
      // /high_during_position/low_during_position — exactly our TradeRow shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = perLegMaxDollars(t as any, bars)
      if (value == null) { barGap++; continue }
      if (!(value > 0)) { badInput++; continue }
      const rounded = Math.round(value * 100) / 100
      // Skip no-op rewrites under --force (value unchanged).
      if (force && t.mfe_dollars_per_leg != null && Math.abs(t.mfe_dollars_per_leg - rounded) < 0.005) continue
      const gbx = t.entry_time ? isOutsideRth(t.entry_time) : false
      if (gbx) gbxCount++
      updates.push({ id: t.id, value: rounded, gbx, was: t.mfe_dollars_per_leg })
      processed++
      if (samples < SAMPLE_N) {
        console.log(`  sample #${samples + 1}: ${date} ${symbol.padEnd(12)} ${t.direction?.padEnd(5)} entry=${t.entry_price} qty=${t.quantity} legs=${t.exits_json?.length} ${gbx ? 'GBX' : 'RTH'}  ${t.mfe_dollars_per_leg == null ? 'null' : '$' + t.mfe_dollars_per_leg} -> $${rounded.toFixed(2)}`)
        samples++
      }
    }
  }

  console.log()
  console.log(`Computed: ${updates.length} (of which GBX/overnight: ${gbxCount})`)
  console.log(`Skipped — bar gap (no bars in session window): ${barGap}`)
  console.log(`Skipped — zero/invalid excursion: ${badInput}`)
  if (gapSessions.length > 0) {
    console.log(`\n  Sessions with NO bars in ohlcv_bars (import SCID for these, then re-run):`)
    for (const s of gapSessions) console.log(`    - ${s}`)
  }

  if (dryRun) { console.log('\nDry run — no writes.'); return }
  if (updates.length === 0) { console.log('\nNothing to write.'); return }

  const BATCH = 200
  let wrote = 0
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(u =>
      sb.from('trades').update({ mfe_dollars_per_leg: u.value }).eq('id', u.id),
    ))
    for (const r of results) {
      if (r.error) console.error('  update failed:', r.error.message)
      else wrote++
    }
    process.stdout.write(`  wrote ${wrote}/${updates.length}\r`)
  }
  console.log(`\nDone. Updated ${wrote} trade(s).`)
}

main().catch(e => { console.error(e); process.exit(1) })
