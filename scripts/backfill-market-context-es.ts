/**
 * Give ES-traded days their own market_context row, and repair the rows whose
 * `symbol` is parse garbage.
 *
 *   npx tsx scripts/backfill-market-context-es.ts                # dry run (prod)
 *   npx tsx scripts/backfill-market-context-es.ts --apply
 *   npx tsx scripts/backfill-market-context-es.ts --apply --force  # recompute existing ES rows too
 *   npx tsx scripts/backfill-market-context-es.ts --env=local
 *
 * Found by the screenshot-coach harness (docs/screenshot-coach-rubric.md §5):
 * on 20 of the owner's 154 screenshot trades no usable reference level exists,
 * because the day's ONLY context row is NQ while the trade was MES (levels
 * ~22,000 points away, dropped by a scale guard), or because the row's symbol
 * is "5" / "Trade" / "S@30805.00" — the extraction path's leftovers. Whole
 * table: 455 NQ, 10 ES, 18 garbage. Every downstream consumer keyed on
 * (trading_day_id, symbol) inherits the gap.
 *
 * STEP 1 — ES rows. For every owner trading day with an ES/MES trade and no
 * populated ES context row: read ES 1-minute bars from the shared ohlcv_bars
 * feed (22-day lookback for the trailing-10 baselines), run the SAME two
 * engines the prep page runs — computeSessionLevels() for PDH/PDL/ON/IB and
 * contextStatsForDate() for RVOL/ADR/ATR/IB-size, plus classifyIbDayType()
 * for the IB character — and upsert on (trading_day_id, symbol='ES'). Nothing
 * is reimplemented here; a second implementation would drift from the live one.
 *
 * STEP 2 — garbage symbols. A row whose symbol isn't NQ or ES gets its
 * instrument INFERRED from its own level values against that day's NQ and ES
 * bar prices (a PDH within 5% of the day's NQ close is an NQ row). Then:
 *   - no clean row for (day, instrument)  → relabel the symbol in place
 *   - clean row exists but has NULL levels → copy the garbage row's levels into
 *                                            the clean row, delete the garbage row
 *   - clean row exists and is populated    → delete the garbage row (duplicate)
 *   - instrument can't be inferred         → leave it, report it
 *
 * Owner-scoped by default (the prod DB is multi-tenant). user_id is written
 * explicitly: the site relies on auth.uid() as the column default, and a
 * service-role client has no auth.uid().
 *
 * Not written: rvol_flag / adr_flag / atr_flag (UI thresholds the prep page
 * derives at render), stat_performance_json, gbx_* (needs the GBX read).
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeSessionLevels, type RawBar } from '../src/lib/session-levels.ts'
import { contextStatsForDate } from '../src/lib/market-context-from-bars.ts'
import { classifyIbDayType, ibDayTypeColumns } from '../src/lib/ib-day-type.ts'
import { chartSeriesRoot } from '../src/lib/futures-symbols.ts'

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
const CLEAN = new Set(['NQ', 'ES'])

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

async function fetchBars(symbol: string, date: string): Promise<RawBar[]> {
  const start = new Date(`${date}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - LOOKBACK_DAYS)
  const end = new Date(`${date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1)
  return pageAll<RawBar>(() => sb.from('ohlcv_bars')
    .select('ts, open, high, low, close, volume')
    .eq('symbol', symbol)
    .gte('ts', start.toISOString()).lte('ts', end.toISOString().slice(0, 10) + 'T23:59:59Z')
    .order('ts', { ascending: true }))
}

/** Median close on the PT date, for the scale test in step 2. */
async function dayCloseMedian(symbol: string, date: string): Promise<number | null> {
  const { data } = await sb.from('ohlcv_bars').select('close').eq('symbol', symbol)
    .gte('ts', `${date}T13:00:00Z`).lte('ts', `${date}T21:00:00Z`).limit(500)
  const c = ((data ?? []) as { close: number }[]).map(r => r.close).sort((a, b) => a - b)
  return c.length ? c[Math.floor(c.length / 2)] : null
}

interface CtxRow {
  id: string; trading_day_id: string; symbol: string | null
  pdh: number | null; pdl: number | null; ibh: number | null; ibl: number | null
  onh: number | null; onl: number | null; adr: number | null; atr_1m: number | null; rvol: number | null
}

