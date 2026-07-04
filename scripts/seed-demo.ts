/**
 * Seed (or tear down) the read-only "Explore the demo" account on the PUBLIC
 * TapeScore project (tapescore.app). Creates a single auth user (DEMO_EMAIL)
 * and fills it with curated, SYNTHETIC trading data so prospects can poke at
 * every screen without signing up. All numbers are made-up — no real edge.
 *
 *   npx tsx scripts/seed-demo.ts               # dry run (prints what it would do)
 *   npx tsx scripts/seed-demo.ts --commit      # create user + seed data
 *   npx tsx scripts/seed-demo.ts --teardown --commit   # delete demo data + user
 *
 * Reads .env.public-feed (the PUBLIC project's service-role key) — NOT .env.local.
 * Hard-guards on the public project ref so it can never touch the personal DB.
 * Read-only enforcement is separate (src/middleware.ts + the demo_readonly RLS
 * migration); this script only owns the data.
 */
import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const URL = process.env.PUBLIC_SUPABASE_URL || ''
const KEY = process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY || ''
const PUBLIC_REF = 'dmutgkycrjudfejswvhg'
if (!URL.includes(PUBLIC_REF)) {
  console.error(`REFUSING TO RUN: .env.public-feed does not point at the public project (${PUBLIC_REF}). URL=${URL}`)
  process.exit(1)
}

const DEMO_EMAIL = 'demo@tapescore.app'
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'tapescore-demo'
const commit = process.argv.includes('--commit')
const teardown = process.argv.includes('--teardown')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = createClient(URL, KEY, { auth: { persistSession: false } })

// ── deterministic pseudo-random so re-seeds are identical ────────────────────
let _s = 1234567
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff }
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]
const some = <T,>(a: T[], n: number): T[] => { const c = [...a]; const o: T[] = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o }

const SETUPS = ['Break & Retest', 'Trend Pullback', 'Range Reversal', 'VWAP Reclaim', 'Failed Breakout']
const CONFLUENCES = ['HTF Trend', 'VWAP', 'Prior Day High', 'Round Number', 'IB Extension']
const ORDER_FLOW = ['Absorption', 'Delta Divergence', 'Stacked Bids', 'Aggressive Sellers']
const MGMT = ['Scaled Out', 'Moved to BE', 'Held Runner', 'Full Stop']
const EMOTIONS = ['Calm', 'Patient', 'Confident', 'FOMO', 'Frustrated']
const MISTAKES = ['Chased Entry', 'Early Exit', 'Oversized']
const DAY_TYPES = ['Trend', 'Range', 'Reversal']

const TAG_LIBRARY: Array<[string, string[]]> = [
  ['setups', SETUPS], ['confluences', CONFLUENCES], ['order_flow', ORDER_FLOW],
  ['trade_management', MGMT], ['emotions', EMOTIONS], ['mistakes', MISTAKES], ['day_type', DAY_TYPES],
]

// Trading days spread across ~5 weeks so Week / Month / 30d selectors all populate.
const DAYS = [
  '2026-06-01', '2026-06-03', '2026-06-05', '2026-06-10', '2026-06-12',
  '2026-06-17', '2026-06-19', '2026-06-24', '2026-06-26', '2026-07-01', '2026-07-02',
]

async function getOrCreateUser(): Promise<string> {
  // find existing
  let page = 1
  for (;;) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 200 })
    const hit = (data?.users || []).find((u: { email?: string }) => (u.email || '').toLowerCase() === DEMO_EMAIL)
    if (hit) return hit.id
    if (!data || data.users.length < 200) break
    page++
  }
  if (!commit) { console.log('[dry] would create user', DEMO_EMAIL); return '(dry-run-uid)' }
  const { data, error } = await sb.auth.admin.createUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true })
  if (error) throw new Error('createUser: ' + error.message)
  console.log('created user', data.user.id)
  return data.user.id
}

async function wipe(uid: string) {
  // delete children first (FK), then days. trades cascade via trading_day_id in
  // some schemas, but delete explicitly to be safe.
  const { data: days } = await sb.from('trading_days').select('id').eq('user_id', uid)
  const dayIds = (days || []).map((d: { id: string }) => d.id)
  if (dayIds.length) {
    await sb.from('trades').delete().in('trading_day_id', dayIds)
    await sb.from('market_context').delete().in('trading_day_id', dayIds)
  }
  await sb.from('trading_days').delete().eq('user_id', uid)
  await sb.from('trade_tags').delete().eq('user_id', uid)
  console.log(`wiped ${dayIds.length} existing demo days`)
}

