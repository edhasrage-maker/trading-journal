/**
 * Phase-1 validation: reproduce the follow/fade study's 289 / 253 / 373 split
 * on the 915 historical_trades, using the ported pivot market-structure over a
 * continuous NQ front-month 5m series built from .scid.
 *
 *   npx tsx scripts/validate-market-structure.ts
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'
import { findPivots, structureAt, followFade, type Regime } from '../src/lib/market-structure.ts'

for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const DATA = 'D:\\SierraCharts\\Data'
// Continuous NQ front-month: each contract during its front-month window
// (roll = 8 days before the quarterly 3rd-Friday expiry). seg = array index.
const CONTRACTS = [
  { file: 'NQM5.CME.scid', start: '2025-03-13', end: '2025-06-12' },
  { file: 'NQU5.CME.scid', start: '2025-06-12', end: '2025-09-11' },
  { file: 'NQz5.CME.scid', start: '2025-09-11', end: '2025-12-11' },
  { file: 'NQH6.CME.scid', start: '2025-12-11', end: '2026-03-12' },
  { file: 'NQM6.CME.scid', start: '2026-03-12', end: '2026-05-02' },
]
const K = 4

function bisectRight(arr: number[], x: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid }
  return lo
}

async function main() {
  // 1. Build the stitched 5m close series.
  const times: number[] = []   // epoch seconds, bar open
  const closes: number[] = []
  const seg: number[] = []
  for (let s = 0; s < CONTRACTS.length; s++) {
    const c = CONTRACTS[s]
    const startMs = Date.parse(c.start + 'T00:00:00Z')
    const endMs = Date.parse(c.end + 'T00:00:00Z')
    const { bars, tickCount } = readScidBars(join(DATA, c.file), startMs, endMs, { priceDivisor: 100, bucketMs: 300_000 })
    for (const b of bars) { times.push(Math.floor(Date.parse(b.ts) / 1000)); closes.push(b.close); seg.push(s) }
    console.log(`  ${c.file}: ${bars.length} 5m bars, ${tickCount.toLocaleString()} ticks  (seg ${s})`)
  }
  console.log(`Series: ${closes.length} bars\n`)

  // 2. Pivots + confirmation index.
  const pivots = findPivots(closes, seg, K)
  const confirmIdx = pivots.map(p => p.confirmIdx)
  console.log(`Pivots: ${pivots.length}\n`)

  // 3. Load the 915 historical_trades.
  const { data: trades } = await sb.from('historical_trades')
    .select('open_at, side, net_pnl').order('open_at', { ascending: true })

  // 4. Classify each trade.
  const cat = { follow: { n: 0, pnl: 0 }, fade: { n: 0, pnl: 0 }, neutral: { n: 0, pnl: 0 } }
  const regimeCount: Record<Regime, number> = { bull: 0, bear: 0, neutral: 0, insufficient: 0 }
  let unmatched = 0, noSide = 0
  for (const t of trades) {
    if (!t.side || !t.open_at) { noSide++; continue }
    const ts = Math.floor(Date.parse(t.open_at) / 1000)
    const T = bisectRight(times, ts) - 1
    if (T < 0 || ts - times[T] > 900) { unmatched++; continue }  // >15min from a bar = gap
    const regime = structureAt(pivots, confirmIdx, seg, T)
    regimeCount[regime]++
    const ff = followFade(t.side, regime)
    const pnl = Number(t.net_pnl) || 0
    if (ff === 'follow') { cat.follow.n++; cat.follow.pnl += pnl }
    else if (ff === 'fade') { cat.fade.n++; cat.fade.pnl += pnl }
    else { cat.neutral.n++; cat.neutral.pnl += pnl }
  }

  const fmt = (n: number) => (n >= 0 ? '+' : '') + '$' + Math.round(n).toLocaleString()
  console.log('regime distribution:', JSON.stringify(regimeCount))
  console.log(`unmatched (data gap): ${unmatched} · no side: ${noSide}\n`)
  console.log('CATEGORY      mine        study')
  console.log(`Follow        ${cat.follow.n} / ${fmt(cat.follow.pnl)}     289 / +$13,368`)
  console.log(`Fade          ${cat.fade.n} / ${fmt(cat.fade.pnl)}     253 / +$6,254`)
  console.log(`Neutral       ${cat.neutral.n} / ${fmt(cat.neutral.pnl)}     373 / +$839`)
}
main().catch(e => { console.error(e); process.exit(1) })
