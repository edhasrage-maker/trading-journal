import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { emaSeries, slopePercent, slopeDegrees } from './ema'
import { loadNativeTrades, loadHistoricalTrades, loadBarsForDay, type NormalizedTrade } from './load'
import { bucketLabel } from './buckets'
import { aggregate } from './stats'

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

type Args = {
  from: string
  to: string
  ema: number
  lookback: number
  bucketUnit: 'pct' | 'deg'
  bucketSize: number
  tickSize: number
  source: 'all' | 'trades' | 'historical_trades'
  symbol: string | null
}

function parseArgs(): Args {
  const a: Record<string, string> = {}
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i]
    const v = process.argv[i + 1]
    if (k.startsWith('--') && v !== undefined) a[k.slice(2)] = v
  }
  const unit = (a.unit ?? 'pct') as 'pct' | 'deg'
  return {
    from: a.from ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    to: a.to ?? new Date().toISOString().slice(0, 10),
    ema: Number(a.ema ?? 21),
    lookback: Number(a.lookback ?? 5),
    bucketUnit: unit,
    bucketSize: Number(a.bucket ?? (unit === 'deg' ? 5 : 0.02)),
    tickSize: Number(a.tick ?? 0.25),
    source: (a.source ?? 'all') as Args['source'],
    symbol: a.symbol ?? null,
  }
}

function floorMinuteIso(iso: string): string {
  const d = new Date(iso)
  d.setUTCSeconds(0, 0)
  return d.toISOString()
}

function utcDateOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

async function main() {
  const args = parseArgs()
  console.log('args:', args)

  const trades: NormalizedTrade[] = []
  if (args.source !== 'historical_trades') trades.push(...await loadNativeTrades(sb, args.from, args.to))
  if (args.source !== 'trades') trades.push(...await loadHistoricalTrades(sb, args.from, args.to))
  const filtered = args.symbol ? trades.filter(t => t.symbol === args.symbol) : trades
  console.log(`Loaded ${trades.length} trades (${filtered.length} after symbol filter)`)

  const byKey = new Map<string, NormalizedTrade[]>()
  for (const t of filtered) {
    if (!t.symbol) continue
    const key = `${t.symbol}|${utcDateOf(t.entry_time)}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key)!.push(t)
  }
  console.log(`Grouped into ${byKey.size} (symbol, day) buckets`)

  type Row = { bucket: string; pnl: number; slope: number }
  const rows: Row[] = []
  let missingBars = 0
  let outOfRange = 0
  for (const [key, group] of byKey) {
    const [symbol, day] = key.split('|')
    const bars = await loadBarsForDay(sb, symbol, day)
    if (bars.length < args.ema + args.lookback + 2) {
      missingBars += group.length
      continue
    }
    const closes = bars.map(b => b.close)
    const ema = emaSeries(closes, args.ema)
    const tsIndex = new Map(bars.map((b, i) => [floorMinuteIso(b.ts), i]))
    for (const t of group) {
      const idx = tsIndex.get(floorMinuteIso(t.entry_time))
      // Use idx-1 to avoid lookahead: the EMA at the bar containing the entry
      // includes that bar's close, which wasn't known at the fill moment.
      if (idx == null || idx < 1) { outOfRange++; continue }
      const slope = args.bucketUnit === 'pct'
        ? slopePercent(ema, idx - 1, args.lookback)
        : slopeDegrees(ema, idx - 1, args.lookback, args.tickSize)
      if (slope == null) { outOfRange++; continue }
      // Align slope with trade direction: positive = "the move was with you".
      const directional = t.direction === 'long' ? slope : -slope
      rows.push({
        bucket: bucketLabel(directional, args.bucketSize),
        pnl: t.pnl,
        slope: directional,
      })
    }
  }
  console.log(`Slope computed for ${rows.length} trades (missing bars: ${missingBars}, out-of-range: ${outOfRange})`)

  const agg = aggregate(rows.map(r => ({ bucket: r.bucket, pnl: r.pnl })))

  const unitLabel = args.bucketUnit === 'pct' ? '%/bar' : 'deg'
  console.log(`\nEMA${args.ema} slope (${args.lookback}-bar lookback, aligned with trade direction), bucket ${args.bucketSize} ${unitLabel}\n`)
  const cols = ['bucket', 'n', 'wr', 'avgPnL', 'totalPnL', 'avgWin', 'avgLoss', 'ev']
  const widths = [20, 5, 7, 10, 12, 10, 10, 10]
  console.log(cols.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join(' '))
  for (const a of agg) {
    console.log([
      a.bucket.padEnd(widths[0]),
      String(a.count).padStart(widths[1]),
      ((a.winRate * 100).toFixed(1) + '%').padStart(widths[2]),
      a.avgPnL.toFixed(2).padStart(widths[3]),
      a.totalPnL.toFixed(2).padStart(widths[4]),
      a.avgWin.toFixed(2).padStart(widths[5]),
      a.avgLoss.toFixed(2).padStart(widths[6]),
      a.ev.toFixed(2).padStart(widths[7]),
    ].join(' '))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
