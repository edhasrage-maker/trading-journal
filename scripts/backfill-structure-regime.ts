/**
 * Backfill structure_5m_regime on trades + historical_trades (Phase 2 of the
 * follow/fade port). Builds a continuous NQ front-month 5m series from .scid
 * across the full trade history, runs the pivot market-structure, and writes
 * each trade's regime (bull/bear/neutral/insufficient).
 *
 * Requires the 20260620_structure_5m_regime migration. Idempotent — only writes
 * when the stored value differs. The .scid read is large (~all front-month
 * history), so this is a multi-minute run; launch in the background.
 *
 *   npx tsx scripts/backfill-structure-regime.ts            # dry run
 *   npx tsx scripts/backfill-structure-regime.ts --commit   # write
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'
import { findPivots, structureAt, type Regime } from '../src/lib/market-structure.ts'

for (const l of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const commit = process.argv.includes('--commit')
const DATA = 'D:\\SierraCharts\\Data'
const K = 4

// NQ front-month: roll = 8 days before the quarterly 3rd-Friday expiry. Each
// contract is front-month in [prevRoll, thisRoll). Index price, so NQ stands in
// for MNQ trades too. Same table as scripts/detect-tz-shift.ts.
const CONTRACTS = [
  { roll: '2023-03-09', file: 'NQH3.CME.scid' },
  { roll: '2023-06-08', file: 'NQM3.CME.scid' },
  { roll: '2023-09-07', file: 'NQU3.CME.scid' },
  { roll: '2023-12-07', file: 'NQZ3.CME.scid' },
  { roll: '2024-03-07', file: 'NQH4.CME.scid' },
  { roll: '2024-06-13', file: 'NQM4.CME.scid' },
  { roll: '2024-09-12', file: 'NQU4.CME.scid' },
  { roll: '2024-12-12', file: 'NQZ4.CME.scid' },
  { roll: '2025-03-13', file: 'NQH5.CME.scid' },
  { roll: '2025-06-12', file: 'NQM5.CME.scid' },
  { roll: '2025-09-11', file: 'NQU5.CME.scid' },
  { roll: '2025-12-11', file: 'NQz5.CME.scid' },
  { roll: '2026-03-12', file: 'NQH6.CME.scid' },
  { roll: '2026-06-11', file: 'NQM6.CME.scid' },
  { roll: '2026-09-11', file: 'NQU6.CME.scid' },
]

function bisectRight(arr: number[], x: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid }
  return lo
}

async function loadAll(table: string, cols: string) {
  const PAGE = 1000; const out: any[] = []  // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 50; p++) {
    const { data } = await sb.from(table).select(cols).order(cols.split(',')[1].trim(), { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || !data.length) break
    out.push(...data); if (data.length < PAGE) break
  }
  return out
}

async function main() {
  console.log(commit ? 'MODE: COMMIT\n' : 'MODE: DRY RUN\n')

  // Range: earliest trade across both tables → now.
  const { data: t0 } = await sb.from('trades').select('entry_time').order('entry_time', { ascending: true }).limit(1)
  const { data: h0 } = await sb.from('historical_trades').select('open_at').order('open_at', { ascending: true }).limit(1)
  const starts = [t0?.[0]?.entry_time, h0?.[0]?.open_at].filter(Boolean).map((s: string) => s.slice(0, 10))
  const rangeStart = starts.sort()[0] ?? '2023-05-01'
  const rangeEnd = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  console.log(`Range: ${rangeStart} → ${rangeEnd}\n`)

  // Build the continuous front-month series (full window per contract for pivot
  // warmup; clipped only at the far end so we don't read the future).
  const times: number[] = [], closes: number[] = [], seg: number[] = []
  let segId = 0
  for (let i = 0; i < CONTRACTS.length; i++) {
    const winStart = i === 0 ? '2000-01-01' : CONTRACTS[i - 1].roll
    const winEnd = CONTRACTS[i].roll
    if (winEnd <= rangeStart) continue       // entirely before any trade
    if (winStart >= rangeEnd) break          // entirely after the last trade
    const readEnd = winEnd < rangeEnd ? winEnd : rangeEnd
    const { bars } = readScidBars(join(DATA, CONTRACTS[i].file), Date.parse(winStart + 'T00:00:00Z'), Date.parse(readEnd + 'T00:00:00Z'), { priceDivisor: 100, bucketMs: 300_000 })
    for (const b of bars) { times.push(Math.floor(Date.parse(b.ts) / 1000)); closes.push(b.close); seg.push(segId) }
    segId++
    console.log(`  ${CONTRACTS[i].file}: ${bars.length} 5m bars`)
  }
  console.log(`Series: ${closes.length} bars`)
  const pivots = findPivots(closes, seg, K)
  const confirmIdx = pivots.map(p => p.confirmIdx)
  console.log(`Pivots: ${pivots.length}\n`)

  // Tag both tables.
  for (const [table, tsCol] of [['trades', 'entry_time'], ['historical_trades', 'open_at']] as const) {
    const rows = await loadAll(table, `id, ${tsCol}, structure_5m_regime`)
    const counts: Record<string, number> = { bull: 0, bear: 0, neutral: 0, insufficient: 0, unmatched: 0 }
    const updates: { id: string; regime: Regime }[] = []
    for (const r of rows) {
      if (!r[tsCol]) continue
      const ts = Math.floor(Date.parse(r[tsCol]) / 1000)
      const T = bisectRight(times, ts) - 1
      if (T < 0 || ts - times[T] > 900) { counts.unmatched++; continue }
      const regime = structureAt(pivots, confirmIdx, seg, T)
      counts[regime]++
      if (r.structure_5m_regime !== regime) updates.push({ id: r.id, regime })
    }
    console.log(`${table}: ${JSON.stringify(counts)} · changed=${updates.length}`)
    if (commit && updates.length) {
      const BATCH = 200; let wrote = 0
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH)
        const res = await Promise.all(batch.map(u => sb.from(table).update({ structure_5m_regime: u.regime }).eq('id', u.id)))
        for (const x of res) { if (x.error) console.error(`  err: ${x.error.message}`); else wrote++ }
      }
      console.log(`  ${table}: wrote ${wrote}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