async function seed(uid: string) {
  // Tag library (best-effort — feeds the Settings → Tags list).
  const tagRows = TAG_LIBRARY.flatMap(([category, labels]) =>
    labels.map((label, i) => ({ category, label, sort_order: i, user_id: uid })))
  const { error: te } = await sb.from('trade_tags').insert(tagRows)
  if (te) console.warn('  trade_tags insert skipped:', te.message)

  let price = 20100
  let totalTrades = 0
  for (const date of DAYS) {
    price += Math.round((rnd() - 0.45) * 120) // gentle drift across the month
    const nTrades = 1 + Math.floor(rnd() * 3) // 1..3
    const dayType = pick(DAY_TYPES)

    const { data: day, error: de } = await sb.from('trading_days')
      .insert({ user_id: uid, date, day_type: dayType, day_types: [dayType] })
      .select('id').single()
    if (de) throw new Error(`day ${date}: ${de.message}`)
    const dayId = day.id

    let dayPnl = 0
    for (let i = 0; i < nTrades; i++) {
      const isLong = rnd() > 0.4
      const dir = isLong ? 'long' : 'short'
      const qty = 2 + Math.floor(rnd() * 4) // 2..5
      const entry = price + Math.round((rnd() - 0.5) * 40)
      const stopPts = 25 + Math.round(rnd() * 35)
      const tpPts = 50 + Math.round(rnd() * 80)
      const win = rnd() > 0.42
      const movePts = win ? Math.round(tpPts * (0.5 + rnd() * 0.6)) : -Math.round(stopPts * (0.6 + rnd() * 0.6))
      const exit = entry + (isLong ? movePts : -movePts)
      const pnl = Math.round(movePts * qty * 2) // MNQ = $2/pt
      dayPnl += pnl
      const stop = entry + (isLong ? -stopPts : stopPts)
      const tp1 = entry + (isLong ? tpPts : -tpPts)
      // MFE/MAE envelope around the fill
      const favPts = Math.max(Math.abs(movePts), 0) + Math.round(rnd() * 25)
      const advPts = Math.round(rnd() * stopPts * 0.8)
      const high = isLong ? entry + favPts : entry + advPts
      const low = isLong ? entry - advPts : entry - favPts

      const hh = 13 + i // stagger 13:00, 14:00 … UTC (RTH)
      const entryTime = `${date}T${String(hh).padStart(2, '0')}:${String(5 + Math.floor(rnd() * 40)).padStart(2, '0')}:00Z`
      const exitTime = `${date}T${String(hh).padStart(2, '0')}:${String(45 + Math.floor(rnd() * 14)).padStart(2, '0')}:00Z`

      const tags = {
        setups: some(SETUPS, 1 + Math.floor(rnd() * 2)),
        confluences: some(CONFLUENCES, 1 + Math.floor(rnd() * 2)),
        order_flow: some(ORDER_FLOW, Math.floor(rnd() * 2)),
        trade_management: some(MGMT, 1),
        day_type: dayType,
        mistakes: win ? [] : some(MISTAKES, rnd() > 0.6 ? 1 : 0),
        emotions: some(EMOTIONS, 1),
      }

      const { error: tre } = await sb.from('trades').insert({
        trading_day_id: dayId, user_id: uid, symbol: 'MNQ', direction: dir, quantity: qty,
        entry_price: entry, exit_price: exit, stop_price: stop, tp1_price: tp1, pnl,
        entry_time: entryTime, exit_time: exitTime,
        high_during_position: high, low_during_position: low,
        mfe_dollars_per_leg: Math.round(favPts * 2),
        tags_json: tags,
        notes: win ? 'Clean read, let the runner work.' : 'Thesis invalidated, stop did its job.',
      })
      if (tre) throw new Error(`trade ${date}#${i}: ${tre.message}`)
      totalTrades++
    }

    // EOD summary + market context (synthetic).
    await sb.from('trading_days').update({
      eod_pnl: dayPnl,
      eod_notes: dayPnl >= 0
        ? `Solid ${dayType.toLowerCase()} day — followed the plan, took what the tape gave.`
        : `${dayType} day that didn't cooperate. Losses were controlled; no rule breaks.`,
    }).eq('id', dayId)

    const { error: mce } = await sb.from('market_context').insert({
      trading_day_id: dayId, user_id: uid, symbol: 'MNQ',
      pdh: price + 90, pdl: price - 85, ibh: price + 55, ibl: price - 50,
      onh: price + 130, onl: price - 120,
      rvol: Math.round((0.8 + rnd() * 0.7) * 100) / 100,
      ib_size: 90 + Math.round(rnd() * 70),
      adr: 230 + Math.round(rnd() * 60),
      day_range: 150 + Math.round(rnd() * 120),
      atr_1m: Math.round((6 + rnd() * 5) * 10) / 10,
    })
    if (mce) console.warn(`  market_context ${date} skipped:`, mce.message)
  }
  console.log(`seeded ${DAYS.length} days, ${totalTrades} trades`)
}

async function main() {
  console.log(`\n=== seed-demo (${commit ? 'COMMIT' : 'DRY RUN'}${teardown ? ', TEARDOWN' : ''}) → ${PUBLIC_REF} ===`)
  const uid = await getOrCreateUser()

  if (teardown) {
    if (!commit) { console.log('[dry] would wipe demo data + delete user'); return }
    await wipe(uid)
    await sb.auth.admin.deleteUser(uid)
    console.log('demo user deleted')
    return
  }

  if (!commit) {
    console.log(`[dry] would seed ${DAYS.length} days of synthetic trades for ${DEMO_EMAIL}`)
    console.log('[dry] re-run with --commit to write')
    return
  }
  await wipe(uid) // idempotent re-seed
  await seed(uid)
  console.log('\nDONE. Demo user ready:', DEMO_EMAIL)
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
