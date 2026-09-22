// One-shot FOUNDER-scoped achievements backfill against the PUBLIC Supabase.
//
// Mirrors POST /api/achievements/backfill exactly (same fetch shapes, same
// computeDayIds engine), but runs locally with the service-role key from
// .env.public-feed — so where the route relies on RLS, every read AND write
// here is explicitly scoped to the owner's user_id. Written for Pt 7 because
// the route needs an owner-authenticated browser session; this is the
// headless equivalent. Idempotent: re-running just overwrites with the same
// freshly computed ids (identical to re-POSTing the route).
//
// Usage:
//   npx tsx scripts/backfill-achievements-public.ts            # discovery + dry-run (no writes)
//   npx tsx scripts/backfill-achievements-public.ts --apply    # write achievements_json
//
// With no --apply it lists every auth user with their trading_days count,
// picks the one with the most days as the presumed founder, and prints the
// counts it WOULD write. Check the output, then re-run with --apply.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { computeDayIds, type AchievementDayRow } from '../src/lib/achievements-server.ts'
import { achievementCounts, type AchievementTrade } from '../src/lib/achievements.ts'

for (const l of readFileSync('.env.public-feed', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^([A-Z_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const sb = createClient(
  process.env.PUBLIC_SUPABASE_URL!,
  process.env.PUBLIC_SUPABASE_SERVICE_ROLE_KEY!,
)

const APPLY = process.argv.includes('--apply')
const PAGE = 1000

/** Same paging pattern as the route's fetchAll, plus the explicit user_id
 *  scope the service-role client doesn't get from RLS. */
async function fetchAllScoped<T>(table: string, columns: string, userId: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...(data as T[]))
    if (data.length < PAGE) break
  }
  return out
}

async function main() {
  // Discovery: every auth user + their trading_days count. The founder is the
  // account holding the migrated personal history (by far the most days).
  const { data: usersPage, error: usersErr } = await sb.auth.admin.listUsers({ perPage: 100 })
  if (usersErr) throw usersErr
  const users = usersPage.users
  const withCounts: { id: string; email: string; days: number }[] = []
  for (const u of users) {
    const { count } = await sb
      .from('trading_days')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', u.id)
    withCounts.push({ id: u.id, email: u.email ?? '(no email)', days: count ?? 0 })
  }
  withCounts.sort((a, b) => b.days - a.days)
  console.log('auth users by trading_days count:')
  for (const u of withCounts) console.log(`  ${u.days.toString().padStart(4)}  ${u.email}  ${u.id}`)

  const owner = withCounts[0]
  if (!owner || owner.days === 0) throw new Error('No user with trading_days rows found.')
  console.log(`\nfounder = ${owner.email} (${owner.days} days)\n`)

  // Same three pulls as the route, founder-scoped.
  const days = await fetchAllScoped<AchievementDayRow>('trading_days', 'id, date, eod_pnl', owner.id)
  const trades = await fetchAllScoped<AchievementTrade & { trading_day_id: string }>('trades', '*', owner.id)
  const contexts = await fetchAllScoped<{ trading_day_id: string; day_range: number | null }>(
    'market_context', 'trading_day_id, day_range', owner.id,
  )
  console.log(`fetched: ${days.length} days, ${trades.length} trades, ${contexts.length} contexts`)

  const tradesByDay = new Map<string, AchievementTrade[]>()
  for (const t of trades) {
    const arr = tradesByDay.get(t.trading_day_id)
    if (arr) arr.push(t)
    else tradesByDay.set(t.trading_day_id, [t])
  }
  const rangeByDay = new Map<string, number | null>()
  for (const ctx of contexts) rangeByDay.set(ctx.trading_day_id, ctx.day_range)
  const pnlHistory = days
    .filter(d => d.eod_pnl != null)
    .map(d => ({ date: d.date, pnl: d.eod_pnl as number }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const computed = days.map(day => ({
    id: day.id,
    date: day.date,
    ids: computeDayIds(day, tradesByDay.get(day.id) ?? [], pnlHistory, rangeByDay.get(day.id) ?? null),
  }))

  const counts = achievementCounts(computed.map(c => c.ids))
  const daysWithAny = computed.filter(c => c.ids.length > 0).length
  const totalEarned = computed.reduce((n, c) => n + c.ids.length, 0)
  console.log(`\ncomputed: ${daysWithAny}/${days.length} days earn ≥1 coin, ${totalEarned} total earns`)
  console.log('lifetime counts:', JSON.stringify(counts))
  console.log('\nmost recent 10 coin days:')
  for (const c of computed.filter(x => x.ids.length > 0).slice(-10)) {
    console.log(`  ${c.date}  ${c.ids.join(', ')}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to persist.')
    return
  }

  let updated = 0
  const CHUNK = 20
  for (let i = 0; i < computed.length; i += CHUNK) {
    const slice = computed.slice(i, i + CHUNK)
    await Promise.all(slice.map(async c => {
      const { error } = await sb
        .from('trading_days')
        .update({ achievements_json: c.ids })
        .eq('id', c.id)
        .eq('user_id', owner.id)
      if (!error) updated++
    }))
  }
  console.log(`\nAPPLIED: updated ${updated}/${computed.length} rows for ${owner.email}`)
}

main().catch(e => { console.error(e); process.exit(1) })
