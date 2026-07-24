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

async function main() {
  const { data: list } = await db.auth.admin.listUsers()
  const demo = (list?.users ?? []).find(u => (u.email ?? '').toLowerCase() === DEMO_EMAIL)
  if (!demo) throw new Error(`No user with email ${DEMO_EMAIL}`)

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

main().catch(e => { console.error(e); process.exit(1) })
