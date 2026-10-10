/**
 * Parity tests: src/lib/orderflow (TypeScript) vs the Python/JS REFERENCE — the
 * blind re-tag server (build_row, bubble_chart, value_area) and its viewer's
 * client code (footprint, profiles, timeframes, ATR).
 *   npx tsx scripts/test-orderflow-parity.ts
 * Plain tsx asserts; exits non-zero if anything failed. EXACT equality — no
 * tolerances — on every compared value.
 *
 * 1. SYNTHETIC (always runs, committed fixture scripts/fixtures/orderflow-synthetic.json):
 *    seeded tick streams that hit every acceptance branch of the bubble study,
 *    value areas with ties, Python round() / np.percentile edge values, and a
 *    synthetic payload through the viewer-side functions. Expected values were
 *    produced by the reference's own code (scripts/orderflow-fixtures/).
 *
 * 2. REAL TRADES (local only; SKIPS when the fixtures or Sierra .scid files are
 *    absent). Golden payloads from build_row(seq) live OUTSIDE the repo — they
 *    hold real fills and CME-derived data — in ORDERFLOW_FIXTURE_DIR
 *    (default D:/Documents/NQ_backtest/deepdive_fixtures). Each trade is rebuilt
 *    end-to-end from .scid by buildSnapshot() and compared field by field, plus
 *    a digest of the exact tick frame (count, sums, sha1 of times and prices).
 *
 * 3. TICK TAPE (the hosted site's data path): a chunk must decode to exactly the
 *    frame that was encoded, and — real data, local only — a trade rebuilt from a
 *    published tape alone must equal the same trade built from .scid, blind and
 *    full review. One fixture by default; ORDERFLOW_TAPE_ALL=1 runs them all.
 */
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { join } from 'path'
import { pyRound, rint, npPercentileLinear } from '../src/lib/orderflow/pymath.ts'
import { bubbles40t } from '../src/lib/orderflow/bubbles40t.ts'
import { valueAreaTicks, volumeProfile, profileWindow, type ProfileWindow } from '../src/lib/orderflow/profile.ts'
import { toBars1m, vapPerBar, buildAgg, atr1m5m } from '../src/lib/orderflow/bars.ts'
import { footprintModel } from '../src/lib/orderflow/footprint.ts'
import { ptToUtcMs, utcToPtMs, ptDate, ptMidnight } from '../src/lib/orderflow/pt-clock.ts'
import type { TickFrame, OfRoot } from '../src/lib/orderflow/ticks.ts'
import type { MinuteBars, VapByMinute } from '../src/lib/orderflow/minute-bars.ts'
import { buildSnapshot, snapshotTicksForTest, snapshotWindow, type SnapshotRequest } from '../src/lib/orderflow/server/snapshot.ts'
import { encodeTape, decodeTape } from '../src/lib/orderflow/tape.ts'
import { fsTapeStore, loadTapeIndex, saveTapeIndex, publishTapeDay, loadTapeSource } from '../src/lib/orderflow/server/tape-store.ts'
import { weeklyAnchor } from '../src/lib/orderflow/levels.ts'
import { SIERRA_DATA_DIR } from '../src/lib/import-scid-day.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** JSON round-trip: undefined/NaN → null, drops functions — the shape the reference serialised. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x))

