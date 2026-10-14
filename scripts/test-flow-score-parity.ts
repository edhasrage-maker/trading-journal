/**
 * Parity test: the site's Score (src/lib/orderflow/flow-score.ts, through the
 * same loader the API route uses) against the flow-4 scores the local Python
 * scorer already stored on the founder's trades.
 *
 *   npx tsx scripts/test-flow-score-parity.ts                 # hosted tick tape
 *   npx tsx scripts/test-flow-score-parity.ts --scid          # local Sierra .scid instead
 *   flags: --since=YYYY-MM-DD (default 2026-09-26) · --verbose (print every fact) ·
 *          --no-timing (parity only) ·
 *          --py=<file>  a JSON dump { out: [...] } of xy_grade_v3.run() over the same trades
 *                       (each entry the full grade, keyed by trade id). Used two ways: a trade
 *                       with no stored score is compared against the dump instead (widens the
 *                       test to older trades), and on a mismatch the intermediate numbers that
 *                       differ are printed.
 *
 * Then runs the route's own scoring-and-saving code (flow-score-run.ts) against an
 * IN-MEMORY copy of a few of those trades, to check the write rules: a current
 * score is left alone, a new one is merged without touching the verdict, and
 * nothing is written for a trade that cannot be scored or whose fill changed.
 *
 * Compares, per trade: the total, the fill time the tape was read at, and for
 * each of the five facts its points, state, label and text. EXACT equality.
 * Exits non-zero on any mismatch.
 *
 * READ ONLY. Trades are read with the service key from .env.public-feed; the
 * tick tape is read through a store whose write methods throw; the per-session
 * cache the route keeps in the bucket is pointed at a temp folder here, so
 * nothing is written to the hosted project. The same temp folder is what lets
 * the timing section measure a warm cache without touching the bucket.
 */
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { supabaseTapeStore, fsTapeStore, type TapeStore } from '../src/lib/orderflow/server/tape-store.ts'
import { FlowScoreLoader, tapeFlowSource, scidFlowSource, __resetFlowScoreMemory, type FlowTradeRow } from '../src/lib/orderflow/server/flow-score-loader.ts'
import { scoreTrades, type FlowTradeRecord, type FlowTradeStore } from '../src/lib/orderflow/server/flow-score-run.ts'
import { FLOW_VERSION, flowFingerprint } from '../src/lib/orderflow/flow-score-meta.ts'
import type { TradeFlowScore, TradeReview } from '../src/lib/supabase/types.ts'

const FOUNDER = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const flag = (name: string) => process.argv.includes(`--${name}`)
const since = arg('since') ?? '2026-09-26'
const useScid = flag('scid'), verbose = flag('verbose'), noTiming = flag('no-timing')
const pyPath = arg('py')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- service client, read only
const sb: any = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

/** The hosted bucket, reads only: any write is a bug in this script and throws. */
function readOnly(store: TapeStore): TapeStore {
  return {
    get: key => store.get(key),
    async put(key) { throw new Error(`read-only parity run tried to write ${key}`) },
    async remove() { throw new Error('read-only parity run tried to remove from the bucket') },
  }
}

interface Row extends FlowTradeRow { review_json: { score?: TradeFlowScore } | null }
type Expected = { score: Pick<TradeFlowScore, 'total' | 'facts' | 'read_at' | 'src'>; from: 'stored' | 'dump' }

const med = (xs: number[]) => { if (!xs.length) return NaN; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 }
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : '—')

