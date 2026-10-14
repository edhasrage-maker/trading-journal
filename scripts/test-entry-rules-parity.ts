/**
 * Entry rules — parity with the research, no look-ahead, and the write rules.
 *
 *   npx tsx scripts/test-entry-rules-parity.ts <fixture.json>            # parity + look-ahead (local .scid)
 *   npx tsx scripts/test-entry-rules-parity.ts <fixture.json> --hosted   # also: hosted tape vs local .scid
 *
 * THE FIXTURE is the research's own per-trade flags, exported from
 * NQ_backtest/delta_bars/entries_2026-09-30/o10_trades.pkl by
 * scripts/export-entry-rules-fixture.py (705 NQ trades, 2026; the file that
 * reproduces every count in COACH_ENTRY_RULES_2026.md). For each trade this
 * builds the snapshot the site stores (src/lib/orderflow/entry-context.ts) from
 * the local Sierra .scid ticks and judges the founder's seven rules
 * (src/lib/entry-rules.ts) with it, then compares rule by rule:
 *
 *   L1 run_against < 3     L2 |dom60| < 2      L3 run_against == 0
 *   L4 not rg_fade         F3 not r3_spike     F5 not (dom60 × side ≤ −2)
 *   F6 not (ha_run ≥ 2)
 *
 * and prints trades / win rate / PF for pass and fail next to the research's.
 *
 * NO LOOK-AHEAD: for a sample of trades every trade printed at or after the
 * fill is replaced (prices moved, volumes inflated, bid/ask swapped) and extra
 * trades are appended; the snapshot must not change by a single byte.
 *
 * --hosted reads the founder's trades since Sep 25 2026 from the PUBLIC
 * project (read only, service key from .env.public-feed) and checks that the
 * hosted tick tape and the local .scid give the same snapshot.
 */
import { readFileSync, existsSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { scidFlowSource, tapeFlowSource, FlowScoreLoader, type FlowHourSource } from '../src/lib/orderflow/server/flow-score-loader.ts'
import { supabaseTapeStore } from '../src/lib/orderflow/server/tape-store.ts'
import { ptHours } from '../src/lib/orderflow/server/tick-source.ts'
import { concatFlowTicks, emptyFlowTicks, US_MIN, type FlowTicks } from '../src/lib/orderflow/flow-score.ts'
import { readEntryContext } from '../src/lib/orderflow/entry-context.ts'
import { ptMidnight, PT_HOUR_MS } from '../src/lib/orderflow/pt-clock.ts'
import { evaluateRules, FOUNDER_ENTRY_RULES, type EntryRuleConfig } from '../src/lib/entry-rules.ts'
import type { TradeEntryCtx, TradeReview } from '../src/lib/supabase/types.ts'
import { readEntryContexts } from '../src/lib/orderflow/server/entry-context-run.ts'
import type { FlowTradeRecord, FlowTradeStore } from '../src/lib/orderflow/server/flow-score-run.ts'
import { entryCtxIsCurrent } from '../src/lib/orderflow/flow-score-meta.ts'
import { ptOffsetMs } from '../src/lib/orderflow/pt-clock.ts'

interface Fx {
  i: number; pt: string; sgn: 1 | -1; px: number; pnl: number; src: string
  run_against: number | null; ha_run: number | null; dom60: number | null
  L1: boolean | null; L2: boolean | null; L3: boolean | null; L4: boolean | null; F3: boolean | null; F5: boolean | null; F6: boolean | null
}
const RULE_KEYS = ['L1', 'L2', 'L3', 'L4', 'F3', 'F5', 'F6'] as const
const RULES: EntryRuleConfig[] = FOUNDER_ENTRY_RULES.map(r => ({ ...r, from: '1970-01-01' }))

/** "2026-01-02 08:55:30.000000" (PT wall clock) → PT µs. */
function ptUs(pt: string): number {
  const m = pt.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?$/)
  if (!m) throw new Error(`bad time ${pt}`)
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  return ms * 1000 + (m[7] ? Number(m[7].slice(0, 6).padEnd(6, '0')) : 0)
}

