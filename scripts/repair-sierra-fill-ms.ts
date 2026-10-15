/**
 * Put back the true fill times on trades imported on the hosted site before
 * 2026-10-15. Until then naiveToUtc counted the milliseconds twice, so every
 * fill read in the uploader's timezone was stored late by its own ms (Sierra's
 * 09:28:15.053 became .106). The fix is in src/lib/sc-importer.ts; this repairs
 * what was already stored, for ONE user (the owner by default).
 *
 * The stored value alone can't be undone (a stored .250 is a true .125, or a
 * true .625 a second earlier), so each time is checked against Sierra's own
 * daily files (D:\SierraCharts\TradeActivityLogs, one per account per UTC day):
 *   - a stored time equal to a real fill → already right, left alone
 *   - equal to a real fill T plus T's own ms → stored late: set back to T
 *   - neither (a time the trader typed, e.g. 09:45:00) → left alone
 * Fields: entry_time, exit_time, exits_json[].time. A combined trade's id ends
 * in its entry second and moves with it (unless that id is taken). The
 * order-flow Score and entry-rule snapshot are keyed by the entry time; when
 * they were current for the old time they are re-keyed to the new one (same
 * reading, nothing re-scored). A trade whose PT date would change is skipped.
 *
 * DRY RUN BY DEFAULT. --apply writes; run it only with the founder's OK.
 *
 *   npx tsx scripts/repair-sierra-fill-ms.ts [--apply] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *        [--user=<uuid>] [--dir=<TradeActivityLogs>] [--envfile=<path>] [--env=local]
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { flowFingerprint } from '../src/lib/orderflow/flow-score-meta.ts'
import { todayPT } from '../src/lib/pt-time.ts'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const argVal = (n: string): string | null => argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? null
const isProd = (argVal('env') ?? 'public') !== 'local'
const FROM = argVal('from') ?? '2020-01-01'
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
// TENANT SCOPING (mandatory on prod): the service key bypasses RLS.
const OWNER_USER_ID = 'fa3fb352-9538-44cc-8ce1-1c76f307044c'
const USER_ID = argVal('user') ?? OWNER_USER_ID
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scoped = (q: any) => (isProd ? q.eq('user_id', USER_ID) : q)

// ── Sierra's daily files: fill instants only ────────────────────────────────
// [u32 tag][u32 len][bytes]; a record ends at tag 199. 101 = activity (2 = fill),
// 102 = µs since 1899-12-30 UTC, 103 = symbol. Matched against the text export
// column by column (295/295 rows, 2024-06-20).
const EPOCH = Date.UTC(1899, 11, 30)
const fillCache = new Map<string, { t: number; symbol: string }[]>()
function fillsOf(account: string, ymd: string): { t: number; symbol: string }[] {
  const key = `${account}|${ymd}`
  const hit = fillCache.get(key); if (hit) return hit
  const out: { t: number; symbol: string }[] = []
  const file = `${DIR}TradeActivityLog_${ymd}_UTC.${account}.data`
  if (existsSync(file)) {
    const buf = readFileSync(file)
    let o = 0, act = 0, us = 0, sym = ''
    while (o + 8 <= buf.length) {
      const tag = buf.readUInt32LE(o), len = buf.readUInt32LE(o + 4)
      if (tag === 101 && len === 4) act = buf.readInt32LE(o + 8)
      else if (tag === 102 && len === 8) us = Number(buf.readBigInt64LE(o + 8))
      else if (tag === 103) sym = buf.subarray(o + 8, o + 8 + len).toString('latin1')
      else if (tag === 199) { if (act === 2) out.push({ t: Math.floor(EPOCH + us / 1000), symbol: sym }); act = 0; us = 0; sym = '' }
      o += 8 + len
    }
  }
  fillCache.set(key, out)
  return out
}
const ACCOUNTS = (() => {
  try { return [...new Set(readdirSync(DIR).map(f => f.match(/^TradeActivityLog_\d{4}-\d\d-\d\d_UTC\.(.+)\.data$/)?.[1]).filter((a): a is string => !!a))] } catch { return [] }
})()
const utcDays = (a: number, b: number) => {
  const out: string[] = []
  for (let d = Math.floor(a / 86_400_000) * 86_400_000; d <= b; d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10))
  return out
}
/** What the old code stored for a fill at T. */
const doubled = (t: number) => t + (t % 1000)

interface Row {
  id: string; sierra_trade_id: string | null; symbol: string | null; direction: string | null; entry_price: number | null
  entry_time: string | null; exit_time: string | null; exits_json: { time?: string; price?: number; qty?: number }[] | null
  review_json: Record<string, unknown> | null
}

