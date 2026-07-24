/**
 * Seed prep notes onto the demo account's most recent sessions.
 *
 * WHY: the demo is the public shopfront, and its seeded sessions carry trades
 * and market context but an EMPTY prep_notes_json. After the redesign, Prep
 * leads with the read and the trader's own stance — so a prospect landed on a
 * page with a real market read and blank everything else.
 *
 * WHAT A PROSPECT WILL READ: this is synthetic content presented as one
 * trader's notes. It is written to be plausible and *unflattering where the
 * data is unflattering* — the −$844 session admits to feeling rushed and to not
 * holding the commitment. A demo that only shows good days teaches nothing and
 * reads as marketing. The account is labelled read-only demo in the UI.
 *
 * COHERENCE RULES followed here — a sharp prospect will cross-check:
 *   • Notes are written as BEFORE the session. No note references its outcome.
 *   • Bias matches the directions actually traded that day.
 *   • Named plans use setups that actually appear in that day's trade tags.
 *   • The tracked commitment is exactly what computeCarryover produces for this
 *     account ("26% captured across 25 trades"), so the bridge stays consistent
 *     with the engine rather than telling a different story.
 *
 * Sessions are addressed by RANK (0 = most recent), not by date, so this works
 * whether or not roll-demo-forward.ts has already shifted the dates.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx scripts/seed-demo-prep.ts
 *   npx tsx scripts/seed-demo-prep.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import type { PrepNotes } from '../src/lib/supabase/types'

const APPLY = process.argv.includes('--apply')

const env = readFileSync('.env.public-feed', 'utf8')
const pick = (re: RegExp) => (env.split(/\r?\n/).find(l => re.test(l))?.split('=').slice(1).join('=').trim() ?? '')
  .replace(/^["']|["']$/g, '')
const db = createClient(pick(/SUPABASE_URL/), pick(/SERVICE_ROLE/), { auth: { persistSession: false } })

const DEMO_EMAIL = (process.env.NEXT_PUBLIC_DEMO_EMAIL || 'demo@tapescore.app').toLowerCase()

// The finding the live engine actually computes for this account. Reused so the
// seeded commitment and the computed bridge never contradict each other.
const FINDING = {
  key: 'exec:capture',
  mode: 'correct' as const,
  source: 'last 60 sessions',
  finding: 'You kept less than half of the move you were offered',
  metric: '26% captured across 25 trades',
  today: 'Hold to your planned target before taking anything off.',
}

// ── The content, per session rank (0 = most recent = "today" after the roll) ──
const SEED: Array<{ rank: number; label: string; notes: PrepNotes }> = [
  {
    rank: 0,
    label: 'today — two-sided reversal day, VWAP Reclaim + Trend Pullback',
    notes: {
      session: 'rth',
      bias: 'neutral',
      bias_notes:
        'Overnight pushed above yesterday’s high and faded straight back into the range. '
        + 'Two-sided so far — I want to see which side fails before I commit size.',
      mood: 'Focused',
      market_clarity:
        'Clear enough at the edges. The middle of this range is where I get chopped up, so I’m not trading it.',
      day_stance: 'caution',
      day_stance_source: 'trader',
      day_read: 'Two-sided tape inside yesterday’s range — trade the edges, skip the middle.',
      trade_plans: [
        {
          id: 'demo-plan-vwap-reclaim',
          direction: 'long',
          setup_name: 'VWAP Reclaim',
          quality: 4,
          quality_reasons: ['Level has held twice this week', 'Only taking it if it reclaims and holds'],
          invalidation: 'Loses VWAP and puts in two closes below it',
          targets: 'Prior-day high, then 2R',
          scary_factors: 'Reclaims on thin volume and immediately stalls',
        },
        {
          id: 'demo-plan-trend-pullback',
          direction: 'short',
          setup_name: 'Trend Pullback',
          quality: 3,
          quality_reasons: ['Only if the overnight high fails first'],
          invalidation: 'Reclaims the overnight high and accepts above it',
          targets: 'Back to the overnight low',
          scary_factors: 'I’d be fading a market that hasn’t actually failed yet',
        },
      ],
      // Pre-tracked: the demo session is read-only, so a visitor clicking
      // "Track this today" would hit the 403 gate. Showing it already tracked
      // demonstrates the state without offering a dead control.
      commitment: {
        ...FINDING,
        tracked_at: new Date().toISOString(),
      },
    },
  },
  {
    rank: 1,
    label: 'compressed range, Failed Breakout + Break & Retest — commitment HELD',
    notes: {
      session: 'rth',
      bias: 'neutral',
      bias_notes:
        'Tight overnight range, no extension either way. Expecting a breakout attempt that fails '
        + 'before it goes anywhere — that’s the trade, not the break itself.',
      mood: 'Calm',
      market_clarity: 'Yes. Compressed and directionless is a read, not an absence of one.',
      day_stance: 'caution',
      day_stance_source: 'trader',
      day_read: 'Compressed — wait for a failed push, don’t chase the first break.',
      commitment: {
        ...FINDING,
        tracked_at: new Date().toISOString(),
        resolved: 'followed',
        resolved_at: new Date().toISOString(),
      },
    },
  },
  {
    rank: 2,
    label: 'the −$844 session — fast tape, felt rushed, commitment NOT held',
    notes: {
      session: 'rth',
      bias: 'bullish',
      bias_notes:
        'Strong overnight drive with higher lows the whole way up. Looking to buy the first '
        + 'pullback that holds. It’s already extended, which is the part I don’t love.',
      mood: 'Rushed',
      market_clarity:
        'Less clear than I’d like. It’s moving quickly and I notice I’m reacting to it rather than waiting.',
      day_stance: 'go',
      day_stance_source: 'trader',
      day_read: 'Fast, one-directional tape — but it has already covered a lot of ground.',
      commitment: {
        ...FINDING,
        tracked_at: new Date().toISOString(),
        resolved: 'not_followed',
        resolved_at: new Date().toISOString(),
      },
    },
  },
  {
    rank: 3,
    label: 'rotational range day, single Trend Pullback long',
    notes: {
      session: 'rth',
      bias: 'bullish',
      bias_notes:
        'Balanced profile and price sitting near the low end of the range. Buying the reclaim '
        + 'if it holds, and only there.',
      mood: 'Calm',
      market_clarity: 'Yes — rotational, and the edges are well defined.',
      day_stance: 'go',
      day_stance_source: 'trader',
      day_read: 'Rotational — buy the low end, sell the high end, nothing in the middle.',
    },
  },
]

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
    .select('id, date, prep_notes_json')
    .eq('user_id', demo.id).order('date', { ascending: false })
  const days = (dayRows ?? []) as { id: string; date: string; prep_notes_json: PrepNotes | null }[]

  console.log(`demo user : ${demo.email}`)
  console.log(`sessions  : ${days.length} (newest ${days[0]?.date})\n`)

  for (const entry of SEED) {
    const day = days[entry.rank]
    if (!day) {
      console.warn(`rank ${entry.rank}: no session — skipped`)
      continue
    }
    const existing = Object.keys(day.prep_notes_json ?? {}).length
    console.log(`rank ${entry.rank}  ${day.date}  (${existing} existing fields → ${Object.keys(entry.notes).length})`)
    console.log(`   ${entry.label}`)
    console.log(`   stance "${entry.notes.day_stance}" · bias "${entry.notes.bias}" · mood "${entry.notes.mood}"`
      + (entry.notes.commitment
        ? ` · commitment ${entry.notes.commitment.resolved ?? 'tracked'}`
        : ''))

    if (!APPLY) continue

    // Merge, don't clobber: keep anything already written on the row.
    const merged: PrepNotes = { ...(day.prep_notes_json ?? {}), ...entry.notes }
    const { error } = await db.from('trading_days')
      .update({ prep_notes_json: merged }).eq('id', day.id)
    if (error) throw new Error(`rank ${entry.rank} (${day.date}): ${error.message}`)
  }

  console.log(APPLY
    ? '\nWritten. The demo’s Prep now reads as a real trader’s prep.'
    : '\nDRY RUN — nothing written. Re-run with --apply to commit.')
}

main().catch(e => { console.error(`
${e instanceof Error ? e.message : e}`); process.exitCode = 1 })
