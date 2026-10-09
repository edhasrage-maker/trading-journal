/**
 * Fill the 07:29/07:30 PT IB-CLOSE columns on market_context:
 * `atr_at_ib_close`, `atr_10d_avg`, `rvol_at_ib_close`.
 *
 *   npx tsx scripts/backfill-atr-ib-close.ts                 # dry run (prod)
 *   npx tsx scripts/backfill-atr-ib-close.ts --apply
 *   npx tsx scripts/backfill-atr-ib-close.ts --apply --force # recompute populated ones too
 *   npx tsx scripts/backfill-atr-ib-close.ts --env=local
 *
 * WHY
 * `condition-lookup-refresh` buckets the ATR_730 and RVOL dimensions on the
 * IB-close readings, but nothing ever wrote them for a live day, and
 * backfill-market-context-es.ts writes `atr_1m` while leaving these null even
 * though the stats object it already has carries all three. Result on prod:
 * 98 of 521 rows have no IB-close ATR, and that includes EVERY ES row (43/43).
 *
 * That gap is what pins the ATR_730 bucket. The metric is stored in raw POINTS
 * while the other four are scale-free ratios, so an ES day's ~3.0 is scored
 * against cuts drawn from NQ's ~17.7 and lands in the bottom bucket every
 * single session — the same lookup row matches every ES morning, which is a
 * large part of why Morning Conditions reads "Be selective" no matter what the
 * tape did. Turning ATR_730 into `atr_at_ib_close / atr_10d_avg` makes it
 * scale-free like the rest, and that ratio needs BOTH columns present.
 *
 * WHAT IT TOUCHES
 * Only those three columns, only via UPDATE on an existing row (never an
 * upsert, never an insert — creating rows is backfill-market-context-es.ts's
 * job and it does other things this script must not do). Every other column is
 * left exactly as it is. Without --force, a row is only touched where at least
 * one of the three is null, and a column that already has a value is never
 * overwritten.
 *
 * The values come from contextStatsForDate() — the same engine the prep page
 * and the ES backfill run, so a backfilled day matches a live one.
 */
import { readFileSync } from 'fs'
import { contextStatsForDate } from '../src/lib/market-context-from-bars.ts'
import type { OneMinBar } from '../src/lib/scid-reader.ts'
import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(`--${n}`)
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? null

const APPLY = has('apply')
const FORCE = has('force')
const envName = argVal('env') ?? 'public'
const isProd = envName !== 'local'

for (const line of readFileSync(isProd ? '.env.public-feed' : '.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  (isProd ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  (isProd ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY)!,
  { auth: { persistSession: false } },
)

const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID
const LOOKBACK_DAYS = 22            // matches /api/bars/market-context

const round = (v: number | null | undefined, d = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pageAll<T>(q: () => any): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await q().range(p * 1000, p * 1000 + 999)
    if (error) throw error
    if (!data?.length) break
    out.push(...(data as T[]))
    if (data.length < 1000) break
  }
  return out
}

/** Bars are fetched once per (symbol, date) — a 22-day window is ~30k rows and
 *  several context rows can share a date, so re-reading per row would be slow
 *  for no gain. */
