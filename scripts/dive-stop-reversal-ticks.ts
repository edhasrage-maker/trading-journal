/**
 * Measure the ORDERED post-exit path from SCID ticks and run the
 * stopped-then-reversed deep dive on it. Read-only — writes nothing.
 *
 * Why ticks and not trades.post_exit_*: those two columns are independent MAXIMA
 * over a 30-minute window, so they can't answer "would a stop 2.5 pts wider have
 * survived?" — over 30 minutes price nearly always travels 2.5 pts past the exit
 * at some point, which scored 11 of 12 live stop-outs as "stopped anyway"
 * regardless of how the trade actually resolved. The counterfactual needs to know
 * WHEN the heat came relative to the recovery, which means walking the path in
 * order. That's what this does, off the same tick stream (and the same NQ roll
 * table) as the Pt 11 excursion backfill.
 *
 * For each inferred stop-out it walks ticks from the exit forward and records:
 *   reachedEntry / reachedTarget       did price get back to entry / entry +1R
 *   adverseBefore{Entry,Target}Pts     worst heat BEFORE that happened
 *   maxAdversePts / maxFavorablePts    extremes over the whole horizon
 *
 * Basis-clean: distances are differences WITHIN the NQ tick series anchored to
 * the trade's own exit price, so MNQ/NQ and roll basis cancel. NQ family only.
 *
 *   npx tsx scripts/dive-stop-reversal-ticks.ts --user you@x.com
 *   flags: --since=YYYY-MM-DD, --horizon=30 (minutes), --limit=N, --verbose
 *
 * The server-side path (so the coach can run this dive for any user) needs these
 * five fields persisted per trade — a migration + backfill that is NOT part of
 * this script. Until that exists, this is the way to get the real answer.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { isNQ, ticksFor } from './nq-tick-series.ts'
import { analyzeStoppedReversal, type StopReversalTrade, type PostExitPath } from '../src/lib/deep-dive/stopped-reversal.ts'

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
const userArg = arg('user'), sinceArg = arg('since')
const HORIZON_MIN = Number(arg('horizon') ?? 30)
const LIMIT = Number(arg('limit') ?? Infinity)
const VERBOSE = process.argv.includes('--verbose')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

async function resolveUserId(email: string): Promise<string | undefined> {
  const { data } = await sb.auth.admin.listUsers()
  return (data?.users ?? []).find((u: { email?: string; id: string }) => u.email === email)?.id
}

/**
 * Walk the post-exit tick path in order. `riskPts` is the trade's realized risk
 * (entry → exit); recovery levels are entry (= exit + riskPts favorable) and
 * entry +1R (= exit + 2×riskPts favorable), both expressed relative to the exit.
 */
function measurePath(ticks: number[], sign: 1 | -1, riskPts: number, horizonMin: number): PostExitPath | null {
  if (ticks.length < 2) return null
  const exitTick = ticks[0]
  // Favorable = the direction the trade wanted; adverse = the other way. Both are
  // measured from the first tick at/after the exit, so the trade's own exit price
  // is the anchor and any series basis cancels.
  const fav = (p: number) => (p - exitTick) * sign
  const adv = (p: number) => (exitTick - p) * sign

  let maxAdverse = 0, maxFavorable = 0
  let reachedEntry = false, reachedTarget = false
  let adverseBeforeEntry: number | null = null, adverseBeforeTarget: number | null = null

  for (const p of ticks) {
    const a = adv(p), f = fav(p)
    if (a > maxAdverse) maxAdverse = a
    if (f > maxFavorable) maxFavorable = f
    // Snapshot the running adverse max the FIRST time each level is touched —
    // that's the heat a wider stop would have had to sit through to get there.
    if (!reachedEntry && f >= riskPts) { reachedEntry = true; adverseBeforeEntry = maxAdverse }
    if (!reachedTarget && f >= 2 * riskPts) { reachedTarget = true; adverseBeforeTarget = maxAdverse }
  }
  return {
    reachedEntry, adverseBeforeEntryPts: adverseBeforeEntry,
    reachedTarget, adverseBeforeTargetPts: adverseBeforeTarget,
    maxAdversePts: maxAdverse, maxFavorablePts: maxFavorable,
    horizonMin,
  }
}

