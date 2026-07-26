/**
 * Run the deep-dive investigations against the LIVE (public/prod) DB and print
 * what each one would say. Read-only — this writes nothing.
 *
 * It's the verification path for a dive: the analyzers are pure and unit-tested,
 * but only real fills tell you whether a dive fires at all, whether its floors
 * are set sanely, and whether the headline reads like a human wrote it.
 *
 *   npx tsx scripts/preview-deep-dives.ts --user you@x.com
 *   npx tsx scripts/preview-deep-dives.ts --user you@x.com --dive scale-out-ev
 *   npx tsx scripts/preview-deep-dives.ts                       # every user pooled
 *   flags: --since=YYYY-MM-DD, --tz=America/Los_Angeles
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { analyzeTiltCascade, type TiltTrade } from '../src/lib/deep-dive/tilt-cascade.ts'
import { analyzeScaleOutEv, type ScaleOutTrade } from '../src/lib/deep-dive/scale-out-ev.ts'
import { analyzeTimeOfDay, type TimeOfDayTrade } from '../src/lib/deep-dive/time-of-day.ts'
import type { DeepDiveResult } from '../src/lib/deep-dive/types.ts'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!)

const arg = (name: string): string | undefined => {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=').slice(1).join('=')
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const userArg = arg('user'), sinceArg = arg('since'), diveArg = arg('dive')
const TZ = arg('tz') ?? 'America/Los_Angeles'

const COLS = [
  'id', 'user_id', 'entry_time', 'exit_time', 'direction', 'entry_price', 'exit_price', 'stop_price',
  'quantity', 'pnl', 'symbol', 'high_during_position', 'low_during_position',
  'entry_atr_1m', 'exits_json',
].join(', ')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

async function resolveUserId(email: string): Promise<string | undefined> {
  const { data } = await sb.auth.admin.listUsers()
  return (data?.users ?? []).find((u: { email?: string; id: string }) => u.email === email)?.id
}

async function fetchTrades(uid: string | undefined): Promise<Row[]> {
  const rows: Row[] = []
  for (let p = 0; p < 60; p++) {
    let q = sb.from('trades').select(COLS).order('id', { ascending: true }).range(p * 1000, p * 1000 + 999)
    if (uid) q = q.eq('user_id', uid)
    if (sinceArg) q = q.gte('entry_time', `${sinceArg}T00:00:00Z`)
    const { data, error } = await q
    if (error) { console.error('fetch failed:', error.message); break }
    if (!data?.length) break
    rows.push(...data)
    if (data.length < 1000) break
  }
  return rows
}

function show(result: DeepDiveResult | null, id: string) {
  console.log(`\n── ${id} ${'─'.repeat(Math.max(0, 60 - id.length))}`)
  if (!result) { console.log('  (no result — below a floor or nothing notable)'); return }
  console.log(`  ${result.title}  [severity ${result.severity.toFixed(2)}]`)
  console.log(`  HEADLINE: ${result.headline}`)
  console.log('  SEGMENTS:')
  for (const s of result.segments) {
    const extra = s.extra ? `  ${JSON.stringify(s.extra)}` : ''
    console.log(`    ${s.label.padEnd(34)} ${String(s.value).padStart(8)}  n=${s.n ?? '—'}${s.pnl != null ? `  pnl=${s.pnl}` : ''}${extra}`)
  }
  console.log('  DETAIL:')
  for (const d of result.detail) console.log(`    • ${d}`)
  if (result.reframe) console.log(`  REFRAME: ${result.reframe}`)
  if (result.test) {
    console.log(`  TEST: ${result.test.rule}`)
    console.log(`        impact ${result.test.impactUsd >= 0 ? '+' : '−'}$${Math.abs(Math.round(result.test.impactUsd)).toLocaleString()}`)
    console.log(`        basis: ${result.test.basis}`)
  }
}

async function main() {
  let uid: string | undefined
  if (userArg) {
    uid = await resolveUserId(userArg)
    if (!uid) { console.error(`user not found: ${userArg}`); process.exit(1) }
  }
  const rows = await fetchTrades(uid)
  console.log(`PUBLIC DB | ${userArg ?? 'ALL USERS'}${sinceArg ? ` | since ${sinceArg}` : ''} | ${rows.length} trades | tz ${TZ}`)

  const wanted = (id: string) => !diveArg || diveArg === id

  if (wanted('tilt-cascade')) {
    const input: TiltTrade[] = rows.map(r => ({
      day: String(r.entry_time ?? '').slice(0, 10),
      entryTime: String(r.entry_time ?? ''),
      pnl: r.pnl == null ? null : Number(r.pnl),
      quantity: r.quantity == null ? null : Number(r.quantity),
    })).filter(t => t.day && t.entryTime)
    show(analyzeTiltCascade(input), 'tilt-cascade')
  }

  // stopped-reversal is deliberately NOT run here: it needs the ORDERED post-exit
  // path, which no column holds (trades.post_exit_* are two independent 30-min
  // maxima — see the note in stopped-reversal.ts). Measure it off ticks instead:
  //   npx tsx scripts/dive-stop-reversal-ticks.ts --user <email>
  if (wanted('stopped-reversal')) {
    console.log('\n── stopped-reversal ────────────────────────────────────────────')
    console.log('  (needs the ordered tick path — run scripts/dive-stop-reversal-ticks.ts)')
  }

  if (wanted('scale-out-ev')) {
    const input: ScaleOutTrade[] = rows.map(r => ({
      id: r.id,
      direction: r.direction,
      entryPrice: r.entry_price == null ? null : Number(r.entry_price),
      symbol: r.symbol,
      fills: Array.isArray(r.exits_json) ? r.exits_json : null,
      favorableExtreme: r.direction === 'long'
        ? (r.high_during_position == null ? null : Number(r.high_during_position))
        : (r.low_during_position == null ? null : Number(r.low_during_position)),
      atrPts: r.entry_atr_1m == null ? null : Number(r.entry_atr_1m),
    }))
    show(analyzeScaleOutEv(input), 'scale-out-ev')
  }

  if (wanted('time-of-day')) {
    const input: TimeOfDayTrade[] = rows.map(r => ({
      entryTime: r.entry_time,
      pnl: r.pnl == null ? null : Number(r.pnl),
    }))
    show(analyzeTimeOfDay(input, { timeZone: TZ }), 'time-of-day')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
