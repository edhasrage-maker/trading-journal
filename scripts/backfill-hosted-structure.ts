/**
 * Fill the missing structure_5m_alignment / structure_5m_regime on hosted
 * trades, from the shared bar feed — the SAME computation the hosted import now
 * runs (src/lib/structure-from-bars.ts), so backfilled and newly imported
 * trades can't drift apart.
 *
 * Why: /api/import-trades-csv (the only import on tapescore.app) never set
 * either field, so every trade imported on the hosted site since August has
 * both null.
 *
 * DRY RUN BY DEFAULT — reports what it would fill and writes nothing.
 * Fills nulls only; a stored value is never overwritten.
 *
 *   npx tsx scripts/backfill-hosted-structure.ts             # dry run (prod)
 *   npx tsx scripts/backfill-hosted-structure.ts --validate  # recompute trades that already
 *                                                            # have values; report agreement
 *   npx tsx scripts/backfill-hosted-structure.ts --apply     # write
 *
 *   --from=YYYY-MM-DD  only trades entered on/after this date
 *   --user=<uuid>      scope to a user; defaults to the owner
 *   --env=local        read .env.local (dev DB) instead of .env.public-feed (prod)
 *
 * Run from the repo root (it reads .env.public-feed from the working dir).
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeStructureFromBars, type StructureFields } from '../src/lib/structure-from-bars.ts'
import { todayPT } from '../src/lib/pt-time.ts'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const validate = argv.includes('--validate')
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null
const envName = argVal('env') ?? 'public'
const isProd = envName !== 'local'
const from = argVal('from')

for (const l of readFileSync(isProd ? '.env.public-feed' : '.env.local', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  (isProd ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  (isProd ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY)!,
)

// TENANT SCOPING (mandatory on prod): the service-role key bypasses RLS, so
// every read and write is filtered to one user. The dev project has no user_id.
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped = (q: any) => (isProd ? q.eq('user_id', USER_ID) : q)

interface TradeRow {
  id: string
  entry_time: string | null
  direction: 'long' | 'short' | null
  symbol: string | null
  structure_5m_alignment: string | null
  structure_5m_regime: string | null
}

async function loadTrades(): Promise<TradeRow[]> {
  const PAGE = 1000
  const out: TradeRow[] = []
  for (let p = 0; p < 100; p++) {
    let q = scoped(sb.from('trades').select('id, entry_time, direction, symbol, structure_5m_alignment, structure_5m_regime'))
    q = validate
      ? q.not('structure_5m_alignment', 'is', null).not('structure_5m_regime', 'is', null)
      : q.or('structure_5m_alignment.is.null,structure_5m_regime.is.null')
    if (from) q = q.gte('entry_time', from)
    const { data, error } = await q.order('entry_time', { ascending: true }).order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw new Error(`load trades: ${error.message}`)
    out.push(...(data as TradeRow[]))
    if (data.length < PAGE) break
  }
  return out
}

const month = (t: TradeRow) => (t.entry_time ? todayPT(new Date(t.entry_time)).slice(0, 7) : 'no-entry')
const tally = (xs: (string | null)[]) => {
  const c: Record<string, number> = {}
  for (const x of xs) if (x) c[x] = (c[x] ?? 0) + 1
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '—'
}

async function runValidate(trades: TradeRow[], computed: Map<string, StructureFields>) {
  console.log('Recomputed vs stored (trades that already have both fields):\n')
  console.log('month      trades  regime agrees   alignment agrees')
  const months = [...new Set(trades.map(month))].sort()
  let rOk = 0, aOk = 0
  for (const m of months) {
    const ts = trades.filter(t => month(t) === m)
    const r = ts.filter(t => computed.get(t.id)?.structure_5m_regime === t.structure_5m_regime).length
    const a = ts.filter(t => computed.get(t.id)?.structure_5m_alignment === t.structure_5m_alignment).length
    rOk += r; aOk += a
    console.log(`${m}    ${String(ts.length).padStart(5)}  ${String(r).padStart(6)}/${ts.length}  ${String(a).padStart(9)}/${ts.length}`)
  }
  console.log(`total      ${String(trades.length).padStart(5)}  ${String(rOk).padStart(6)}/${trades.length}  ${String(aOk).padStart(9)}/${trades.length}`)
}

async function main() {
  console.log(`MODE: ${validate ? 'VALIDATE (read-only)' : apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}  db=${isProd ? 'PROD (public)' : 'dev (local)'}${isProd ? `  user=${USER_ID}` : ''}${from ? `  from=${from}` : ''}\n`)

  const trades = await loadTrades()
  console.log(`${trades.length} trade(s) ${validate ? 'with both fields stored' : 'missing one or both fields'}\n`)
  if (trades.length === 0) return

  const computed = await computeStructureFromBars(sb, trades)
  if (validate) return runValidate(trades, computed)

  // Fill nulls only.
  const fills: { id: string; patch: Record<string, string> }[] = []
  for (const t of trades) {
    const c = computed.get(t.id)
    const patch: Record<string, string> = {}
    if (t.structure_5m_alignment == null && c?.structure_5m_alignment) patch.structure_5m_alignment = c.structure_5m_alignment
    if (t.structure_5m_regime == null && c?.structure_5m_regime) patch.structure_5m_regime = c.structure_5m_regime
    if (Object.keys(patch).length) fills.push({ id: t.id, patch })
  }
  const fillById = new Map(fills.map(f => [f.id, f.patch]))

  console.log('month      missing (align / regime)   would fill (align / regime)   left null (align / regime)')
  const months = [...new Set(trades.map(month))].sort()
  const tot = { mA: 0, mR: 0, fA: 0, fR: 0 }
  for (const m of months) {
    const ts = trades.filter(t => month(t) === m)
    const mA = ts.filter(t => t.structure_5m_alignment == null).length
    const mR = ts.filter(t => t.structure_5m_regime == null).length
    const fA = ts.filter(t => fillById.get(t.id)?.structure_5m_alignment).length
    const fR = ts.filter(t => fillById.get(t.id)?.structure_5m_regime).length
    tot.mA += mA; tot.mR += mR; tot.fA += fA; tot.fR += fR
    console.log(`${m}    ${String(mA).padStart(6)} / ${String(mR).padEnd(6)}             ${String(fA).padStart(6)} / ${String(fR).padEnd(6)}                ${String(mA - fA).padStart(5)} / ${mR - fR}`)
  }
  console.log(`total      ${String(tot.mA).padStart(6)} / ${String(tot.mR).padEnd(6)}             ${String(tot.fA).padStart(6)} / ${String(tot.fR).padEnd(6)}                ${String(tot.mA - tot.fA).padStart(5)} / ${tot.mR - tot.fR}`)
  console.log(`\nTrades that would change: ${fills.length}`)
  console.log(`  alignment values: ${tally(fills.map(f => f.patch.structure_5m_alignment ?? null))}`)
  console.log(`  regime values:    ${tally(fills.map(f => f.patch.structure_5m_regime ?? null))}`)

  const leftNull = trades.filter(t => {
    const p = fillById.get(t.id)
    return (t.structure_5m_alignment == null && !p?.structure_5m_alignment) || (t.structure_5m_regime == null && !p?.structure_5m_regime)
  })
  if (leftNull.length) {
    console.log(`\nStill null after the fill (${leftNull.length}) — no bars near the entry, under 20 five-minute bars before it, or no symbol/direction:`)
    for (const t of leftNull.slice(0, 15)) {
      console.log(`  ${t.entry_time}  ${t.symbol ?? '(no symbol)'}  ${t.direction ?? '(no direction)'}  align=${t.structure_5m_alignment ?? fillById.get(t.id)?.structure_5m_alignment ?? 'null'}  regime=${t.structure_5m_regime ?? fillById.get(t.id)?.structure_5m_regime ?? 'null'}`)
    }
    if (leftNull.length > 15) console.log(`  … and ${leftNull.length - 15} more`)
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.')
    return
  }

  let wrote = 0, failed = 0
  for (let i = 0; i < fills.length; i += 50) {
    const res = await Promise.all(fills.slice(i, i + 50).map(f => scoped(sb.from('trades').update(f.patch).eq('id', f.id))))
    for (const r of res) { if (r.error) { failed++; console.error(`  err: ${r.error.message}`) } else wrote++ }
  }
  console.log(`\nWrote ${wrote} trade(s)${failed ? `, ${failed} failed` : ''}.`)
}

main().catch(e => { console.error(e); process.exit(1) })
