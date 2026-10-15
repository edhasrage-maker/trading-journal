/**
 * One-off: give the founder's past trades their stop history (review_json.stops),
 * read from Sierra Chart's own daily activity files — so the runner rule
 * "breakeven only after TP1" can grade trades imported before exports carried
 * order rows (founder's call 2026-10-15; plan docs/runner-t3-stop-log-plan.md).
 *
 * Sierra keeps one binary file per account per UTC day in
 * D:\SierraCharts\TradeActivityLogs (TradeActivityLog_YYYY-MM-DD_UTC.<account>.data)
 * holding every order and fill. Undocumented format, decoded here only (the
 * app reads the text export): records of [u32 tag][u32 len][bytes], a record
 * ends at tag 199; prices are ×100; times are µs since 1899-12-30 UTC. The tags
 * were matched against the text export column by column (295/295 rows, 2024-06-20).
 *
 * Each trade's stops are found from ITS OWN entry order (the id in
 * sierra_trade_id) through src/lib/sc-stops.ts — the code the importers use —
 * never by rebuilding trades from the file (Sierra's file can miss a fill).
 *
 * DRY RUN BY DEFAULT — reports what it would write and how T3 would read.
 * --apply writes (read-merge into review_json; other parts untouched). Run
 * --apply only with the founder's OK.
 *
 *   npx tsx scripts/backfill-runner-stops.ts                    # dry run, prod, owner, since 2026-05-01
 *   npx tsx scripts/backfill-runner-stops.ts --apply
 *   --from=YYYY-MM-DD  --to=YYYY-MM-DD  --user=<uuid>  --dir=<TradeActivityLogs folder>
 *   --env=local        the dev DB (.env.local) instead of prod (.env.public-feed)
 *   --envfile=<path>   read the env from this file (e.g. the main checkout's, when run from a worktree)
 *
 * Run from the repo root (reads the env file from the working dir unless --envfile).
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { indexStopRows, stopOrdersFor, makeTradeStops, type ScOrderRow } from '../src/lib/sc-stops.ts'
import { evaluateRunnerRules, newRunnerRule, readRunner, readRunnerRules } from '../src/lib/runner-rules.ts'
import type { TradeStopOrder, TradeStops } from '../src/lib/supabase/types.ts'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? null
const isProd = (argVal('env') ?? 'public') !== 'local'
const FROM = argVal('from') ?? '2026-05-01'
const TO = argVal('to') ?? '2099-12-31'
const DIR = (argVal('dir') ?? 'D:/SierraCharts/TradeActivityLogs').replace(/\\/g, '/').replace(/\/?$/, '/')

for (const l of readFileSync(argVal('envfile') ?? (isProd ? '.env.public-feed' : '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(
  (isProd ? process.env.PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL)!,
  (isProd ? process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY)!,
)
// TENANT SCOPING (mandatory on prod): the service key bypasses RLS, so every
// read and write is filtered to one user. The dev project has no user_id.
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped = (q: any) => (isProd ? q.eq('user_id', USER_ID) : q)

// ── Sierra's binary daily file ──────────────────────────────────────────────
type Rec = Record<number, string | number>
const STR = new Set([103, 104, 106, 107, 118, 124, 127, 128, 130, 137, 139])
const I64 = new Set([100, 102, 105, 119, 160])
function decode(file: string): Rec[] {
  const buf = readFileSync(file); const out: Rec[] = []; let cur: Rec = {}; let o = 0
  while (o + 8 <= buf.length) {
    const tag = buf.readUInt32LE(o), len = buf.readUInt32LE(o + 4), v = buf.subarray(o + 8, o + 8 + len)
    let val: string | number
    if (STR.has(tag)) val = v.toString('latin1')
    else if (len === 8) val = I64.has(tag) ? Number(v.readBigInt64LE(0)) : v.readDoubleLE(0)
    else if (len === 4) val = v.readInt32LE(0)
    else if (len === 1) val = v[0]
    else val = v.toString('latin1')
    if (tag === 199) { out.push(cur); cur = {} } else cur[tag] = val
    o += 8 + len
  }
  return out
}
const EPOCH = Date.UTC(1899, 11, 30)
const msOf = (us: number) => EPOCH + us / 1000
// tag 112, as the text export spells it (4 never seen; left unpriced)
const STATUS: Record<number, string> = { 1: 'Order Sent', 2: 'Pending Open', 3: 'Pending Child-Client', 5: 'Open', 6: 'Pending Modify', 7: 'Pending Cancel', 8: 'Filled', 9: 'Canceled' }

interface DayLog { orders: ScOrderRow[]; fills: { t: number; symbol: string; ioid: string; buy: boolean; open: boolean }[] }
const cache = new Map<string, DayLog | null>()
function dayLog(account: string, ymd: string): DayLog | null {
  const key = `${account}|${ymd}`
  if (cache.has(key)) return cache.get(key)!
  const file = `${DIR}TradeActivityLog_${ymd}_UTC.${account}.data`
  let log: DayLog | null = null
  if (existsSync(file)) {
    log = { orders: [], fills: [] }
    decode(file).forEach((r, i) => {
      const t = msOf(Number(r[102]))
      if (r[101] === 1) log!.orders.push({
        t, account, symbol: String(r[103] ?? ''), ioid: String(r[105] ?? ''), parent: r[119] != null ? String(r[119]) : '',
        type: String(r[107] ?? ''), status: STATUS[Number(r[112])] ?? '', price: typeof r[110] === 'number' ? Math.round(r[110]) / 100 : null,
        source: String(r[104] ?? ''), seq: i,
      })
      else if (r[101] === 2) log!.fills.push({ t, symbol: String(r[103] ?? ''), ioid: String(r[105] ?? ''), buy: r[109] === 1, open: r[120] === 1 })
    })
  }
  cache.set(key, log)
  return log
}
const utcDays = (fromMs: number, toMs: number) => {
  const out: string[] = []
  for (let d = Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), new Date(fromMs).getUTCDate()); d <= toMs; d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10))
  return out
}
const ACCOUNTS = (() => {
  try { return [...new Set(readdirSync(DIR).map(f => f.match(/^TradeActivityLog_\d{4}-\d\d-\d\d_UTC\.(.+)\.data$/)?.[1]).filter((a): a is string => !!a))] } catch { return [] }
})()

/** One account's stops for a trade whose first entry order (or entry second) we know. */
function stopsInAccount(account: string, t: TradeRow, findEntry: (f: DayLog['fills'][number]) => boolean): TradeStopOrder[] | null {
  const entryHint = Date.parse(t.entry_time ?? '')
  const exitMs = Math.max(Date.parse(t.exit_time ?? '') || 0, ...exitTimes(t))
  const days = utcDays(entryHint - 86_400_000, (exitMs || entryHint) + 86_400_000)
  const logs = days.map(d => dayLog(account, d)).filter((l): l is DayLog => !!l)
  const fills = logs.flatMap(l => l.fills).sort((a, b) => a.t - b.t)
  const first = fills.find(f => f.open && findEntry(f))
  if (!first) return null
  // every opening fill on the same side and symbol from the first entry until the trade's last exit = its entry orders
  const buy = t.direction === 'long'
  const end = exitMs || first.t
  const entryIds = new Set(fills.filter(f => f.open && f.buy === buy && f.symbol === first.symbol && f.t >= first.t && f.t <= end + 1000).map(f => f.ioid))
  const ix = indexStopRows(logs.flatMap(l => l.orders).filter(o => o.symbol === first.symbol))
  return stopOrdersFor(ix, { account, entryOrderIds: entryIds, entryMs: first.t })
}