/** Exact structural diff; returns up to `max` "path: got X want Y" lines. */
function diff(got: unknown, want: unknown, path = '$', out: string[] = [], max = 6): string[] {
  if (out.length >= max) return out
  if (typeof want === 'number' && typeof got === 'number') {
    if (!(got === want || (Number.isNaN(got) && Number.isNaN(want)))) out.push(`${path}: got ${got} want ${want}`)
    return out
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) { out.push(`${path}: got ${typeof got} want array`); return out }
    if (got.length !== want.length) out.push(`${path}.length: got ${got.length} want ${want.length}`)
    for (let i = 0; i < Math.min(got.length, want.length) && out.length < max; i++) diff(got[i], want[i], `${path}[${i}]`, out, max)
    return out
  }
  if (want && typeof want === 'object') {
    if (!got || typeof got !== 'object') { out.push(`${path}: got ${JSON.stringify(got)} want object`); return out }
    const keys = new Set([...Object.keys(want as object), ...Object.keys(got as object)])
    for (const k of keys) {
      if (out.length >= max) break
      if (!(k in (want as object))) { out.push(`${path}.${k}: unexpected (got ${JSON.stringify((got as Record<string, unknown>)[k])?.slice(0, 60)})`); continue }
      if (!(k in (got as object))) { out.push(`${path}.${k}: missing`); continue }
      diff((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], `${path}.${k}`, out, max)
    }
    return out
  }
  if (got !== want) out.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  return out
}
const same = (name: string, got: unknown, want: unknown) => {
  const d = diff(plain(got), want)
  check(name, d.length === 0, d.join(' | '))
}

// ---------------------------------------------------------------- synthetic
const SYN = JSON.parse(readFileSync(new URL('./fixtures/orderflow-synthetic.json', import.meta.url), 'utf8'))

/** xorshift32 — mirror of XS in scripts/orderflow-fixtures/gen_synthetic.py. */
function xs(seed: number) {
  let x = (seed >>> 0) || 1
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0; return x }
}

/** Mirror of synth_ticks() in gen_synthetic.py — keep in lockstep. */
function synthTicks(seed: number, n: number, baseTk: number, big: number, esOffgrid: boolean, us0: number): TickFrame {
  const r = xs(seed)
  const f: TickFrame = {
    n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n), hh: new Float64Array(n),
    ll: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
  }
  let tk = baseTk, us = us0
  for (let i = 0; i < n; i++) {
    tk += (r() % 5) - 2
    us += 1 + r() % 40000
    const kind = r() % 100
    let nt = r() % 10 < 8 ? 1 : 1 + r() % 3
    let v = 1 + r() % 8
    if (r() % 100 < 4) v = Math.floor(big / 2) + r() % (2 * big)
    const bid = tk - (r() % 2), ask = bid + 1
    let px = ask / 4, hh = ask / 4
    const ll = bid / 4
    let bv = 0, av = 0
    if (kind < 45) av = v
    else if (kind < 88) { bv = v; px = bid / 4 }
    else if (kind < 94) {
      v = 2 * v; bv = av = v / 2
      const w = r() % 3
      px = w === 0 ? ask / 4 : w === 1 ? bid / 4 : (ask + bid) / 8
    } else if (kind < 95) v = 0
    else if (kind < 96) { av = v; px = 0.0 }
    else if (kind < 97) { /* v > 0, bid + ask = 0 */ }
    else if (kind < 98) { v = 2 * v; bv = av = v / 2; nt = 1; hh = 0.0 }
    else av = v
    if (esOffgrid && r() % 50 === 0) px += r() % 2 ? 0.125 : 0.1
    f.us[i] = us; f.px[i] = px; f.hh[i] = hh; f.ll[i] = ll; f.v[i] = v; f.bv[i] = bv; f.av[i] = av; f.nt[i] = nt
  }
  return f
}

console.log('pymath: Python round() and np.percentile')
{
  const bad = (SYN.py_round as [number, number, number][]).filter(([x, nd, want]) => pyRound(x, nd) !== want)
  check(`pyRound matches Python round() on ${SYN.py_round.length} edge cases (ties, negatives, off-grid)`, bad.length === 0,
    bad.slice(0, 4).map(([x, nd, w]) => `round(${x},${nd}) got ${pyRound(x, nd)} want ${w}`).join('; '))
  check('rint is numpy half-even: 0.5→0, 1.5→2, 2.5→2, -2.5→-2, -3.5→-4',
    rint(0.5) === 0 && rint(1.5) === 2 && rint(2.5) === 2 && rint(-2.5) === -2 && rint(-3.5) === -4 && rint(2.4) === 2)
  let pbad = 0, ptotal = 0
  for (const c of SYN.np_percentile as { a: number[]; q: number[]; expect: number[] }[]) {
    c.q.forEach((q, k) => { ptotal++; if (npPercentileLinear(c.a, q) !== c.expect[k]) pbad++ })
  }
  check(`npPercentileLinear matches np.percentile on ${ptotal} cases`, pbad === 0, `${pbad} mismatches`)
}