/** The session's ticks from 15:00 PT the day before through PT hour `throughHour` (what the loader reads). */
async function sessionTicks(src: FlowHourSource, date: string, throughHour: number): Promise<FlowTicks> {
  const day0 = ptMidnight(date)
  const parts: FlowTicks[] = []
  for (const h of ptHours(day0 - 9 * PT_HOUR_MS, day0 + (throughHour + 1) * PT_HOUR_MS)) {
    const t = await src.hour('NQ', h.ptDate, h.hour)
    if (t) parts.push(t)
  }
  return parts.length ? concatFlowTicks(parts) : emptyFlowTicks()
}

function stats(pnls: number[]) {
  const n = pnls.length
  let w = 0, l = 0, wins = 0
  for (const p of pnls) { if (p > 0) { w += p; wins++ } else l -= p }
  return `${String(n).padStart(3)} / ${(n ? (100 * wins) / n : 0).toFixed(1).padStart(4)}% / ${(l ? w / l : 0).toFixed(2)}`
}

/** run_against / ha_run as the research counted them, from the snapshot (for the mismatch report). */
function runs(ctx: TradeEntryCtx, s: number) {
  let ra = 0
  for (let i = ctx.bars.length - 1; i >= 0 && s * (ctx.bars[i].c - ctx.bars[i].o) < 0 && ra < 6; i--) ra++
  const last = ctx.bars[ctx.bars.length - 1]
  let k = 0
  for (let i = ctx.bars.length - 1; i >= 0 && ctx.bars[i].ha === last.ha; i--) k++
  return { ra, ha: last.ha === s ? k : -k }
}