interface TradeRow {
  id: string; sierra_trade_id: string | null; entry_time: string | null; exit_time: string | null
  entry_price: number | null; direction: 'long' | 'short' | null; symbol: string | null
  tp1_price: number | null; exits_json: unknown; entry_atr_1m: number | null; review_json: Record<string, unknown> | null
}
const exitTimes = (t: TradeRow) => (Array.isArray(t.exits_json) ? t.exits_json as { time?: string }[] : []).map(e => Date.parse(e.time ?? '')).filter(Number.isFinite)

function stopsFor(t: TradeRow): { orders: TradeStopOrder[]; how: string } | null {
  const sid = t.sierra_trade_id ?? ''
  const m = sid.match(/^(.+):(\d+)$/)
  if (m && !sid.startsWith('combined:')) {
    const orders = stopsInAccount(m[1], t, f => f.ioid === m[2])
    return orders ? { orders, how: 'entry order' } : null
  }
  if (sid.startsWith('combined:')) {
    // combined:<symbol>|<direction>|<entry price>|<entry second>: every copy, in every account
    const [symbol, , , iso] = sid.slice('combined:'.length).split('|')
    const at = Date.parse(`${iso}Z`)
    const all: TradeStopOrder[] = []
    let found = 0
    for (const a of ACCOUNTS) {
      const orders = stopsInAccount(a, t, f => f.symbol === symbol && f.buy === (t.direction === 'long') && Math.abs(f.t - at) <= 1500)
      if (orders) { all.push(...orders); found++ }
    }
    return found ? { orders: all, how: `combined (${found} account${found === 1 ? '' : 's'})` } : null
  }
  return null
}

