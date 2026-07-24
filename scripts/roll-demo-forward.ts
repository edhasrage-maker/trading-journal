/**
 * Roll the seeded demo account's data forward so the demo always looks live.
 *
 * The demo is the public shopfront — "Explore the demo" on tapescore.app drops a
 * prospect into a curated read-only account. Its data is seeded once and then
 * ages: by 2026-07-23 the newest session was 2026-07-09, so Prep opened on a day
 * with no bars, no conditions and no plan. The redesigned Prep leads with the
 * market read, which made that staleness the loudest thing on the page.
 *
 * This shifts every demo session forward so the most recent one lands on today.
 *
 * Two rules worth keeping:
 *   • Shift by a MULTIPLE OF 7 so weekday alignment survives — a Tuesday
 *     session has to stay on a Tuesday, or the demo shows trades on a Sunday.
 *   • Shift trade timestamps by the same delta so entry/exit times stay inside
 *     the session they belong to.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx scripts/roll-demo-forward.ts
 *   npx tsx scripts/roll-demo-forward.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')

const env = readFileSync('.env.public-feed', 'utf8')
const pick = (re: RegExp) => (env.split(/\r?\n/).find(l => re.test(l))?.split('=').slice(1).join('=').trim() ?? '')
  .replace(/^["']|["']$/g, '')
const db = createClient(pick(/SUPABASE_URL/), pick(/SERVICE_ROLE/), { auth: { persistSession: false } })

const DEMO_EMAIL = (process.env.NEXT_PUBLIC_DEMO_EMAIL || 'demo@tapescore.app').toLowerCase()

/** Today's PT session date — the demo should look current to a US-market visitor. */
function todayPT(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const shiftTs = (ts: string | null, days: number): string | null =>
  ts == null ? null : new Date(new Date(ts).getTime() + days * 86_400_000).toISOString()

/** Resolve the demo user.
 *
 *  The auth admin API can come back empty on a transient blip, and treating
 *  "empty list" as "user does not exist" produced a confidently wrong error.
 *  So: retry, distinguish an API failure from a genuine absence, print what it
 *  actually saw when it can't match, and allow --user-id=<uuid> to bypass the
 *  lookup entirely. */
async function findDemoUser(): Promise<{ id: string; email?: string }> {
  const override = process.argv.find(a => a.startsWith('--user-id='))?.split('=')[1]
  if (override) {
    console.log(`using --user-id override: ${override}`)
    return { id: override, email: DEMO_EMAIL }
  }
  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (error) {
      lastErr = error.message
      console.warn(`  listUsers attempt ${attempt}/3 failed: ${error.message}`)
      await new Promise(r => setTimeout(r, 600 * attempt))
      continue
    }
    const users = data?.users ?? []
    if (users.length === 0) {
      lastErr = 'auth returned zero users'
      console.warn(`  listUsers attempt ${attempt}/3 returned an empty list — retrying`)
      await new Promise(r => setTimeout(r, 600 * attempt))
      continue
    }
    const hit = users.find(u => (u.email ?? '').toLowerCase() === DEMO_EMAIL)
    if (hit) return hit
    console.error(`
Auth returned ${users.length} users, none matching "${DEMO_EMAIL}":`)
    for (const u of users) console.error(`   - ${u.email}`)
    console.error(`
Set NEXT_PUBLIC_DEMO_EMAIL, or pass --user-id=<uuid>.`)
    throw new Error('demo user not found')
  }
  throw new Error(`Could not reach the auth admin API after 3 attempts (${lastErr}). Retry, or pass --user-id=<uuid>.`)
}

async function main() {
  const demo = await findDemoUser()

  const { data: dayRows } = await db.from('trading_days')
    .select('id, date').eq('user_id', demo.id).order('date', { ascending: false })
  const days = (dayRows ?? []) as { id: string; date: string }[]
  if (days.length === 0) throw new Error('Demo account has no trading_days to roll')

  const latest = days[0].date
  const today = todayPT()
  const rawDelta = Math.round(
    (new Date(`${today}T12:00:00Z`).getTime() - new Date(`${latest}T12:00:00Z`).getTime()) / 86_400_000,
  )
  // Whole weeks only, so weekday alignment survives the shift.
  const delta = Math.floor(rawDelta / 7) * 7

  console.log(`demo user   : ${demo.email} ${demo.id}`)
  console.log(`sessions    : ${days.length}  (${days[days.length - 1].date} → ${latest})`)
  console.log(`today (PT)  : ${today}`)
  console.log(`gap         : ${rawDelta} days → shifting by ${delta} (whole weeks)`)

  if (delta <= 0) {
    console.log('\nAlready current — nothing to do.')
    return
  }

  const dayIds = days.map(d => d.id)
  const { data: tradeRows } = await db.from('trades')
    .select('id, entry_time, exit_time').in('trading_day_id', dayIds)
  const trades = (tradeRows ?? []) as { id: string; entry_time: string | null; exit_time: string | null }[]

  const { data: prepRows } = await db.from('daily_prep')
    .select('id, date').eq('user_id', demo.id)
  const preps = (prepRows ?? []) as { id: string; date: string }[]

  console.log(`\nwould shift : ${days.length} sessions, ${trades.length} trades, ${preps.length} condition snapshots`)
  console.log(`newest session ${latest} → ${addDays(latest, delta)}`)
  console.log(`oldest session ${days[days.length - 1].date} → ${addDays(days[days.length - 1].date, delta)}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.')
    return
  }

  // Descending date order: the target range sits entirely beyond the current
  // range, but writing newest-first means a (user_id, date) unique index can
  // never see a transient collision even if that stops being true.
  for (const d of days) {
    const { error } = await db.from('trading_days')
      .update({ date: addDays(d.date, delta) }).eq('id', d.id)
    if (error) throw new Error(`trading_days ${d.date}: ${error.message}`)
  }
  console.log(`shifted ${days.length} sessions`)

  for (const t of trades) {
    const { error } = await db.from('trades').update({
      entry_time: shiftTs(t.entry_time, delta),
      exit_time: shiftTs(t.exit_time, delta),
    }).eq('id', t.id)
    if (error) throw new Error(`trade ${t.id}: ${error.message}`)
  }
  console.log(`shifted ${trades.length} trades`)

  for (const p of preps) {
    const { error } = await db.from('daily_prep')
      .update({ date: addDays(p.date, delta) }).eq('id', p.id)
    if (error) console.warn(`daily_prep ${p.date}: ${error.message}`)
  }
  console.log(`shifted ${preps.length} condition snapshots`)

  console.log('\nDone. The demo now runs through today.')
  console.log('NB the condition lookup rebuilds on the nightly cron; its buckets are date-independent.')
}

main().catch(e => { console.error(`
${e instanceof Error ? e.message : e}`); process.exitCode = 1 })