async function main() {
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} · ${isProd ? 'prod' : 'dev'} · user ${USER_ID} · ${FROM} → ${TO} · ${DIR}`)
  const rows: Row[] = []
  for (let p = 0; p < 100; p++) {
    const { data, error } = await scoped(sb.from('trades')
      .select('id, sierra_trade_id, symbol, direction, entry_price, entry_time, exit_time, exits_json, review_json'))
      .gte('entry_time', FROM).lte('entry_time', `${TO}T23:59:59Z`)
      .order('entry_time', { ascending: true }).order('id', { ascending: true }).range(p * 1000, p * 1000 + 999)
    if (error) throw new Error(`load trades: ${error.message}`)
    rows.push(...(data as Row[]))
    if (data.length < 1000) break
  }
  const takenIds = new Set(rows.map(r => r.sierra_trade_id).filter(Boolean) as string[])

  const tally = { trades: rows.length, noSierra: 0, noFile: 0, alreadyRight: 0, toFix: 0, fieldsFixed: 0, fieldsRight: 0, fieldsLeft: 0, ambiguous: 0, idMoves: 0, idTaken: 0, dateChange: 0, rekeyed: 0, written: 0 }
  const samples: string[] = []
  const left: string[] = []
  for (const r of rows) {
    const sid = r.sierra_trade_id ?? ''
    const times = [r.entry_time, r.exit_time, ...(r.exits_json ?? []).map(e => e.time ?? null)].map(x => (x ? Date.parse(x) : NaN)).filter(Number.isFinite)
    if (!sid || !r.symbol || !times.length) { tally.noSierra++; continue }
    const accounts = sid.startsWith('combined:') ? ACCOUNTS : sid.includes(':') ? [sid.slice(0, sid.lastIndexOf(':'))] : []
    if (!accounts.length) { tally.noSierra++; continue }
    const lo = Math.min(...times) - 2000, hi = Math.max(...times) + 2000
    const fills = new Set<number>()
    for (const a of accounts) for (const d of utcDays(lo - 86_400_000, hi + 86_400_000)) for (const f of fillsOf(a, d)) if (f.symbol === r.symbol && f.t >= lo && f.t <= hi) fills.add(f.t)
    if (!fills.size) { tally.noFile++; continue }
    // stored (late) → true; a late value two fills could have produced maps to null (left alone)
    const late = new Map<number, number | null>()
    for (const t of fills) { const k = doubled(t); late.set(k, late.has(k) && late.get(k) !== t ? null : t) }
    // one stored time → its true time, or null to leave it
    const fix = (iso: string | null | undefined): string | null => {
      if (!iso) return null
      const t = Date.parse(iso)
      if (fills.has(t)) { tally.fieldsRight++; return null }
      const truth = late.get(t)
      if (truth === null) { tally.ambiguous++; return null }
      if (truth === undefined) { tally.fieldsLeft++; left.push(`${sid} ${iso}`); return null }
      tally.fieldsFixed++
      return new Date(truth).toISOString()
    }
    const entry = fix(r.entry_time)
    const exit = fix(r.exit_time)
    let exitsChanged = false
    const exits = (r.exits_json ?? []).map(e => { const n = fix(e.time); if (n) { exitsChanged = true; return { ...e, time: n } } return e })
    if (!entry && !exit && !exitsChanged) { tally.alreadyRight++; continue }
    if (entry && todayPT(new Date(entry)) !== todayPT(new Date(r.entry_time!))) { tally.dateChange++; samples.push(`  SKIP (PT date would change) ${sid} ${r.entry_time} → ${entry}`); continue }
    tally.toFix++

    const upd: Record<string, unknown> = {}
    if (entry) upd.entry_time = entry
    if (exit) upd.exit_time = exit
    if (exitsChanged) upd.exits_json = exits
    // a combined id ends in the entry second
    if (entry && sid.startsWith('combined:')) {
      const next = sid.replace(/\|[^|]*$/, `|${entry.slice(0, 19)}`)
      if (next !== sid) {
        if (takenIds.has(next)) tally.idTaken++
        else { upd.sierra_trade_id = next; takenIds.add(next); tally.idMoves++ }
      }
    }
    if (samples.length < 12 || (argVal('show') ?? '').split(',').includes(sid)) samples.push(`  ${sid}  entry ${r.entry_time} → ${entry ?? '='}  exit ${r.exit_time} → ${exit ?? '='}${upd.sierra_trade_id ? `  id → …${String(upd.sierra_trade_id).slice(-20)}` : ''}`)
    // snapshots keyed to the old entry time get the new key (same reading, not re-scored)
    const rj = (r.review_json ?? {}) as { score?: { src?: string }; entry_ctx?: { src?: string } }
    const oldKey = flowFingerprint({ entry_time: r.entry_time, entry_price: r.entry_price, direction: r.direction, symbol: r.symbol } as never)
    const needsRekey = !!entry && (rj.score?.src === oldKey || rj.entry_ctx?.src === oldKey)
    if (needsRekey) tally.rekeyed++
    if (!apply) continue

    const { error: ue } = await scoped(sb.from('trades').update(upd).eq('id', r.id))
    if (ue) { console.warn(`  write failed ${r.id}: ${ue.message}`); continue }
    tally.written++
    if (needsRekey) {
      // the key uses the entry time exactly as the database returns it, so read it back
      const { data: fresh } = await scoped(sb.from('trades').select('entry_time, entry_price, direction, symbol, review_json').eq('id', r.id)).maybeSingle()
      if (!fresh) continue
      const newKey = flowFingerprint(fresh as never)
      const cur = { ...(fresh.review_json ?? {}) } as Record<string, { src?: string } | undefined>
      for (const part of ['score', 'entry_ctx'] as const) if (cur[part]?.src === oldKey) cur[part] = { ...cur[part], src: newKey }
      const { error: re } = await scoped(sb.from('trades').update({ review_json: cur }).eq('id', r.id))
      if (re) console.warn(`  re-key failed ${r.id}: ${re.message}`)
    }
  }
  console.log(`\n${JSON.stringify(tally, null, 1)}`)
  console.log('\nsamples:\n' + samples.join('\n'))
  if (left.length) console.log(`\nleft alone (no Sierra fill at that time, e.g. typed by hand), first 10:\n  ${left.slice(0, 10).join('\n  ')}`)
  console.log(apply ? `\nwrote ${tally.written} trade(s)` : `\nwould fix ${tally.toFix} trade(s) — rerun with --apply (founder's OK first)`)
}
main().catch(e => { console.error(e); process.exit(1) })
