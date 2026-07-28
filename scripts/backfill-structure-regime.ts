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
 *   npx tsx scripts/backfill-structure-regime.ts            # dry run (prod)
 *   npx tsx scripts/backfill-structure-regime.ts --commit   # write
 *
 *   --env=local      read .env.local (dev DB) instead of .env.public-feed (prod)
 *   --user=<uuid>    scope to a user; defaults to the owner
 *
 * TARGETS PROD BY DEFAULT. This used to read .env.local, so it only ever moved
 * the dev database — and its reads/writes were unscoped, which on the
 * multi-tenant public project would have recomputed OTHER users' trades from
 * this machine's .scid files.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { readScidBars } from '../src/lib/scid-reader.ts'
import { findPivots, structureAt, type Regime } from '../src/lib/market-structure.ts'
import { contractsForRoot } from '../src/lib/futures-contracts.ts'

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const envName = argVal('env') ?? 'public'
const isProd = envName !== 'local'

// LIVE-FIRST: .env.public-feed points at prod; .env.local is the dev project.
for (const l of readFileSync(isProd ? '.env.public-feed' : '.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  (isProd ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  (isProd ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY)!,
)

// TENANT SCOPING (mandatory on prod). The service-role key BYPASSES RLS, so an
// unscoped query reads and writes across EVERY user's rows. The dev project runs
// the single-user schema and has no user_id column, so scoping applies only to
// prod.
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped = (q: any) => (isProd ? q.eq('user_id', USER_ID) : q)

const DATA = 'D:\\SierraCharts\\Data'
const K = 4

// NQ front-month roll table — now shared (src/lib/futures-contracts.ts) rather
// than copied here, so this script, nq-front-month and the bar feed can't drift.
const CONTRACTS = contractsForRoot('NQ', DATA)

function bisectRight(arr: number[], x: number): number {
  let lo = 0, hi = arr.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid }
  return lo
}

async function loadAll(table: string, cols: string) {
  const PAGE = 1000; const out: any[] = []  // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 50; p++) {
    const { data } = await scoped(sb.from(table).select(cols)).order(cols.split(',')[1].trim(), { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || !data.length) break
    out.push(...data); if (data.length < PAGE) break
  }
  return out
}

async function main() {
  console.log(`MODE: ${commit ? 'COMMIT' : 'DRY RUN'}  db=${isProd ? 'PROD (public)' : 'dev (local)'}${isProd ? `  user=${USER_ID}` : ''}\n`)

  // Range: earliest trade across both tables → now.
  const { data: t0 } = await scoped(sb.from('trades').select('entry_time')).order('entry_time', { ascending: true }).limit(1)
  const { data: h0 } = await scoped(sb.from('historical_trades').select('open_at')).order('open_at', { ascending: true }).limit(1)
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
        // Scoped on the write too, not just the read.
        const res = await Promise.all(batch.map(u => scoped(sb.from(table).update({ structure_5m_regime: u.regime }).eq('id', u.id))))
        for (const x of res) { if (x.error) console.error(`  err: ${x.error.message}`); else wrote++ }
      }
      console.log(`  ${table}: wrote ${wrote}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