async function main() {
  const fxPath = process.argv[2]
  if (!fxPath || !existsSync(fxPath)) { console.error('usage: test-entry-rules-parity.ts <fixture.json> [--hosted]'); process.exit(2) }
  const fx = JSON.parse(readFileSync(fxPath, 'utf8')) as Fx[]
  const src = scidFlowSource()

  // ── parity, trade by trade ──
  const byDate = new Map<string, Fx[]>()
  for (const r of fx) { const d = r.pt.slice(0, 10); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d)!.push(r) }
  const ours = new Map<number, Record<string, 'pass' | 'fail' | 'unknown'>>()
  const ctxs = new Map<number, TradeEntryCtx>()
  const tapeDiff: number[] = []
  const mism: Record<string, string[]> = Object.fromEntries(RULE_KEYS.map(k => [k, []]))
  let dates = 0
  const sample: { r: Fx; ticks: FlowTicks; e: number }[] = []
  for (const [date, rows] of [...byDate.entries()].sort()) {
    const lastHour = Math.max(...rows.map(r => Number(r.pt.slice(11, 13))))
    const ticks = await sessionTicks(src, date, lastHour)
    dates++
    for (const r of rows) {
      const e = ptUs(r.pt)
      const read = readEntryContext(ticks, e)
      const ctx: TradeEntryCtx = { v: 'test', src: '', at: '', ...read }
      ctxs.set(r.i, ctx)
      const entryIso = new Date(Math.floor(e / 1000) + 8 * 3600_000).toISOString()   // date only is read (counted); all rules count here
      const res = evaluateRules(RULES, read.bars.length ? ctx : null, { direction: r.sgn > 0 ? 'long' : 'short', symbol: 'MNQ', entry_time: entryIso })
      const m: Record<string, 'pass' | 'fail' | 'unknown'> = {}
      RULE_KEYS.forEach((k, j) => { m[k] = res[j].status })
      ours.set(r.i, m)
      if (r.dom60 != null && read.tape != null) tapeDiff.push(Math.abs(read.tape - r.dom60))
      for (const k of RULE_KEYS) {
        const want = r[k]
        if (want == null) continue
        const got = m[k]
        if ((want ? 'pass' : 'fail') !== got) {
          const x = read.bars.length ? runs(ctx, r.sgn) : null
          mism[k].push(`${r.pt.slice(0, 19)} ${r.sgn > 0 ? 'L' : 'S'} ${r.src} research=${want ? 'pass' : 'fail'} site=${got}`
            + (k === 'L1' || k === 'L3' ? ` run_against research=${r.run_against} site=${x?.ra}` : '')
            + (k === 'F6' ? ` ha_run research=${r.ha_run} site=${x?.ha}` : '')
            + (k === 'L2' || k === 'F5' ? ` tape research=${r.dom60?.toFixed(3)} site=${read.tape?.toFixed(3)}` : '')
            + ` | ${res[RULE_KEYS.indexOf(k)].reason}`)
        }
      }
      if (sample.length < 60 && r.i % 11 === 0) sample.push({ r, ticks, e })
    }
  }
  console.log(`\nParity: ${fx.length} research trades on ${dates} dates, local .scid\n`)
  console.log('rule  agree / compared   research pass        site pass            research fail        site fail')
  let worst = 0
  for (const k of RULE_KEYS) {
    const comp = fx.filter(r => r[k] != null)
    const agree = comp.filter(r => (r[k] ? 'pass' : 'fail') === ours.get(r.i)![k]).length
    worst = Math.max(worst, comp.length - agree)
    const rp = fx.filter(r => r[k] === true).map(r => r.pnl), rf = fx.filter(r => r[k] === false).map(r => r.pnl)
    const sp = fx.filter(r => ours.get(r.i)![k] === 'pass').map(r => r.pnl), sf = fx.filter(r => ours.get(r.i)![k] === 'fail').map(r => r.pnl)
    const su = fx.filter(r => ours.get(r.i)![k] === 'unknown').length
    console.log(`${k}    ${String(agree).padStart(3)} / ${comp.length}        ${stats(rp)}    ${stats(sp)}    ${stats(rf)}    ${stats(sf)}${su ? `   (site unknown ${su})` : ''}`)
  }
  tapeDiff.sort((a, b) => a - b)
  console.log(`\nTape Reader vs research dom60 on ${tapeDiff.length} trades: median |diff| ${tapeDiff[Math.floor(tapeDiff.length / 2)]?.toFixed(4)}, 95th ${tapeDiff[Math.floor(tapeDiff.length * 0.95)]?.toFixed(4)}, max ${tapeDiff[tapeDiff.length - 1]?.toFixed(4)}`)
  for (const k of RULE_KEYS) {
    if (!mism[k].length) continue
    console.log(`\n${k} — ${mism[k].length} disagreements:`)
    for (const line of mism[k].slice(0, 25)) console.log('  ' + line)
    if (mism[k].length > 25) console.log(`  … ${mism[k].length - 25} more`)
  }

  // ── no look-ahead ──
  let laFail = 0
  for (const { r, ticks, e } of sample) {
    const before = JSON.stringify(readEntryContext(ticks, e))
    const n = ticks.n + 500
    const t2: FlowTicks = { n, t: new Float64Array(n), px: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n) }
    for (let i = 0; i < ticks.n; i++) {
      const after = ticks.t[i] >= e
      t2.t[i] = ticks.t[i]
      t2.px[i] = after ? ticks.px[i] + 1000 : ticks.px[i]
      t2.v[i] = after ? ticks.v[i] * 7 + 3 : ticks.v[i]
      t2.bv[i] = after ? ticks.av[i] * 9 + 1 : ticks.bv[i]
      t2.av[i] = after ? ticks.bv[i] * 2 : ticks.av[i]
    }
    for (let k = 0; k < 500; k++) {   // extra trades after the fill, some in the fill's own minute
      const i = ticks.n + k
      t2.t[i] = e + k * 1_000_000; t2.px[i] = r.px + (k % 2 ? 50 : -50); t2.v[i] = 999; t2.bv[i] = k % 2 ? 999 : 0; t2.av[i] = k % 2 ? 0 : 999
    }
    const after = JSON.stringify(readEntryContext(t2, e))
    if (after !== before) { laFail++; console.log(`  LOOK-AHEAD: ${r.pt} snapshot changed when only data at/after the fill changed`) }
  }
  console.log(`\nNo look-ahead: ${sample.length - laFail} of ${sample.length} sampled fills unchanged when everything at/after the fill is altered${laFail ? '  ← FAIL' : ''}`)
  // and the entry minute itself is never a candle
  const one = sample[0]
  if (one) {
    const eMin = Math.floor(one.e / US_MIN) * US_MIN
    const ctx = readEntryContext(one.ticks, one.e)
    const lastBarStart = ctx.bars.at(-1)!.t
    const fillHm = one.r.pt.slice(11, 16)
    console.log(`Entry minute excluded: fill ${one.r.pt.slice(11, 19)} → last candle ${lastBarStart} (${lastBarStart < fillHm || fillHm === '00:00' ? 'ok' : 'FAIL'}); eMin ${eMin}`)
  }

  // ── the write rules (in memory; nothing is written anywhere) ──
  const routeFailed = await routeRules(fx, src)

  // ── hosted tape vs local .scid ──
  if (process.argv.includes('--hosted')) await hosted(src)
  process.exit(laFail || routeFailed ? 1 : 0)
}