async function main() {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} · ${isProd ? 'prod' : 'dev'} · user ${USER_ID} · ${FROM} → ${TO} · ${DIR}`)
  const rows: TradeRow[] = []
  for (let p = 0; p < 100; p++) {
    const { data, error } = await scoped(sb.from('trades')
      .select('id, sierra_trade_id, entry_time, exit_time, entry_price, direction, symbol, tp1_price, exits_json, entry_atr_1m, review_json'))
      .gte('entry_time', FROM).lte('entry_time', `${TO}T23:59:59Z`)
      .order('entry_time', { ascending: true }).order('id', { ascending: true }).range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(`load trades: ${error.message}`)
    rows.push(...(data as TradeRow[]))
    if (data.length < 1000) break
  }
  const { data: prof } = await scoped(sb.from('trader_profile').select('scoring_profile_json')).maybeSingle()
  const t3Rule = readRunnerRules(prof?.scoring_profile_json?.runner_rules).find(r => r.type === 'be_after_tp1') ?? newRunnerRule('be_after_tp1', 'T3', FROM, 't3')

  let found = 0, missing = 0, noId = 0, same = 0, written = 0
  const runnerLines: string[] = []
  const verdicts: Record<string, number> = {}
  for (const t of rows) {
    if (!t.sierra_trade_id) { noId++; continue }
    const got = stopsFor(t)
    if (!got) { missing++; continue }
    found++
    const next: TradeStops = makeTradeStops(got.orders, t)
    if (readRunner(t).runner) {
      const res = evaluateRunnerRules([{ ...t3Rule, on: true, from: '1970-01-01' }], { ...t, stops: next })![0]
      verdicts[res.status] = (verdicts[res.status] ?? 0) + 1
      runnerLines.push(`  ${new Date(t.entry_time!).toLocaleString('en-CA', { timeZone: 'America/Los_Angeles', hour12: false }).slice(0, 17)} ${t.symbol} ${t.direction} · ${res.status.padEnd(7)} ${res.reason}`)
    }
    const prev = (t.review_json?.stops ?? null) as TradeStops | null
    if (prev && prev.v === next.v && prev.src === next.src && JSON.stringify(prev.orders) === JSON.stringify(next.orders)) { same++; continue }
    if (!apply) continue
    // read-merge on the row as it is now
    const { data: fresh, error: re } = await scoped(sb.from('trades').select('review_json').eq('id', t.id)).maybeSingle()
    if (re || !fresh) { console.warn(`  skip ${t.id}: ${re?.message ?? 'gone'}`); continue }
    const { error: ue } = await scoped(sb.from('trades').update({ review_json: { ...(fresh.review_json ?? {}), stops: next } }).eq('id', t.id))
    if (ue) { console.warn(`  write failed ${t.id}: ${ue.message}`); continue }
    written++
  }
  console.log(`\n${rows.length} trades · stop history found ${found} · not in Sierra's files ${missing} · no Sierra id ${noId} · already stored ${same}`)
  console.log(`runners (T3 as it would read, ${t3Rule.name || 'T3'}): ${JSON.stringify(verdicts)}`)
  console.log(runnerLines.join('\n'))
  console.log(apply ? `\nwrote ${written} trade(s)` : `\nwould write ${found - same} trade(s) — rerun with --apply (founder's OK first)`)
}
main().catch(e => { console.error(e); process.exit(1) })