const COLS = [
  'id', 'entry_time', 'exit_time', 'direction', 'entry_price', 'exit_price', 'stop_price',
  'quantity', 'pnl', 'symbol', 'high_during_position', 'low_during_position', 'entry_atr_1m',
].join(', ')

async function fetchTrades(uid: string | undefined): Promise<Row[]> {
  const rows: Row[] = []
  for (let p = 0; p < 60; p++) {
    let q = sb.from('trades').select(COLS).lt('pnl', 0).order('id', { ascending: true }).range(p * 1000, p * 1000 + 999)
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

async function main() {
  let uid: string | undefined
  if (userArg) {
    uid = await resolveUserId(userArg)
    if (!uid) { console.error(`user not found: ${userArg}`); process.exit(1) }
  }
  const rows = await fetchTrades(uid)
  console.log(`PUBLIC DB | ${userArg ?? 'ALL USERS'}${sinceArg ? ` | since ${sinceArg}` : ''} | ${rows.length} losing trades | ${HORIZON_MIN}-min horizon`)

  const funnel = { notNq: 0, noTimes: 0, noTicks: 0, measured: 0 }
  const input: StopReversalTrade[] = []
  for (const r of rows) {
    if (input.length >= LIMIT) break
    if (!isNQ(r.symbol)) { funnel.notNq++; continue }
    const exitMs = Date.parse(r.exit_time ?? '')
    if (!Number.isFinite(exitMs) || r.exit_price == null || r.entry_price == null || !r.direction) { funnel.noTimes++; continue }
    const sign: 1 | -1 = r.direction === 'long' ? 1 : -1
    const riskPts = (Number(r.entry_price) - Number(r.exit_price)) * sign
    if (!(riskPts > 0)) { funnel.noTimes++; continue }
    const date = String(r.entry_time ?? '').slice(0, 10)
    const ticks = ticksFor(date, exitMs, exitMs + HORIZON_MIN * 60_000)
    const measured = ticks ? measurePath(ticks, sign, riskPts, HORIZON_MIN) : null
    if (!measured) { funnel.noTicks++; continue }
    funnel.measured++
    input.push({
      id: r.id,
      direction: r.direction,
      entryPrice: Number(r.entry_price),
      exitPrice: Number(r.exit_price),
      quantity: r.quantity == null ? null : Number(r.quantity),
      pnl: r.pnl == null ? null : Number(r.pnl),
      symbol: r.symbol,
      highDuringPosition: r.high_during_position == null ? null : Number(r.high_during_position),
      lowDuringPosition: r.low_during_position == null ? null : Number(r.low_during_position),
      atrPts: r.entry_atr_1m == null ? null : Number(r.entry_atr_1m),
      path: measured,
      stopPrice: r.stop_price == null ? null : Number(r.stop_price),
    })
    if (VERBOSE) {
      console.log(`  ${date} ${r.direction} risk=${riskPts.toFixed(2)} back=${measured.reachedEntry ? 'Y' : 'n'} 1R=${measured.reachedTarget ? 'Y' : 'n'} heatBefore1R=${measured.adverseBeforeTargetPts?.toFixed(2) ?? '—'} maxAdv=${measured.maxAdversePts.toFixed(2)}`)
    }
  }
  console.log(`Measured ${funnel.measured} paths (skipped: ${funnel.notNq} non-NQ, ${funnel.noTimes} missing fields, ${funnel.noTicks} no tick coverage)`)

  const result = analyzeStoppedReversal(input)
  console.log(`\n── stopped-reversal ${'─'.repeat(42)}`)
  if (!result) { console.log('  (no result — below the stop-out floor)'); return }
  console.log(`  ${result.title}  [severity ${result.severity.toFixed(2)}]`)
  console.log(`  HEADLINE: ${result.headline}`)
  for (const s of result.segments) {
    console.log(`    ${s.label.padEnd(30)} ${String(s.value).padStart(8)}  n=${s.n ?? '—'}${s.extra ? `  ${JSON.stringify(s.extra)}` : ''}`)
  }
  for (const d of result.detail) console.log(`    • ${d}`)
  if (result.reframe) console.log(`  REFRAME: ${result.reframe}`)
  if (result.test) {
    console.log(`  TEST: ${result.test.rule}`)
    console.log(`        impact ${result.test.impactUsd >= 0 ? '+' : '−'}$${Math.abs(Math.round(result.test.impactUsd)).toLocaleString()}`)
    console.log(`        basis: ${result.test.basis}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