async function main() {
  const { data, error } = await sb.from('trades')
    .select('id, symbol, entry_time, entry_price, direction, review_json')
    .eq('user_id', FOUNDER).gte('entry_time', `${since}T00:00:00Z`).order('entry_time', { ascending: true }).limit(2000)
  if (error) throw new Error(`could not read trades: ${error.message}`)
  const rows = data as Row[]

  const py: Record<string, Record<string, unknown>> = {}
  if (pyPath) {
    if (!existsSync(pyPath)) throw new Error(`--py file not found: ${pyPath}`)
    for (const g of JSON.parse(readFileSync(pyPath, 'utf8')).out) py[g.id] = g
  }
  /** What the Python says for a trade: the stored score, else the dump's. */
  const expected = (r: Row): Expected | null => {
    const stored = r.review_json?.score
    if (stored?.v === FLOW_VERSION) return { score: stored, from: 'stored' }
    const g = py[r.id] as { facts?: TradeFlowScore['facts']; flow_total?: number; time?: string } | undefined
    if (g?.facts && typeof g.flow_total === 'number') return { score: { total: g.flow_total, facts: g.facts, read_at: g.time ?? '' }, from: 'dump' }
    return null
  }
  const nStored = rows.filter(r => expected(r)?.from === 'stored').length, nDump = rows.filter(r => expected(r)?.from === 'dump').length
  console.log(`${rows.length} trades since ${since}; ${nStored} carry a stored ${FLOW_VERSION} score${pyPath ? `, ${nDump} more are in the Python dump` : ''}. Source: ${useScid ? 'local .scid' : 'hosted tick tape'}.\n`)

  const cacheDir = mkdtempSync(join(tmpdir(), 'flow-score-ctx-'))
  const makeSource = () => (useScid ? scidFlowSource() : tapeFlowSource(readOnly(supabaseTapeStore(sb)), { cache: fsTapeStore(cacheDir) }))

  let okTotal = 0, okPts = 0, okState = 0, okText = 0, okAll = 0, compared = 0
  const problems: string[] = []
  let routeFailures = 0
  const coldByFirst: number[] = [], coldByRest: number[] = []
  try {
    // ── pass 1: everything cold (no per-session cache anywhere) — this is also the parity run ──
    __resetFlowScoreMemory()
    const loader = new FlowScoreLoader(makeSource())
    const seenDay = new Set<string>()
    console.log('date        fill      inst       dir    python  site   who  their answ  ref  tape   result')
    for (const r of rows) {
      const t0 = performance.now()
      const o = await loader.score(r)
      const took = performance.now() - t0
      const exp = expected(r)
      const want = exp?.score
      const head = `${(r.entry_time ?? '').slice(0, 10)}  ${(o.status === 'scored' ? o.read_at : (r.entry_time ?? '').slice(11, 19) + 'Z').padEnd(9)} ${(r.symbol ?? '').padEnd(10)} ${(r.direction ?? '').padEnd(6)}`
      if (o.status !== 'scored') {
        const verdict = want ? 'MISMATCH (the Python scored it)' : 'ok (the Python has no score for it either)'
        console.log(`${head} ${String(want?.total ?? '—').padStart(5)}  ${'—'.padStart(4)}   ${o.status}: ${o.reason}   ${verdict}`)
        if (want) { compared++; problems.push(`${head.trim()}: site says "${o.status}: ${o.reason}", the Python scored it ${want.total}`) }
        continue
      }
      const loc = FlowScoreLoader.locate(r)
      const dayKey = 'reason' in loc ? '' : `${loc.root}|${loc.date}`
      if (seenDay.has(dayKey)) coldByRest.push(took); else { coldByFirst.push(took); seenDay.add(dayKey) }
      if (!want) {
        console.log(`${head} ${'—'.padStart(5)}  ${String(o.total).padStart(4)}   (no Python score to compare)`)
        continue
      }
      compared++
      const diffs: string[] = []
      const tOk = want.total === o.total
      let pOk = true, sOk = true, xOk = true
      const cells: string[] = []
      for (let i = 0; i < 5; i++) {
        const a = want.facts[i], b = o.facts[i]
        const p = a?.pts === b.pts, s = a?.state === b.state, x = a?.text === b.text && a?.label === b.label && a?.k === b.k && a?.max === b.max
        if (!p) { pOk = false; diffs.push(`${b.k}: points ${a?.pts} (python) vs ${b.pts} (site)`) }
        if (!s) { sOk = false; diffs.push(`${b.k}: state ${a?.state} (python) vs ${b.state} (site)`) }
        if (!x) { xOk = false; diffs.push(`${b.k}: text\n        python: ${a?.label} — ${a?.text}\n        site:   ${b.label} — ${b.text}`) }
        cells.push(`${String(b.pts).padStart(2)}${p && s && x ? ' ' : '*'}`)
      }
      if (want.read_at !== o.read_at) diffs.push(`read_at ${want.read_at} (python) vs ${o.read_at} (site)`)
      if (!tOk) diffs.push(`total ${want.total} (python) vs ${o.total} (site)`)
      if (want.src !== undefined && want.src !== flowFingerprint(r)) diffs.push(`fingerprint ${want.src} (python) vs ${flowFingerprint(r)} (site)`)
      if (tOk) okTotal++
      if (pOk) okPts++
      if (sOk) okState++
      if (xOk) okText++
      const all = !diffs.length
      if (all) okAll++
      console.log(`${head} ${String(want.total).padStart(5)}  ${String(o.total).padStart(4)}   ${cells.join('  ')}   ${all ? 'ok' : 'MISMATCH'}${exp?.from === 'dump' ? '   (vs dump)' : ''}`)
      if (verbose) for (const f of o.facts) console.log(`      ${f.k.padEnd(9)} ${String(f.pts).padStart(2)}/${f.max} ${f.state.padEnd(7)} ${f.text}`)
      if (!all) {
        problems.push(`${head.trim()}\n      ${diffs.join('\n      ')}`)
        const g = py[r.id]
        if (g) {
          const keys = ['atr', 'normal5', 'team', 'winner', 'pullback', 'pullback_time', 'mins_since', 'their_effort', 'flip', 'retrace_atr', 'stuck_them', 'stuck_us', 'heavy', 'extension', 'reversal_evidence', 'sA', 'sB', 'sD', 'team_pts', 'setup_kind', 'tape', 'tape_persist', 'defended', 'outliers']
          for (const k of keys) {
            const a = JSON.stringify(g[k]), b = JSON.stringify(o.detail[k])
            if (a !== b) console.log(`      python ${k} = ${a}\n      site   ${k} = ${b}`)
          }
        }
      }
    }
    const s1 = { ...loader.stats }

    console.log('\n── parity ─────────────────────────────────────────────')
    console.log(`compared            ${compared}`)
    console.log(`total               ${okTotal}/${compared}`)
    console.log(`all 5 fact points   ${okPts}/${compared}`)
    console.log(`all 5 fact states   ${okState}/${compared}`)
    console.log(`all 5 fact texts    ${okText}/${compared}`)
    console.log(`everything          ${okAll}/${compared}`)
    if (problems.length) { console.log('\nMISMATCHES'); for (const p of problems) console.log(`  ${p}`) }

    if (!noTiming) {
      const pass = async (l: FlowScoreLoader) => {
        const first: number[] = [], rest: number[] = [], parts = { context: 0, ticks: 0, grade: 0, n: 0 }
        const seen = new Set<string>()
        for (const r of rows) {
          const t0 = performance.now()
          const o = await l.score(r)
          const took = performance.now() - t0
          if (o.status !== 'scored') continue
          const loc = FlowScoreLoader.locate(r)
          const key = 'reason' in loc ? '' : `${loc.root}|${loc.date}`
          if (seen.has(key)) rest.push(took); else { first.push(took); seen.add(key) }
          parts.context += o.ms.context; parts.ticks += o.ms.ticks; parts.grade += o.ms.grade; parts.n++
        }
        return { first, rest, parts, stats: { ...l.stats } }
      }
      // pass 2: a new server instance (memory empty) with the per-session cache already written
      __resetFlowScoreMemory()
      const p2 = await pass(new FlowScoreLoader(makeSource()))
      // pass 3: the same instance again (decoded hours and per-session numbers in memory)
      const src = makeSource()
      await pass(new FlowScoreLoader(src))
      const p3 = await pass(new FlowScoreLoader(src))

      const line = (label: string, xs: number[]) => `${label.padEnd(36)} median ${ms(med(xs)).padStart(5)}   max ${ms(Math.max(...xs, 0)).padStart(5)}   (n=${xs.length})`
      const split = (p: Awaited<ReturnType<typeof pass>>) => `mean per trade: context ${ms(p.parts.context / p.parts.n)} · today's ticks ${ms(p.parts.ticks / p.parts.n)} · scoring ${ms(p.parts.grade / p.parts.n)}`
      console.log(`\n── timing, ms per trade (this machine → ${useScid ? 'local disk' : 'hosted bucket'}) ──`)
      console.log(`COLD — nothing cached anywhere (read ${s1.sessionsComputed} prior sessions + ${s1.weeksComputed} prior weeks of ticks over ${coldByFirst.length} instrument-days)`)
      console.log(line('  first trade of an instrument-day', coldByFirst))
      console.log(line('  later trades of that day', coldByRest))
      console.log(`NEW SERVER INSTANCE, per-session cache already written (${p2.stats.sessionsFromBucket} sessions + ${p2.stats.weeksFromBucket} weeks from the cache, ${p2.stats.sessionsComputed} computed; the cache is a temp folder here, bucket reads on the site)`)
      console.log(line('  first trade of an instrument-day', p2.first))
      console.log(line('  later trades of that day', p2.rest))
      console.log(`  ${split(p2)}`)
      console.log('WARM INSTANCE (recent decoded hours and the per-session numbers in memory)')
      console.log(line('  first trade of an instrument-day', p3.first))
      console.log(line('  later trades of that day', p3.rest))
      console.log(`  ${split(p3)}`)
    }
    routeFailures = await routeRules(rows, () => new FlowScoreLoader(makeSource()))
  } finally {
    rmSync(cacheDir, { recursive: true, force: true })
  }
  if (compared === 0) { console.log('\nNothing to compare.'); process.exit(1) }
  process.exit(okAll === compared && routeFailures === 0 ? 0 : 1)
}