console.log('bubbles40t vs reference bubble_chart() on synthetic tick streams')
for (const c of SYN.bubbles) {
  const f = synthTicks(c.seed, c.n, c.base_tk, c.big, c.es_offgrid, SYN.us0)
  // checksum: same ticks on both sides
  let usSum = BigInt(0), px4 = 0, v = 0, bv = 0, av = 0, nt = 0
  for (let i = 0; i < f.n; i++) { usSum += BigInt(f.us[i]); px4 += f.px[i] * 4; v += f.v[i]; bv += f.bv[i]; av += f.av[i]; nt += f.nt[i] }
  const cs = c.checksum
  const sameTicks = f.n === cs.n && Number(usSum % BigInt(1000000007)) === cs.sum_us_mod && Math.abs(px4 - cs.sum_px4) < 1e-6 &&
    v === cs.sum_v && bv === cs.sum_bv && av === cs.sum_av && nt === cs.sum_nt
  check(`${c.inst} seed ${c.seed}: synthetic ticks identical to Python's (${c.n})`, sameTicks)
  same(`${c.inst} seed ${c.seed} n=${c.n} maxb=${c.maxb}: bubble chart`, bubbles40t(f, c.inst as OfRoot, c.maxb), c.expect)
}

console.log('valueAreaTicks vs reference value_area()')
{
  let bad = 0
  const msgs: string[] = []
  for (const c of SYN.value_area) {
    const d = diff(plain(valueAreaTicks(c.ticks, c.vols)), c.expect)
    if (d.length) { bad++; msgs.push(d[0]) }
  }
  check(`${SYN.value_area.length} value areas (incl. all-equal and zero volume)`, bad === 0, msgs.slice(0, 3).join(' | '))
}

/** Viewer-side expectations (footprint, profiles, TF aggregation, ATR) for one payload. */
type ViewerExpect = {
  atr: { atr1: number | null; atr5: number | null }
  agg: Record<string, Record<string, unknown>[]>
  profile: Record<string, unknown>
  footprint: { cfg: { fp: number; prof: number; min: number; fpR: number }; cols: unknown[]; keys: unknown; grid: unknown[]; runs: unknown[] }[]
}
type PayloadLike = {
  row: { inst: string; time: string; price: number }
  has_partial: boolean
  bars: MinuteBars
  vap: VapByMinute
  times: { entry: number; profile_anchor: number; eth_start: number; rth_open: number; prior_open: number; prior_close: number }
  bracket: { stop: number | null; tp: number | null }
}
const AGG_KEYS = ['t', 'o', 'h', 'l', 'c', 'v', 'bv', 'av', 'd', 'dmin', 'dmax', 'ho', 'hc', 'hh', 'hl', 'poc', 'mark', 'partial'] as const

