/**
 * Backfill trades.structure_5m_alignment for existing trades.
 *
 * Reads 1m bars from `ohlcv_bars` (Supabase — not the CSV) since this
 * signal only needs the day's bars BEFORE entry, and BarWatcher has been
 * populating ohlcv_bars for every recent day. Trades on dates without
 * Supabase bars (older imports) stay null.
 *
 * Usage:
 *   npx tsx scripts/backfill-structure-5m-alignment.ts [--dry-run] [--force] [--limit=N]
 *
 *   --force   overwrite existing values
 *   --limit   process at most N trades total
 *
 * Schema dependency: 2026-06-17 structure_5m_alignment migration.
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeStructure5mAlignment } from '../src/lib/structure-5m.ts'
import type { BarLike } from '../src/lib/analytics.ts'

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
const limit = parseInt(argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '') || Infinity

interface TradeRow {
  id: string
  entry_time: string | null
  symbol: string | null
  direction: 'long' | 'short' | null
  structure_5m_alignment: string | null
}

async function main() {
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}, force=${force}, limit=${limit === Infinity ? 'none' : limit}\n`)

  // Fetch trades
  const PAGE = 1000
  const trades: TradeRow[] = []
  for (let p = 0; p < 50; p++) {
    let q = sb
      .from('trades')
      .select('id, entry_time, symbol, direction, structure_5m_alignment')
      .order('entry_time', { ascending: false })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!force) q = q.is('structure_5m_alignment', null)
    const { data, error } = await q
    if (error) { console.error('fetch page', p, error.message); break }
    const rows = (data ?? []) as TradeRow[]
    trades.push(...rows)
    if (rows.length < PAGE) break
  }
  console.log(`Loaded ${trades.length} trade(s) needing backfill${force ? ' (--force)' : ' (only nulls)'}\n`)

  // Group by (symbol, date) so we fetch bars once per session
  const groups = new Map<string, TradeRow[]>()
  for (const t of trades) {
    if (!t.entry_time || !t.symbol || !t.direction) continue
    const date = t.entry_time.slice(0, 10)
    const key = `${t.symbol}|${date}`
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }
  console.log(`Grouped into ${groups.size} (symbol, date) buckets\n`)

  const counts = { following: 0, fading: 0, neutral: 0, no_bars: 0, no_data: 0, written: 0 }
  let processed = 0

  for (const [key, group] of groups) {
    if (processed >= limit) break
    const [symbol, date] = key.split('|')
    const { data: barRows } = await sb
      .from('ohlcv_bars')
      .select('ts, high, low, close')
      .eq('symbol', symbol)
      .gte('ts', `${date}T00:00:00Z`)
      .lte('ts', `${date}T23:59:59Z`)
      .order('ts', { ascending: true })

    const bars: BarLike[] = barRows
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (barRows as any[]).map(b => ({ ts: b.ts, high: Number(b.high), low: Number(b.low), close: Number(b.close) }))
      : []

    if (bars.length === 0) {
      counts.no_bars += group.length
      continue
    }

    for (const t of group) {
      if (processed >= limit) break
      const alignment = computeStructure5mAlignment(
        { entry_time: t.entry_time, direction: t.direction },
        bars,
      )
      if (alignment == null) { counts.no_data++; processed++; continue }
      counts[alignment]++
      if (!dryRun) {
        const { error } = await sb.from('trades')
          .update({ structure_5m_alignment: alignment })
          .eq('id', t.id)
        if (error) console.error(`  update ${t.id} failed:`, error.message)
        else counts.written++
      }
      processed++
    }
  }

  console.log('Results:')
  console.log(`  following:  ${counts.following}`)
  console.log(`  fading:     ${counts.fading}`)
  console.log(`  neutral:    ${counts.neutral}`)
  console.log(`  no_bars:    ${counts.no_bars}  (skipped — no Supabase bars for symbol+date)`)
  console.log(`  no_data:    ${counts.no_data}  (skipped — fewer than 20 5m bars before entry)`)
  if (!dryRun) console.log(`  written:    ${counts.written}`)
  else console.log(`  written:    0 (dry run)`)
}

main().catch(e => { console.error(e); process.exit(1) })