async function routeRules(fx: Fx[], src: FlowHourSource): Promise<number> {
  console.log('\nWrite rules (in-memory copy; nothing is written anywhere):')
  let failed = 0
  const check = (name: string, ok: boolean) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }
  const toRow = (r: Fx, id: string): FlowTradeRecord => {
    const e = ptUs(r.pt)
    // PT wall clock → UTC: the PT offset at that instant (PDT −7 / PST −8)
    const guess = Math.floor(e / 1000)
    const off = ptOffsetMs(guess + 8 * 3600_000)
    return { id, symbol: 'MNQZ6.CME', entry_time: new Date(guess - off).toISOString(), entry_price: r.px, direction: r.sgn > 0 ? 'long' : 'short', review_json: null }
  }
  const base = fx.filter(r => r.src === 'fills').slice(0, 3).map((r, k) => toRow(r, `b000000${k}-0000-0000-0000-000000000000`))
  const memory = (seed: FlowTradeRecord[], onReadOne?: (r: FlowTradeRecord) => FlowTradeRecord) => {
    const table = new Map(seed.map(r => [r.id, structuredClone(r)]))
    const writes: { id: string; review: TradeReview }[] = []
    const store: FlowTradeStore = {
      async read(ids) { return ids.flatMap(id => (table.has(id) ? [structuredClone(table.get(id)!)] : [])) },
      async readOne(id) { const r = table.get(id); return r ? (onReadOne ? onReadOne(structuredClone(r)) : structuredClone(r)) : null },
      async writeReview(id, review) { writes.push({ id, review }); table.get(id)!.review_json = review },
    }
    return { store, writes, table }
  }
  const loader = () => new FlowScoreLoader(src)
  const score = { v: 'flow-4', total: 55, max: 100, facts: [], read_at: '08:00:00', at: '2026-01-01T00:00:00+00:00', src: 'x' }
  const verdict = { call: 'good' as const, note: 'keep me', at: '2026-01-01T00:00:00.000Z' }
  // 1. a missing snapshot is read and merged; the Score and the verdict survive
  const seeded = base.map(r => ({ ...r, review_json: { score, verdict } as TradeReview }))
  const m1 = memory(seeded)
  const res1 = await readEntryContexts(m1.store, seeded.map(r => r.id), loader)
  check('a trade without a snapshot is read and saved', seeded.every(r => res1[r.id]?.status === 'read') && m1.writes.length === seeded.length)
  check('the write keeps the Score, the verdict and every other key', m1.writes.every(w => JSON.stringify(w.review.score) === JSON.stringify(score) && JSON.stringify(w.review.verdict) === JSON.stringify(verdict)))
  // 2. a current snapshot is returned as is
  const m2 = memory([...m1.table.values()])
  const res2 = await readEntryContexts(m2.store, seeded.map(r => r.id), loader)
  check('a current snapshot is returned untouched, nothing written', seeded.every(r => res2[r.id]?.status === 'current') && m2.writes.length === 0)
  // 3. a snapshot read for another fill is replaced
  const stale = [...m1.table.values()].slice(0, 1).map(r => ({ ...r, review_json: { ...r.review_json, entry_ctx: { ...r.review_json!.entry_ctx!, src: 'other|fill' } } as TradeReview }))
  const m3 = memory(stale)
  const res3 = await readEntryContexts(m3.store, stale.map(r => r.id), loader)
  check('a snapshot read for a different fill is read again', res3[stale[0].id]?.status === 'read' && m3.writes.length === 1)
  // 4. the fill is edited while it is read: nothing written
  const m4 = memory(base.slice(0, 1), r => ({ ...r, entry_price: Number(r.entry_price) + 1 }))
  const res4 = await readEntryContexts(m4.store, [base[0].id], loader)
  check('a fill edited meanwhile gets nothing written', res4[base[0].id]?.status === 'pending' && m4.writes.length === 0)
  // 5. an instrument the tape does not carry, and an unknown id
  const other = { ...base[0], id: 'c0000000-0000-0000-0000-000000000000', symbol: 'CLZ6.NYMEX' }
  const m5 = memory([other])
  const res5 = await readEntryContexts(m5.store, [other.id, '00000000-0000-0000-0000-000000000000'], loader)
  check('another instrument → not readable, nothing written', res5[other.id]?.status === 'not_scorable' && m5.writes.length === 0)
  check('an id that is not one of the caller’s trades is absent', !('00000000-0000-0000-0000-000000000000' in res5))
  // 6. the stored snapshot is the version the client checks, for exactly this fill
  const saved = m1.table.get(seeded[0].id)!.review_json!.entry_ctx!
  check('the saved snapshot is current for its fill (version + fingerprint)', entryCtxIsCurrent(saved, seeded[0]) && saved.bars.length > 0 && saved.bars.length <= 12)
  return failed
}