function checkViewer(label: string, p: PayloadLike, exp: ViewerExpect) {
  const m1 = toBars1m(p.bars, p.has_partial)
  const vap = vapPerBar(p.vap, m1.length)
  same(`${label}: ATR14 1m / 5m`, atr1m5m(m1, p.times.entry), exp.atr)
  for (const tf of Object.keys(exp.agg)) {
    const agg = buildAgg(m1, vap, Number(tf)).map(b => Object.fromEntries(AGG_KEYS.map(k => [k, b[k]])))
    same(`${label}: ${tf}m bars + Heiken-Ashi + bar POC + session marks (${exp.agg[tf].length})`, agg, exp.agg[tf])
  }
  const prof: Record<string, unknown> = {}
  for (const key of Object.keys(exp.profile)) {
    const [which, g] = key.split(':')
    const [t0, t1] = profileWindow(which as ProfileWindow, p.times)
    prof[key] = volumeProfile(m1, vap, t0, t1, Number(g))
  }
  same(`${label}: volume profiles session/overnight/prior × 5 row sizes`, prof, exp.profile)
  for (const fp of exp.footprint) {
    const { cfg } = fp
    const model = footprintModel(m1, vap, { bars: 15, g: cfg.fp, ratio: cfg.fpR, minVol: cfg.min },
      { price: p.row.price, entrySec: +p.row.time.slice(6, 8) }, p.bracket)
    const cols = model.cols.map(c => ({ t: c.bar.t, partial: c.bar.partial, s: c.stats, klo: c.klo, khi: c.khi, m: [...c.cells.entries()].sort((a, b) => a[0] - b[0]) }))
    const keys = { eK: model.eK, sK: model.sK, tK: model.tK, kmin: model.kmin, kmax: model.kmax, g: cfg.fp, ratio: cfg.fpR, minV: cfg.min, N: model.cols.length, first: m1.length - model.cols.length }
    const grid = model.cols.map((c, j) => ({ j, pk: c.poc, mxd: c.maxAbsDelta, askI: [...c.askImb].sort((a, b) => a - b), bidI: [...c.bidImb].sort((a, b) => a - b) }))
    const runs = model.cols.flatMap((c, j) => c.stacked.map(s => ({ j, color: s.side === 'ask' ? '#2fd47f' : '#ff5b5b', kTop: s.kTop, cnt: s.cnt })))
    same(`${label}: footprint rows=${cfg.fp}t ${cfg.fpR * 100}% min ${cfg.min} — cells, VPS/range/delta tiers, POC, imbalances, stacks`,
      { cols, keys, grid, runs }, { cols: fp.cols, keys: fp.keys, grid: fp.grid, runs: fp.runs })
  }
}

console.log('viewer-side functions on the synthetic payload')
checkViewer('synthetic', SYN.payload, SYN.viewer)

