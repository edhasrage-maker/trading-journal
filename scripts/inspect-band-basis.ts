/**
 * READ-ONLY. Answers two questions the ES/NQ market-context work depends on:
 *
 *   1. Does `market_context` carry a symbol at all? (If not, historical rows
 *      can't be split by instrument and the per-symbol schema is a real gap.)
 *   2. Do the condition-verdict band cuts — which were anchored to an NQ
 *      distribution — actually transfer to ES? Every band is a RATIO, so the
 *      test is whether ES's ratio distribution sits where NQ's does. If ES's
 *      median bar-vol ratio is ~0.94 like NQ's, the cuts transfer untouched.
 *
 * Writes nothing. Run: npx tsx scripts/inspect-band-basis.ts
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const sb = createClient(
  process.env.PUBLIC_SUPABASE_URL!,
  process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
)

const USER = 'fa3fb352-9538-44cc-8ce1-1c76f307044c' // edhasrage — scope every read

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}
function describe(label: string, vals: number[]) {
  const s = [...vals].sort((a, b) => a - b)
  if (s.length === 0) { console.log(`  ${label.padEnd(22)} n=0`); return }
  const f = (v: number | null) => (v == null ? '—' : v.toFixed(2))
  console.log(
    `  ${label.padEnd(22)} n=${String(s.length).padEnd(5)}` +
    ` p10=${f(pct(s, 10))}  p30=${f(pct(s, 30))}  p50=${f(pct(s, 50))}  p70=${f(pct(s, 70))}  p90=${f(pct(s, 90))}`,
  )
}

async function main() {
  // ── 1. What columns does market_context actually have? ──────────────────
  const { data: mcSample, error: mcErr } = await sb
    .from('market_context').select('*').eq('user_id', USER).limit(1)
  if (mcErr) { console.error('market_context read failed:', mcErr.message); return }
  const cols = mcSample?.[0] ? Object.keys(mcSample[0]).sort() : []
  console.log('\n── market_context columns ──')
  console.log(' ', cols.join(', ') || '(no rows)')
  console.log('  carries a symbol?  ', cols.some(c => /symbol|instrument|ticker|root/i.test(c)) ? 'YES' : 'NO')

  // ── 2. Bar coverage per symbol — the only per-instrument source we have ──
  const { data: barSyms } = await sb
    .from('ohlcv_bars').select('symbol').limit(5000) as { data: { symbol: string }[] | null }
  const symCount = new Map<string, number>()
  for (const r of barSyms ?? []) symCount.set(r.symbol, (symCount.get(r.symbol) ?? 0) + 1)
  console.log('\n── ohlcv_bars symbols (sample of 5k rows) ──')
  for (const [s, n] of [...symCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(12)} ${n}`)
  }

  // ── 3. The ratios the bands cut on, SPLIT BY SYMBOL ─────────────────────
  // This is the actual test: the cuts were anchored to NQ. If ES's ratio
  // distribution lands in the same place, they transfer untouched; if it's
  // shifted, ES days get systematically mislabelled.
  type Row = {
    symbol: string | null; rvol: number | null; adr: number | null; atr_1m: number | null
    atr_10d_avg: number | null; day_range: number | null
    ib_vs_10d_avg: number | null; onh: number | null; onl: number | null
  }
  const { data: rows, error: rErr } = await sb
    .from('market_context')
    .select('symbol, rvol, adr, atr_1m, atr_10d_avg, day_range, ib_vs_10d_avg, onh, onl')
    .eq('user_id', USER)
    .limit(2000) as { data: Row[] | null; error: unknown }
  if (rErr) { console.error('context read failed:', rErr); return }
  const all = rows ?? []

  const bySym = new Map<string, Row[]>()
  for (const x of all) {
    const k = (x.symbol ?? '(null)').replace(/[HMUZ]\d+$/, '') || '(null)'
    if (!bySym.has(k)) bySym.set(k, [])
    bySym.get(k)!.push(x)
  }
  console.log(`\n── context rows by symbol (n=${all.length}) ──`)
  for (const [s, v] of [...bySym.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${s.padEnd(10)} ${v.length}`)
  }

  for (const [sym, v] of [...bySym.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (v.length < 5) continue
    console.log(`\n── ${sym} — the ratios the bands cut on ──`)
    describe('rvol (%)', v.map(x => x.rvol).filter((n): n is number => n != null))
    describe('barVol atr1m/10dAvg', v.filter(x => x.atr_1m != null && x.atr_10d_avg != null && x.atr_10d_avg > 0).map(x => x.atr_1m! / x.atr_10d_avg!))
    describe('rangeUsed dr/adr %', v.filter(x => x.day_range != null && x.adr != null && x.adr > 0).map(x => (x.day_range! / x.adr!) * 100))
    describe('overnight/adr %', v.filter(x => x.onh != null && x.onl != null && x.adr != null && x.adr > 0).map(x => ((x.onh! - x.onl!) / x.adr!) * 100))
    describe('ib vs 10d avg', v.map(x => x.ib_vs_10d_avg).filter((n): n is number => n != null))
    // Raw levels — confirms the instruments really are different scales.
    describe('RAW atr_1m (pts)', v.map(x => x.atr_1m).filter((n): n is number => n != null))
    describe('RAW adr (pts)', v.map(x => x.adr).filter((n): n is number => n != null))
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })
