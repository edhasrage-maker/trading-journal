/** NOTE: run 2026-10-13 against the lookup as it then was (day_range-based DR/ADR, date-only join in the live
 *  rebuild). deriveMetrics has since moved DR/ADR to the IB-close basis, so a re-run will differ on the range rows.
 *
 *  Hold-out v2: all 2026 trades (historical Jan–Apr + native May–Oct), and where the all-history edge came from. READ-ONLY. */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { deriveMetrics, computeThresholds, buildLookupRows, type MetricRow } from '../src/lib/condition-lookup-refresh.ts'
for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
const sb = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)
const U = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
/* eslint-disable @typescript-eslint/no-explicit-any */
const page = async (q: () => any) => { const out: any[] = []; for (let p = 0; p < 60; p++) { const { data, error } = await q().range(p * 1000, p * 1000 + 999); if (error) throw error; out.push(...(data ?? [])); if ((data ?? []).length < 1000) break } return out }

const days = await page(() => sb.from('trading_days').select('id,date').eq('user_id', U))
const dateById = new Map(days.map((d: any) => [d.id, d.date]))
const ctxAll = (await page(() => sb.from('market_context').select('trading_day_id,symbol,rvol,rvol_at_ib_close,ib_vs_10d_avg,ib_size,adr,day_range,atr_at_ib_close,atr_10d_avg,atr_1m,ib_atr_ratio').eq('user_id', U))).map((c: any) => ({ ...c, date: dateById.get(c.trading_day_id) as string })).filter((c: any) => c.date)
const nat = await page(() => sb.from('trades').select('pnl,entry_time,trading_day_id,symbol,quantity').eq('user_id', U).order('entry_time', { ascending: true }).order('id', { ascending: true }))
const hist = await page(() => sb.from('historical_trades').select('net_pnl,trade_date,open_at,symbol,quantity').eq('user_id', U).order('open_at', { ascending: true }).order('id', { ascending: true }))