async function main() {
  console.log(`db=${isProd ? 'PROD (public)' : 'dev (local)'}  user=${USER_ID}  mode=${APPLY ? 'APPLY' : 'dry run'}${FORCE ? ' --force' : ''}\n`)

  const days = await pageAll<{ id: string; date: string }>(() =>
    sb.from('trading_days').select('id, date').eq('user_id', USER_ID))
  const dayDate = new Map(days.map(d => [d.id, d.date]))

  const trades = await pageAll<{ trading_day_id: string; symbol: string | null }>(() =>
    sb.from('trades').select('trading_day_id, symbol').eq('user_id', USER_ID).not('symbol', 'is', null))
  const esDays = new Set(trades.filter(t => t.symbol && chartSeriesRoot(t.symbol) === 'ES').map(t => t.trading_day_id))

  // Filter on user_id, not `.in(dayIds)` — hundreds of uuids in a GET query
  // string is a 400. Belt-and-braces: keep only rows whose day we know.
  const ctx = (await pageAll<CtxRow>(() =>
    sb.from('market_context')
      .select('id, trading_day_id, symbol, pdh, pdl, ibh, ibl, onh, onl, adr, atr_1m, rvol')
      .eq('user_id', USER_ID))).filter(c => dayDate.has(c.trading_day_id))
  const ctxBy = new Map<string, CtxRow>()   // `${day}|${symbol}` for clean rows
  const garbage: CtxRow[] = []
  for (const c of ctx) {
    if (c.symbol && CLEAN.has(c.symbol)) ctxBy.set(`${c.trading_day_id}|${c.symbol}`, c)
    else garbage.push(c)
  }
  const populated = (c: CtxRow | undefined) => !!c && (c.pdh != null || c.ibh != null || c.onh != null)

  console.log(`owner trading days ${days.length} · ES-traded days ${esDays.size} · context rows ${ctx.length} (garbage ${garbage.length})\n`)

  // ── STEP 1: ES rows ─────────────────────────────────────────────────────
  console.log('STEP 1 — ES context rows')
  const esWrites: Array<{ date: string; row: Record<string, unknown> }> = []
  const esSkipped: Record<string, number> = {}
  const skip = (why: string) => { esSkipped[why] = (esSkipped[why] ?? 0) + 1 }

  for (const dayId of Array.from(esDays).sort((a, b) => (dayDate.get(a)! < dayDate.get(b)! ? -1 : 1))) {
    const date = dayDate.get(dayId)!
    if (!FORCE && populated(ctxBy.get(`${dayId}|ES`))) { skip('already populated'); continue }

    const bars = await fetchBars('ES', date)
    if (bars.length < 300) { skip('no/short ES bars'); continue }

    const { levels } = computeSessionLevels(bars, date)
    // contextStatsForDate wants OneMinBar (volume: number); the feed's volume
    // is nullable. Null volume → 0, which is what the aggregator does anyway.
    const stats = contextStatsForDate(bars.map(b => ({ ...b, volume: b.volume ?? 0 })), date, 'rth')
    if (!stats?.realized) { skip('session not realized in bars'); continue }

    const ibType = classifyIbDayType({
      session: 'rth', ibRange: stats.ib_size, atrMeanHL10: stats.meanHL10,
      atrWilder10: null, ibVs10dAvg: stats.ib_vs_10d_avg,
    })
    const ibCols = ibDayTypeColumns(ibType, stats.meanHL10)

    const row = {
      trading_day_id: dayId,
      user_id: USER_ID,
      symbol: 'ES',
      pdh: round(levels.pdh), pdl: round(levels.pdl),
      ibh: round(levels.ibh), ibl: round(levels.ibl),
      onh: round(levels.onh), onl: round(levels.onl),
      rvol: round(stats.rvol, 1),
      ib_size: round(stats.ib_size),
      ib_10d_avg: stats.ib_size != null && stats.ib_vs_10d_avg ? round(stats.ib_size / stats.ib_vs_10d_avg) : null,
      ib_vs_10d_avg: round(stats.ib_vs_10d_avg, 3),
      adr: round(stats.adr),
      day_range: round(stats.day_range),
      atr_1m: round(stats.atr_1m),
      ib_meanhl10: ibCols ? round(ibCols.ib_meanhl10, 3) : null,
      ib_atr_ratio: ibCols ? round(ibCols.ib_atr_ratio, 3) : null,
      ib_regime: ibCols?.ib_regime ?? null,
      ib_size_band: ibCols?.ib_size_band ?? null,
    }
    esWrites.push({ date, row })
    console.log(`  ${date}  PDH ${row.pdh} PDL ${row.pdl}  IB ${row.ibl}–${row.ibh}  ON ${row.onl}–${row.onh}  ADR ${row.adr} ATR ${row.atr_1m} RVOL ${row.rvol}  ${row.ib_regime ?? '—'}/${row.ib_size_band ?? '—'}`)
  }
  console.log(`  → ${APPLY ? 'writing' : 'would write'} ${esWrites.length} ES rows; skipped ${JSON.stringify(esSkipped)}\n`)

  if (APPLY && esWrites.length) {
    for (const w of esWrites) {
      const { error } = await sb.from('market_context').upsert(w.row, { onConflict: 'trading_day_id,symbol' })
      if (error) console.error(`  ✗ ${w.date}: ${error.message}`)
    }
  }

  // ── STEP 2: garbage symbols ─────────────────────────────────────────────
  console.log('STEP 2 — garbage-symbol rows')
  const actions: Array<{ kind: 'relabel' | 'merge' | 'delete' | 'leave'; row: CtxRow; date: string; inst: string | null; why: string }> = []
  for (const g of garbage) {
    const date = dayDate.get(g.trading_day_id) ?? '?'
    const probe = g.pdh ?? g.ibh ?? g.onh ?? g.pdl ?? g.ibl ?? g.onl
    let inst: string | null = null
    if (probe != null) {
      for (const cand of ['NQ', 'ES']) {
        const med = await dayCloseMedian(cand, date)
        if (med && Math.abs(probe - med) / med < 0.05) { inst = cand; break }
      }
    }
    if (!inst) { actions.push({ kind: 'leave', row: g, date, inst, why: probe == null ? 'no level values' : `probe ${probe} matches neither NQ nor ES` }); continue }
    const clean = ctxBy.get(`${g.trading_day_id}|${inst}`)
    if (!clean) actions.push({ kind: 'relabel', row: g, date, inst, why: `no ${inst} row for the day` })
    else if (!populated(clean)) actions.push({ kind: 'merge', row: g, date, inst, why: `${inst} row exists but has null levels` })
    else actions.push({ kind: 'delete', row: g, date, inst, why: `${inst} row already populated (pdh ${clean.pdh})` })
  }
  for (const a of actions) {
    console.log(`  ${a.date}  symbol=${JSON.stringify(a.row.symbol).padEnd(16)} pdh=${String(a.row.pdh).padEnd(9)} → ${a.kind.toUpperCase().padEnd(7)} ${a.inst ?? ''}  (${a.why})`)
  }
  const tally = actions.reduce((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {} as Record<string, number>)
  console.log(`  → ${APPLY ? 'applying' : 'would apply'} ${JSON.stringify(tally)}\n`)

  if (APPLY) {
    for (const a of actions) {
      if (a.kind === 'relabel') {
        const { error } = await sb.from('market_context').update({ symbol: a.inst }).eq('id', a.row.id)
        if (error) console.error(`  ✗ relabel ${a.date}: ${error.message}`)
      } else if (a.kind === 'merge') {
        const clean = ctxBy.get(`${a.row.trading_day_id}|${a.inst}`)!
        const patch = { pdh: a.row.pdh, pdl: a.row.pdl, ibh: a.row.ibh, ibl: a.row.ibl, onh: a.row.onh, onl: a.row.onl,
          adr: clean.adr ?? a.row.adr, atr_1m: clean.atr_1m ?? a.row.atr_1m, rvol: clean.rvol ?? a.row.rvol }
        const { error: e1 } = await sb.from('market_context').update(patch).eq('id', clean.id)
        const { error: e2 } = e1 ? { error: null } : await sb.from('market_context').delete().eq('id', a.row.id)
        if (e1 || e2) console.error(`  ✗ merge ${a.date}: ${(e1 ?? e2)!.message}`)
      } else if (a.kind === 'delete') {
        const { error } = await sb.from('market_context').delete().eq('id', a.row.id)
        if (error) console.error(`  ✗ delete ${a.date}: ${error.message}`)
      }
    }
  }

  // Garbage rows OUTSIDE the owner's days — counted so the scope is explicit.
  const { count } = await sb.from('market_context').select('id', { count: 'exact', head: true })
    .not('symbol', 'in', '("NQ","ES")')
  console.log(`garbage rows across ALL users (before this run): ${count} · owner-scoped handled here: ${garbage.length}`)
  if (!APPLY) console.log('\nRe-run with --apply to write.')
}

main().catch(e => { console.error(e); process.exit(1) })