async function hosted(local: FlowHourSource) {
  const env: Record<string, string> = {}
  for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
  const { data: u } = await sb.auth.admin.listUsers({ perPage: 200 })
  const me = u.users.find(x => x.email === 'edhasrage@gmail.com')
  if (!me) { console.log('founder not found on the public project'); return }
  const { data: rows, error } = await sb.from('trades').select('id, symbol, entry_time, entry_price, direction, pnl')
    .eq('user_id', me.id).gte('entry_time', '2026-09-25').order('entry_time')
  if (error || !rows) { console.log('could not read trades:', error?.message); return }
  const hostedLoader = new FlowScoreLoader(tapeFlowSource(supabaseTapeStore(sb), { cache: null }), { cacheWrite: false })
  const localLoader = new FlowScoreLoader(local)
  let same = 0, diff = 0, skipped = 0
  console.log(`\nHosted tape vs local .scid — ${rows.length} founder trades since Sep 25 (read only):`)
  for (const r of rows) {
    const [a, b] = await Promise.all([hostedLoader.entryContext(r), localLoader.entryContext(r)])
    if (a.status !== 'read' || b.status !== 'read') { skipped++; console.log(`  ${r.entry_time} ${r.symbol}: hosted ${a.status}${'reason' in a ? ` (${a.reason})` : ''} · local ${b.status}${'reason' in b ? ` (${b.reason})` : ''}`); continue }
    const ja = JSON.stringify(a), jb = JSON.stringify(b)
    if (ja === jb) same++
    else {
      diff++
      const ha = a.bars.map(x => `${x.t}:${x.o}/${x.c}/${x.v}`).join(' '), hb = b.bars.map(x => `${x.t}:${x.o}/${x.c}/${x.v}`).join(' ')
      console.log(`  DIFF ${r.entry_time} ${r.symbol} tape ${a.tape} vs ${b.tape}${ha !== hb ? `\n    hosted ${ha}\n    local  ${hb}` : ''}`)
    }
  }
  console.log(`Hosted = local on ${same} of ${same + diff} readable trades (${skipped} not readable on one side)`)
}

main().catch(e => { console.error(e); process.exit(1) })