const barCache = new Map<string, OneMinBar[]>()
async function fetchBars(symbol: string, date: string): Promise<OneMinBar[]> {
  const key = `${symbol}|${date}`
  const hit = barCache.get(key)
  if (hit) return hit
  const start = new Date(`${date}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS)
  const rows = await pageAll<OneMinBar & { volume: number | null }>(() => sb.from('ohlcv_bars')
    .select('ts, open, high, low, close, volume')
    .eq('symbol', symbol)
    .gte('ts', start.toISOString())
    .lte('ts', `${date}T23:59:59Z`)
    .order('ts', { ascending: true }))
  // contextStatsForDate wants a non-null volume; the feed's is nullable and the
  // aggregator treats missing volume as 0 anyway.
  const bars = rows.map(b => ({ ...b, volume: b.volume ?? 0 }))
  barCache.set(key, bars)
  return bars
}

interface CtxRow {
  id: string
  trading_day_id: string
  symbol: string | null
  atr_at_ib_close: number | null
  atr_10d_avg: number | null
  rvol_at_ib_close: number | null
}

async function main() {
  console.log(`backfill-atr-ib-close — env ${isProd ? 'public (PROD)' : 'local'} · user ${USER_ID} · ${APPLY ? 'APPLY' : 'DRY RUN'}${FORCE ? ' · FORCE' : ''}\n`)

  const days = await pageAll<{ id: string; date: string }>(() =>
    sb.from('trading_days').select('id, date').eq('user_id', USER_ID))
  const dayDate = new Map(days.map(d => [d.id, d.date]))

  const ctx = await pageAll<CtxRow>(() => sb.from('market_context')
    .select('id, trading_day_id, symbol, atr_at_ib_close, atr_10d_avg, rvol_at_ib_close')
    .eq('user_id', USER_ID))

  const needs = (r: CtxRow) =>
    FORCE || r.atr_at_ib_close == null || r.atr_10d_avg == null || r.rvol_at_ib_close == null
  const targets = ctx.filter(needs).sort((a, b) =>
    (dayDate.get(a.trading_day_id) ?? '').localeCompare(dayDate.get(b.trading_day_id) ?? ''))

  console.log(`${ctx.length} context rows · ${targets.length} missing at least one IB-close column`)
  const bySym: Record<string, number> = {}
  for (const r of targets) bySym[r.symbol ?? 'null'] = (bySym[r.symbol ?? 'null'] ?? 0) + 1
  console.log(`by symbol: ${JSON.stringify(bySym)}\n`)

  const writes: Array<{ date: string; sym: string; id: string; patch: Record<string, number | null> }> = []
  const skipped: Record<string, number> = {}
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1 }

  for (const r of targets) {
    const date = dayDate.get(r.trading_day_id)
    if (!date) { skip('day not owned'); continue }
    const sym = r.symbol
    if (!sym || !/^(NQ|ES)$/.test(sym)) { skip(`unusable symbol (${sym ?? 'null'})`); continue }

    const bars = await fetchBars(sym, date)
    if (bars.length < 300) { skip(`no/short ${sym} bars`); continue }

    const stats = contextStatsForDate(bars, date, 'rth')
    if (!stats?.realized) { skip('session not realized in bars'); continue }

    // Only ever ADD a value. A column that already holds something keeps it,
    // so a re-run can never quietly rewrite history that is already correct.
    const patch: Record<string, number | null> = {}
    if (FORCE || r.atr_at_ib_close == null) {
      const v = round(stats.atr_at_ib_close, 3); if (v != null) patch.atr_at_ib_close = v
    }
    if (FORCE || r.atr_10d_avg == null) {
      const v = round(stats.atr_10d_avg, 3); if (v != null) patch.atr_10d_avg = v
    }
    if (FORCE || r.rvol_at_ib_close == null) {
      const v = round(stats.rvol_at_ib_close, 1); if (v != null) patch.rvol_at_ib_close = v
    }
    if (Object.keys(patch).length === 0) { skip('bars yielded nothing for the missing columns'); continue }

    writes.push({ date, sym, id: r.id, patch })
    const ratio = (patch.atr_at_ib_close ?? r.atr_at_ib_close) != null && (patch.atr_10d_avg ?? r.atr_10d_avg)
      ? ((patch.atr_at_ib_close ?? r.atr_at_ib_close)! / (patch.atr_10d_avg ?? r.atr_10d_avg)!).toFixed(2)
      : '—'
    console.log(`  ${date} ${sym.padEnd(2)}  ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}   → ATR_730 ratio ${ratio}`)
  }

  console.log(`\n→ ${APPLY ? 'writing' : 'would write'} ${writes.length} rows; skipped ${JSON.stringify(skipped)}`)

  if (!APPLY) {
    console.log('\ndry run — nothing written. Re-run with --apply.')
    return
  }
  let ok = 0
  for (const w of writes) {
    const { error } = await sb.from('market_context').update(w.patch).eq('id', w.id)
    if (error) console.error(`  ✗ ${w.date} ${w.sym}: ${error.message}`)
    else ok++
  }
  console.log(`wrote ${ok} of ${writes.length} rows.`)
}

main().catch(e => { console.error(e); process.exit(1) })