// ---------------------------------------------------------------- real trades (local only)
const FIX = process.env.ORDERFLOW_FIXTURE_DIR ?? 'D:/Documents/NQ_backtest/deepdive_fixtures'
const rows = existsSync(FIX) ? readdirSync(FIX).filter(f => /^row-\d+\.json\.gz$/.test(f)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4))) : []
const SCID_OK = existsSync('D:/SierraCharts/Data') || !!process.env.SIERRA_DATA_DIR
if (!rows.length || !SCID_OK) {
  console.log(`\nreal-trade parity: SKIPPED (${!rows.length ? `no fixtures in ${FIX}` : 'no Sierra data dir'})`)
} else {
  console.log(`\nreal-trade parity: ${rows.length} trades rebuilt from .scid vs build_row()`)
  const timings: string[] = []
  for (const f of rows) {
    const doc = JSON.parse(gunzipSync(readFileSync(join(FIX, f))).toString())
    const P = doc.payload
    const r = P.row
    const label = `${r.inst} ${r.date} ${r.time} ${r.direction}`
    const recorded = P.bracket.stop_src === 'journal'
    const req: SnapshotRequest = {
      root: r.inst, entryUtcMs: ptToUtcMs(Date.parse(`${r.date}T${r.time}Z`)), direction: r.direction, entryPrice: r.price,
      atrStopTarget: 1, tp1RMultiple: 2,
      recordedStop: recorded ? P.bracket.stop : null,
      recordedTp: P.bracket.tp_src === 'journal' ? P.bracket.tp : null,
      entryAtr: P.bracket.atr_src.startsWith('TapeScore') ? P.bracket.atr : null,
    }
    console.log(`${label}`)
    // tick frame digest
    const T = snapshotTicksForTest(req)
    const usB = Buffer.alloc(T.n * 8), pxB = Buffer.alloc(T.n * 8)
    let sv = 0, sbv = 0, sav = 0, snt = 0, buy = 0, sell = 0, zero = 0
    for (let i = 0; i < T.n; i++) {
      usB.writeBigInt64LE(BigInt(T.us[i]), i * 8); pxB.writeDoubleLE(T.px[i], i * 8)
      sv += T.v[i]; sbv += T.bv[i]; sav += T.av[i]; snt += T.nt[i]
      const d = T.av[i] > T.bv[i] ? 1 : T.bv[i] > T.av[i] ? -1 : T.px[i] >= T.hh[i] ? 1 : T.px[i] <= T.ll[i] ? -1 : 0
      if (d > 0) buy++; else if (d < 0) sell++; else zero++
    }
    same('tick frame: count, sums, first/last time, sha1(times), sha1(prices), side split', {
      n: T.n, first_us: T.n ? T.us[0] : null, last_us: T.n ? T.us[T.n - 1] : null,
      sum_v: sv, sum_bv: sbv, sum_av: sav, sum_nt: snt, d_buy: buy, d_sell: sell, d_zero: zero,
      sha1_us: createHash('sha1').update(usB).digest('hex'), sha1_px: createHash('sha1').update(pxB).digest('hex'),
    }, doc.ticks)

    const t0 = performance.now()
    const S = buildSnapshot(req)
    const ms = performance.now() - t0
    timings.push(`${r.inst} ${r.date} ${ms.toFixed(0)}ms (${T.n.toLocaleString()} ticks)`)
    same('row + cutoff label + partial flag', { row: S.row, cutoff_label: S.cutoff_label, has_partial: S.has_partial, tick: S.tick },
      { row: P.row, cutoff_label: P.cutoff_label, has_partial: P.has_partial, tick: P.tick })
    same('session times (entry, RTH, IB, prior session, ETH start, profile anchor)', S.times, P.times)
    const keep = ['t', 'o', 'h', 'l', 'c', 'v', 'bv', 'av', 'd', 'dmin', 'dmax', 'pv', 'vv'] as const
    same(`1m bars incl. partial entry bar (${P.bars.t.length}) — OHLC, volume, bid/ask, delta close/min/max, Σpv`,
      S.bars, Object.fromEntries(keep.map(k => [k, P.bars[k]])))
    same(`volume-at-price by minute (${P.vap.m.length} cells)`, S.vap, P.vap)
    same(`levels as of the fill (${P.levels.length})`, S.levels, P.levels)
    same(`40-trade bubble chart (${P.bubbles?.n ?? 0} bars, ${P.bubbles?.marks.length ?? 0} large-print rings)`, S.bubbles, P.bubbles)
    same('large-print threshold', S.lpt, P.lpt)
    const B = S.bracket
    const srcMap = (s: string) => (s === 'recorded' ? 'journal' : null)
    same(`planned bracket (stop ${P.bracket.stop_src}, TP ${P.bracket.tp_src}, ATR from ${P.bracket.atr_src})`,
      { atr: B.atr, stop: B.stop, tp: B.tp, stop_journal: srcMap(B.stop_src), tp_journal: srcMap(B.tp_src) },
      { atr: P.bracket.atr, stop: P.bracket.stop, tp: P.bracket.tp,
        stop_journal: P.bracket.stop_src === 'journal' ? 'journal' : null, tp_journal: P.bracket.tp_src === 'journal' ? 'journal' : null })
    const vf = join(FIX, f.replace('.json.gz', '.viewer.json.gz'))
    if (existsSync(vf)) checkViewer('  viewer', P, JSON.parse(gunzipSync(readFileSync(vf)).toString()))
  }
  console.log(`\nbuildSnapshot timings: ${timings.join(' · ')}`)
}

// ---------------------------------------------------------------- tick tape (hosted data path)
function sameTicks(a: TickFrame, b: TickFrame): string | null {
  if (a.n !== b.n) return `n ${a.n} vs ${b.n}`
  for (const k of ['us', 'px', 'hh', 'll', 'v', 'bv', 'av', 'nt'] as const) {
    for (let i = 0; i < a.n; i++) if (a[k][i] !== b[k][i]) return `${k}[${i}] ${a[k][i]} vs ${b[k][i]}`
  }
  return null
}