const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false })
const ptMin = (iso: string) => { const p: any = {}; for (const x of PT.formatToParts(new Date(iso))) p[x.type] = x.value; return (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute }
const root = (s: string | null) => { const m = /^(MNQ|NQ|MES|ES)/.exec(s ?? ''); return m ? m[1] : null }
const MULT: any = { NQ: 20, MNQ: 2, ES: 50, MES: 5 }
const mk = (src: string, date: string, pnl: number | null, time: string | null, symbol: string | null, qty: number | null) => {
  const r = root(symbol); return { src, date, pnl, r, inst: r ? (r.endsWith('NQ') ? 'NQ' : 'ES') : null, min: time ? ptMin(time) : null, pts: (pnl != null && qty && r) ? pnl / (qty * MULT[r]) : null }
}
const ALL: any[] = [
  ...hist.map((h: any) => mk('hist', h.trade_date, h.net_pnl, h.open_at, h.symbol, h.quantity)),
  ...nat.map((t: any) => mk('native', dateById.get(t.trading_day_id) as string, t.pnl, t.entry_time, t.symbol, t.quantity)),
].filter((t: any) => t.date && t.pnl != null && Number.isFinite(t.pnl))
console.log(`LOADED historical ${hist.length} · native ${nat.length} · usable ${ALL.length} · context rows ${ctxAll.length}`)
const seg = (t: any) => t.date < '2026-01-01' ? '2025 (Jun–Dec)' : t.date < '2026-05-01' ? '2026 Jan–Apr' : t.date < '2026-06-01' ? '2026 May' : t.date < '2026-10-01' ? '2026 Jun–Sep' : '2026 Oct'
const SEGS = ['2025 (Jun–Dec)', '2026 Jan–Apr', '2026 May', '2026 Jun–Sep', '2026 Oct']
const cntBy = (arr: any[], fn: (t: any) => string) => arr.reduce((a: any, t: any) => (a[fn(t)] = (a[fn(t)] ?? 0) + 1, a), {})
console.log(`by segment ${JSON.stringify(cntBy(ALL, seg))}`)
console.log(`by instrument ${JSON.stringify(cntBy(ALL, t => `${t.date < '2026-01-01' ? '2025' : '2026'} ${t.inst}`))} · no symbol ${ALL.filter((t: any) => !t.inst).length}`)
console.log(`2026 entries before 07:30 PT: ${ALL.filter((t: any) => t.date >= '2026-01-01' && t.min != null && t.min < 450).length} of ${ALL.filter((t: any) => t.date >= '2026-01-01').length}`)

// own-instrument context; and the production join (one row per DATE, last one wins)
const ctxKey = new Map<string, any>(); for (const c of ctxAll) ctxKey.set(`${c.date}|${c.symbol}`, c)
const ctxDate = new Map<string, any>(); for (const c of ctxAll) ctxDate.set(c.date, c)
for (const t of ALL) {
  const own = t.inst ? ctxKey.get(`${t.date}|${t.inst}`) : null
  t.m = own ? deriveMetrics(own) : null; t.key = `${t.date}|${t.inst}`
  const any = ctxDate.get(t.date); t.md = any ? deriveMetrics(any) : null; t.crossInst = !!(any && t.inst && any.symbol !== t.inst)
}
const has = (m: any) => m && m.ib != null && m.ib_atr != null
const J = ALL.filter((t: any) => has(t.m))
const Y26 = J.filter((t: any) => t.date >= '2026-01-01')
console.log(`\nJOIN  own-instrument, IB + IB/ATR present: ${J.length}/${ALL.length} · of 2026: ${Y26.length}/${ALL.filter((t: any) => t.date >= '2026-01-01').length} (${new Set(Y26.map((t: any) => t.date)).size} sessions)`)
const un = ALL.filter((t: any) => t.date >= '2026-01-01' && !has(t.m))
console.log(`  2026 trades NOT joinable to their own instrument: ${un.length} — no context row for that instrument ${un.filter((t: any) => !ctxKey.get(t.key)).length}, row exists but IB/ATR missing ${un.filter((t: any) => ctxKey.get(t.key)).length}; by instrument ${JSON.stringify(cntBy(un, t => t.inst))}`)
console.log(`  the live lookup joins by DATE only: ${ALL.filter((t: any) => has(t.md)).length} trades get a row, and ${ALL.filter((t: any) => has(t.md) && t.crossInst).length} of them are scored on the OTHER instrument's conditions`)

const st = (a: any[]) => {
  const p = a.map(t => t.pnl); const w = p.filter(v => v > 0), l = p.filter(v => v < 0); const sw = w.reduce((s, v) => s + v, 0), sl = l.reduce((s, v) => s + v, 0)
  const pts = a.map(t => t.pts).filter((v: any) => v != null)
  return { n: a.length, wr: w.length + l.length ? 100 * w.length / (w.length + l.length) : NaN, pf: sl < 0 ? sw / -sl : NaN, ev: p.length ? p.reduce((s, v) => s + v, 0) / p.length : NaN, pts: pts.length ? pts.reduce((s: number, v: number) => s + v, 0) / pts.length : NaN, days: new Set(a.map(t => t.date)).size }
}
let seed = 12345; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
const diffCI = (A: any[], B: any[]) => {
  const byDay = new Map<string, { a: number[], b: number[] }>()
  for (const t of A) { const d = byDay.get(t.date) ?? { a: [], b: [] }; d.a.push(t.pnl); byDay.set(t.date, d) }
  for (const t of B) { const d = byDay.get(t.date) ?? { a: [], b: [] }; d.b.push(t.pnl); byDay.set(t.date, d) }
  const D = [...byDay.values()], out: number[] = []
  for (let i = 0; i < 3000; i++) { let sa = 0, na = 0, sb2 = 0, nb = 0; for (let k = 0; k < D.length; k++) { const d = D[Math.floor(rnd() * D.length)]; for (const v of d.a) { sa += v; na++ } for (const v of d.b) { sb2 += v; nb++ } } if (na && nb) out.push(sa / na - sb2 / nb) }
  out.sort((x, z) => x - z); const mean = out.reduce((s, v) => s + v, 0) / out.length; const sd = Math.sqrt(out.reduce((s, v) => s + (v - mean) ** 2, 0) / (out.length - 1))
  return { lo: out[Math.floor(.025 * out.length)], hi: out[Math.floor(.975 * out.length)], sd }
}
const f = (v: number, d = 0) => Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '  —'
const line = (lbl: string, A: any[], B: any[]) => {
  const a = st(A), b = st(B); if (a.n < 8 || b.n < 8) { console.log(`  ${lbl.padEnd(26)} IN n=${a.n} · OUT n=${b.n} (too few)`); return }
  const ci = diffCI(A, B), d = a.ev - b.ev
  console.log(`  ${lbl.padEnd(26)} IN  n=${String(a.n).padStart(3)} (${String(a.days).padStart(2)}d) WR ${a.wr.toFixed(0).padStart(2)}% PF ${a.pf.toFixed(2)} EV ${f(a.ev).padStart(5)} pts/ct ${f(a.pts, 1).padStart(5)} | OUT n=${String(b.n).padStart(3)} WR ${b.wr.toFixed(0).padStart(2)}% PF ${b.pf.toFixed(2)} EV ${f(b.ev).padStart(5)} pts/ct ${f(b.pts, 1).padStart(5)} | diff ${f(d).padStart(5)} CI[${f(ci.lo)},${f(ci.hi)}] t=${(d / ci.sd).toFixed(2)}`)
}
const split = (arr: any[], fn: (t: any) => boolean) => [arr.filter(fn), arr.filter(t => !fn(t))] as [any[], any[]]
const prod: any = Object.fromEntries(((await sb.from('condition_thresholds').select('*').eq('user_id', U)).data as any[]).map(t => [t.metric, t]))
const cIB = +prod.IB.median, cIA = +prod.IB_ATR.median, cRV = +prod.RVOL.median

console.log(`\n── A. WHERE THE LIVE "+$59" COMES FROM (live method: date-only join, live cuts IB > ${cIB} · IB/ATR ≤ ${cIA}) ──`)
{
  const P = ALL.filter((t: any) => has(t.md)); const e = (t: any) => t.md.ib > cIB && t.md.ib_atr <= cIA
  const [a, b] = split(P, e); line('ALL (as the live lookup)', a, b)
  for (const s of SEGS) { const x = P.filter((t: any) => seg(t) === s); const [i, o] = split(x, e); line(s, i, o) }
}

console.log(`\n── B. THE EDGE ON 2026 ONLY, each trade scored on its own instrument ──`)
const edge = (ib: number, ia: number) => (t: any) => t.m.ib > ib && t.m.ib_atr <= ia
{
  const b0 = st(Y26); console.log(`  2026 book: n=${b0.n} (${b0.days} sessions) WR ${b0.wr.toFixed(1)}% PF ${b0.pf.toFixed(2)} EV ${f(b0.ev, 1)} pts/ct ${f(b0.pts, 2)}`)
  let [a, b] = split(Y26, edge(cIB, cIA)); line('2026 all', a, b)
  for (const inst of ['NQ', 'ES']) { [a, b] = split(Y26.filter((t: any) => t.inst === inst), edge(cIB, cIA)); line(`2026 ${inst}`, a, b) }
  for (const s of SEGS.slice(1)) { [a, b] = split(Y26.filter((t: any) => seg(t) === s), edge(cIB, cIA)); line(s, a, b) }
}

console.log(`\n── C. CLEAN HOLD-OUT: cuts AND list chosen on Jan–May 2026, scored on Jun–Oct 2026 ──`)
{
  const trainCtx = ctxAll.filter((c: any) => c.date >= '2026-01-01' && c.date < '2026-06-01'); const thArr = computeThresholds(trainCtx.map((c: any) => deriveMetrics(c)))
  const th: any = Object.fromEntries(thArr.map(t => [t.metric, t])); const a0 = +th.IB.median, b0 = +th.IB_ATR.median
  console.log(`  train cuts from ${trainCtx.length} Jan–May context rows: IB > ${a0.toFixed(2)} · IB/ATR ≤ ${b0.toFixed(2)}`)
  const tr = Y26.filter((t: any) => t.date < '2026-06-01'), te = Y26.filter((t: any) => t.date >= '2026-06-01')
  let [a, b] = split(tr, edge(a0, b0)); line('edge · TRAIN Jan–May', a, b);
  [a, b] = split(te, edge(a0, b0)); line('edge · TEST Jun–Oct', a, b)
  // which rows does the list-building rule pick on TRAIN, and what do they do on TEST?
  const keysTr = [...new Set(tr.map((t: any) => t.key))] as string[]; const mTr = new Map<string, MetricRow>(); for (const k of keysTr) mTr.set(k, deriveMetrics(ctxKey.get(k)))
  const rows = buildLookupRows(tr.map((t: any) => ({ date: t.key, pnl: t.pnl })), mTr, thArr) as any[]; const base = rows.find(r => r.specificity === 0)!
  const sel = rows.filter(r => r.specificity > 0 && r.n_trades >= 30 && ((r.ev_ci_lo > base.ev_per_trade) || (r.ev_ci_hi < base.ev_per_trade)))
  console.log(`  rule applied to TRAIN (n=${base.n_trades}, EV ${f(base.ev_per_trade, 1)}): ${sel.length} rows pass. Each one re-measured on TEST:`)
  const COL: any = { RVOL: 'rvol', DR_ADR: 'dr_adr', IB: 'ib', ATR_730: 'atr_730', IB_ATR: 'ib_atr' }; const BK: any = { RVOL: 'rvol_b', DR_ADR: 'dr_adr_b', IB: 'ib_b', ATR_730: 'atr_730_b', IB_ATR: 'ib_atr_b' }
  const inRow = (r: any) => (t: any) => Object.keys(COL).every(k => { const want = r[BK[k]]; if (want === 'ANY') return true; const v = t.m[COL[k]]; if (v == null) return false; const T = th[k]
    return want === 'LOW' ? v <= T.median : want === 'HIGH' ? v > T.median : want === 'L' ? v <= T.tertile_low : want === 'M' ? (v > T.tertile_low && v <= T.tertile_high) : v > T.tertile_high })
  let held = 0
  for (const r of sel.sort((x: any, z: any) => z.ev_per_trade - x.ev_per_trade)) {
    const [i, o] = split(te, inRow(r)); const si = st(i), so = st(o); const dirTrain = Math.sign(r.ev_per_trade - base.ev_per_trade), dirTest = Math.sign(si.ev - so.ev); if (si.n >= 8 && dirTrain === dirTest) held++
    console.log(`     ${r.condition_id.padEnd(22)} TRAIN n=${String(r.n_trades).padStart(3)} EV ${f(r.ev_per_trade).padStart(4)} PF ${r.profit_factor.toFixed(2)}  →  TEST in n=${String(si.n).padStart(3)} EV ${f(si.ev).padStart(4)} PF ${Number.isFinite(si.pf) ? si.pf.toFixed(2) : ' —'}  vs out n=${so.n} EV ${f(so.ev)} PF ${so.pf.toFixed(2)}  ${si.n < 8 ? '(too few)' : dirTrain === dirTest ? 'same side' : 'FLIPPED'}`)
  }
  console.log(`  → ${held} of ${sel.length} kept their side out of sample`)
}

console.log(`\n── D. OPENING-RANGE SIZE ALONE, by period (2026, own instrument) ──`)
{ let [a, b] = split(Y26, (t: any) => t.m.ib > cIB); line('larger OR · 2026 all', a, b); for (const s of SEGS.slice(1)) { [a, b] = split(Y26.filter((t: any) => seg(t) === s), (t: any) => t.m.ib > cIB); line(`larger OR · ${s.slice(5)}`, a, b) } }

console.log(`\n── E. DOES THE LIST-BUILDING RULE FIND MORE IN REAL DATA THAN IN SHUFFLED DATA? (2026) ──`)
{
  const keys = [...new Set(Y26.map((t: any) => t.key))] as string[]; const mAll = new Map<string, MetricRow>(); for (const k of keys) mAll.set(k, deriveMetrics(ctxKey.get(k)))
  const thArr = computeThresholds(ctxAll.filter((c: any) => c.date >= '2026-01-01').map((c: any) => deriveMetrics(c)))
  const tIB = thArr.find(x => x.metric === 'IB')!.median, tIA = thArr.find(x => x.metric === 'IB_ATR')!.median
  const run = (tl: any[], m: Map<string, MetricRow>, floor: number) => {
    const rows = buildLookupRows(tl, m, thArr) as any[]; const base = rows.find(r => r.specificity === 0)!
    const sel = rows.filter(r => r.specificity > 0 && r.n_trades >= floor && ((r.ev_ci_lo > base.ev_per_trade) || (r.ev_ci_hi < base.ev_per_trade)))
    const pos = sel.filter(r => r.ev_ci_lo > base.ev_per_trade)
    return { n: sel.length, nPos: pos.length, edgeSel: !!pos.find(r => r.condition_id === 'ANY_ANY_HIGH_ANY_LOW'), sel, base }
  }
  const tlReal = Y26.map((t: any) => ({ date: t.key, pnl: t.pnl })); const vals = keys.map(k => mAll.get(k)!); const N = 400
  for (const floor of [30, 100]) {
    const real = run(tlReal, mAll, floor); const cnt: number[] = []; let anyPos = 0; const pw: any = { 41: 0, 80: 0 }
    for (let i = 0; i < N; i++) {
      const sh = [...vals]; for (let j = sh.length - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1));[sh[j], sh[k]] = [sh[k], sh[j]] }
      const pm = new Map<string, MetricRow>(); keys.forEach((k, ix) => pm.set(k, sh[ix]))
      const r = run(tlReal, pm, floor); cnt.push(r.n); if (r.nPos > 0) anyPos++
      for (const eff of [41, 80]) { const tl = Y26.map((t: any) => { const m = pm.get(t.key)!; const inCell = m.ib != null && m.ib_atr != null && m.ib > tIB && m.ib_atr <= tIA; return { date: t.key, pnl: t.pnl + (inCell ? eff : 0) } }); if (run(tl, pm, floor).edgeSel) pw[eff]++ }
    }
    const q = (a: number[], p: number) => [...a].sort((x, z) => x - z)[Math.floor(p * a.length)]
    console.log(`  floor ${String(floor).padStart(3)} trades: REAL rows passing ${real.n} (${real.nPos} above avg)  |  SHUFFLED median ${q(cnt, .5)}, 5th–95th pct ${q(cnt, .05)}–${q(cnt, .95)}, with ≥1 positive row ${(100 * anyPos / N).toFixed(0)}%  |  share of shuffles finding at least as many rows as real: ${(100 * cnt.filter(v => v >= real.n).length / N).toFixed(0)}%`)
    console.log(`            power — a TRUE edge planted in the range+chop cell is found: +$41/trade ${(100 * pw[41] / N).toFixed(0)}% of the time, +$80/trade ${(100 * pw[80] / N).toFixed(0)}%`)
    if (floor === 30) for (const r of real.sel.sort((x: any, z: any) => z.ev_per_trade - x.ev_per_trade)) console.log(`       ${r.condition_id.padEnd(22)} n=${r.n_trades} EV ${f(r.ev_per_trade)} CI[${f(r.ev_ci_lo)},${f(r.ev_ci_hi)}] PF ${r.profit_factor.toFixed(2)}`)
  }
}