/** The route's write rules, on an in-memory copy of real rows. Returns the number of failed checks. */
async function routeRules(rows: Row[], loader: () => FlowScoreLoader): Promise<number> {
  console.log('\n── route rules (in-memory copy of the trades; nothing is written anywhere) ──')
  let failed = 0
  const check = (name: string, ok: boolean) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }
  const scored = rows.filter(r => r.review_json?.score?.v === FLOW_VERSION && r.review_json.score.src === flowFingerprint(r))
  if (scored.length < 3) { console.log('  skipped: fewer than three trades with a current stored score'); return 0 }
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
  const asRecord = (r: Row): FlowTradeRecord => ({ id: r.id, symbol: r.symbol, entry_time: r.entry_time, entry_price: r.entry_price, direction: r.direction, review_json: r.review_json as TradeReview | null })
  const three = scored.slice(-3).map(asRecord)
  const NOBODY = '00000000-0000-0000-0000-000000000000'

  // 1. current scores are returned untouched; an unknown id is simply absent
  {
    const m = memory(three)
    const res = await scoreTrades(m.store, [...three.map(r => r.id), NOBODY], loader)
    check('a current score is returned as is, nothing written', three.every(r => res[r.id]?.status === 'current') && m.writes.length === 0)
    check('an id that is not one of the caller\u2019s trades is absent from the results', !(NOBODY in res))
  }
  // 2. a missing score is computed and merged; the verdict and other keys survive
  {
    const verdict = { call: 'good' as const, note: 'keep me', at: '2026-01-01T00:00:00.000Z' }
    const seed = three.map(r => ({ ...r, review_json: { verdict, tape_read: { kept: true } } as TradeReview }))
    const m = memory(seed)
    const res = await scoreTrades(m.store, seed.map(r => r.id), loader)
    check('a trade without a score is scored and saved', seed.every(r => res[r.id]?.status === 'scored') && m.writes.length === seed.length)
    check('the write keeps the verdict and every other key', m.writes.every(w => JSON.stringify(w.review.verdict) === JSON.stringify(verdict) && JSON.stringify(w.review.tape_read) === JSON.stringify({ kept: true })))
    // key order aside (Postgres stores jsonb keys in its own order), the objects must be equal
    const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : 1))) : v))
    const same = three.every(r => {
      const a = r.review_json!.score!, b = m.table.get(r.id)!.review_json!.score!
      return b.v === FLOW_VERSION && b.max === 100 && b.total === a.total && b.read_at === a.read_at && b.src === a.src && canon(b.facts) === canon(a.facts)
        && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/.test(b.at) && Object.keys(b).sort().join() === Object.keys(a).sort().join()
    })
    check('the saved score has the stored shape and values (v, total, max, facts, read_at, at, src)', same)
  }
  // 3. a score read for another fill (stale fingerprint) is replaced
  {
    const seed = three.slice(0, 1).map(r => ({ ...r, review_json: { score: { ...r.review_json!.score!, src: 'some|other|fill', total: -1 } } as TradeReview }))
    const m = memory(seed)
    const res = await scoreTrades(m.store, seed.map(r => r.id), loader)
    check('a score read for a different fill is re-scored', res[seed[0].id]?.status === 'scored' && m.table.get(seed[0].id)!.review_json!.score!.total === three[0].review_json!.score!.total)
  }
  // 4. the fill is edited while it is being scored: nothing is written
  {
    const seed = three.slice(0, 1).map(r => ({ ...r, review_json: null }))
    const m = memory(seed, r => ({ ...r, entry_price: Number(r.entry_price) + 1 }))
    const res = await scoreTrades(m.store, seed.map(r => r.id), loader)
    check('a fill edited meanwhile gets no score written', res[seed[0].id]?.status === 'pending' && m.writes.length === 0)
  }
  // 5. trades the tape cannot read: a clear reason, nothing written
  {
    const base = three[0]
    const seed: FlowTradeRecord[] = [
      { ...base, id: 'a0000000-0000-0000-0000-000000000001', review_json: null, entry_time: base.entry_time!.replace(/T\d\d/, 'T02') },   // the evening session
      { ...base, id: 'a0000000-0000-0000-0000-000000000002', review_json: null, symbol: 'CLZ6.NYMEX' },
      { ...base, id: 'a0000000-0000-0000-0000-000000000003', review_json: null, entry_time: '2025-03-04T17:00:00+00:00' },
    ]
    const m = memory(seed)
    const res = await scoreTrades(m.store, seed.map(r => r.id), loader)
    for (const r of seed) { const x = res[r.id]; console.log(`       ${r.symbol} ${r.entry_time} → ${x?.status}${x && 'reason' in x ? `: ${x.reason}` : ''}`) }
    check('outside the day session → not scorable', res[seed[0].id]?.status === 'not_scorable')
    check('unsupported instrument → not scorable', res[seed[1].id]?.status === 'not_scorable')
    check(useScid ? 'a date the local files do not hold → not scorable' : 'older than the tape → not scorable', res[seed[2].id]?.status === 'not_scorable')
    check('nothing written for any of them', m.writes.length === 0)
  }
  return failed
}

main().catch(e => { console.error(e); process.exit(1) })