async function tapeTests() {
  console.log('\ntick tape: lossless encode / decode')
  for (const c of (SYN.bubbles as { inst: string; seed: number; n: number; base_tk: number; big: number }[]).slice(0, 4)) {
    const f = synthTicks(c.seed, c.n, c.base_tk, c.big, false, SYN.us0)
    // a block written twice, out of order — Sierra files really do this
    for (let i = 300; i < 340 && i < f.n; i++) f.us[i] = f.us[i - 60] + 1
    // the tape stores prices in hundredths (exact for a 0.25 tick); the synthetic
    // stream's half-tick mid prices can't occur in a real file
    for (let i = 0; i < f.n; i++) f.px[i] = Math.round(f.px[i] * 100) / 100
    const d = sameTicks(f, decodeTape(encodeTape(f)))
    check(`${c.inst} seed ${c.seed}: ${c.n} ticks incl. a backward time step, missing asks, zero prices`, d === null, d ?? undefined)
  }
  check('empty frame round-trips', decodeTape(encodeTape(synthTicks(1, 0, 80000, 50, false, SYN.us0))).n === 0)

  if (!rows.length || !SCID_OK) { console.log('\ntape vs .scid on real trades: SKIPPED'); return }
  const wanted = process.env.ORDERFLOW_TAPE_ALL ? rows : rows.filter(f => /row-382\./.test(f))
  console.log(`\ntape vs .scid on real trades (${wanted.length}; ORDERFLOW_TAPE_ALL=1 for every fixture)`)
  for (const f of wanted) {
    const r = JSON.parse(gunzipSync(readFileSync(join(FIX, f))).toString()).payload.row
    const entryUtcMs = ptToUtcMs(Date.parse(`${r.date}T${r.time}Z`))
    const req: SnapshotRequest = { root: r.inst, entryUtcMs, direction: r.direction, entryPrice: r.price, atrStopTarget: 1, tp1RMultiple: 2 }
    const dir = mkdtempSync(join(tmpdir(), 'ts-tape-'))
    try {
      const store = fsTapeStore(dir)
      const index = await loadTapeIndex(store, r.inst)
      const first = ptDate(weeklyAnchor(utcToPtMs(entryUtcMs)) - 7 * 86_400_000)
      let chunks = 0, bytes = 0, days = 0
      const t0 = performance.now()
      for (let d = first; d <= r.date; d = ptDate(ptMidnight(d) + 86_400_000)) {
        const out = await publishTapeDay(store, r.inst, d, index, { dataDir: SIERRA_DATA_DIR })
        chunks += out.uploaded; bytes += out.bytes; days++
      }
      await saveTapeIndex(store, index)
      const pubMs = performance.now() - t0
      const again = await publishTapeDay(store, r.inst, r.date, index, { dataDir: SIERRA_DATA_DIR })
      check(`${r.inst} ${r.date}: published ${days} days = ${chunks} hourly chunks, ${(bytes / 1e6).toFixed(1)} MB (${(pubMs / 1000).toFixed(1)} s); a second pass uploads nothing`, chunks > 0 && again.uploaded === 0)
      for (const mode of ['blind', 'full review'] as const) {
        const q = mode === 'blind' ? req : { ...req, displayEndUtcMs: entryUtcMs + 40 * 60_000 }
        const t1 = performance.now()
        const src = await loadTapeSource(fsTapeStore(dir), r.inst, q.displayEndUtcMs ?? entryUtcMs, idx => snapshotWindow(idx, entryUtcMs)?.startPt ?? null)
        const fromTape = buildSnapshot(q, src)
        const ms = performance.now() - t1
        const fromScid = buildSnapshot(q)
        const norm = (x: ReturnType<typeof buildSnapshot>) => ({ ...plain(x), cut: { ...x.cut, contracts: [] } })
        same(`${r.inst} ${r.date} ${r.time} ${mode}: snapshot from the tape == snapshot from .scid (load + build ${ms.toFixed(0)} ms)`, norm(fromTape), norm(fromScid))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

tapeTests().catch(e => { failures++; console.error(e) }).then(() => {
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
})
