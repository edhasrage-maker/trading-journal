/**
 * Tests for the launch funnel recorder (src/lib/funnel.ts): who counts, when
 * "came back" is recorded, which landing visits count, and that a failing
 * database never breaks the request. Pure: a stand-in Supabase client, no
 * network.
 *
 *   npx tsx scripts/test-funnel.ts   (also wired into `npm test`)
 */
// Set before the module loads: the hosted build (the local one never records).
process.env.NEXT_PUBLIC_ENABLE_LOCAL_FEATURES = 'false'
process.env.ADMIN_EMAIL = 'Owner@TapeScore.app'

let failures = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
}

type Call = { table?: string; rows?: Record<string, unknown>[]; opts?: Record<string, unknown>; rpc?: string }
function fakeClient() {
  const calls: Call[] = []
  return {
    calls,
    from: (table: string) => ({
      upsert: (rows: Record<string, unknown>[], opts: Record<string, unknown>) => {
        calls.push({ table, rows, opts })
        return Promise.resolve({ error: null })
      },
    }),
    rpc: (name: string) => { calls.push({ rpc: name }); return Promise.resolve({ error: null }) },
  }
}

const DAY = 86_400_000
const trader = (createdMsAgo: number, email = 'new.trader@example.com') =>
  ({ id: 'u1', email, created_at: new Date(Date.now() - createdMsAgo).toISOString() })

async function main() {
  const { recordAppVisit, recordFunnelEvent, recordLandingVisit } = await import('../src/lib/funnel.ts')

  console.log('app visits')
  {
    const db = fakeClient()
    const user = trader(60_000)
    await recordAppVisit(db, user)
    const rows = db.calls[0]?.rows ?? []
    check('a visit on the sign-up day records only the sign-up', rows.length === 1 && rows[0].event === 'signed_up', rows)
    check('the sign-up is dated to the account creation', rows[0]?.created_at === user.created_at)
    check('written once per account (ignore duplicates on user_id,event)',
      db.calls[0]?.table === 'funnel_events' && db.calls[0]?.opts?.onConflict === 'user_id,event' && db.calls[0]?.opts?.ignoreDuplicates === true)
  }
  {
    const db = fakeClient()
    await recordAppVisit(db, trader(3 * DAY))
    const events = (db.calls[0]?.rows ?? []).map(r => r.event)
    check('a visit days later also records "came back"', JSON.stringify(events) === '["signed_up","came_back"]', events)
  }

  console.log('who counts')
  {
    const db = fakeClient()
    await recordAppVisit(db, trader(3 * DAY, 'demo@tapescore.app'))
    await recordAppVisit(db, trader(3 * DAY, 'owner@tapescore.app'))
    await recordFunnelEvent(db, trader(DAY, 'OWNER@tapescore.app'), 'first_trades')
    await recordFunnelEvent(db, null, 'first_score')
    check('the demo, the admin (any case) and a missing user record nothing', db.calls.length === 0, db.calls)
  }
  {
    const db = fakeClient()
    await recordFunnelEvent(db, trader(DAY), 'first_score')
    check('a milestone is one row for this account', db.calls[0]?.rows?.[0]?.event === 'first_score' && db.calls[0]?.rows?.[0]?.user_id === 'u1')
  }

  console.log('landing visits')
  {
    const db = fakeClient()
    await recordLandingVisit(db, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
    check('a browser visit bumps today\'s count', db.calls.length === 1 && db.calls[0].rpc === 'record_landing_visit')
    await recordLandingVisit(db, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')
    await recordLandingVisit(db, 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')
    await recordLandingVisit(db, 'vercel-screenshot/1.0')
    await recordLandingVisit(db, null)
    check('crawlers, link previews and no user agent are not counted', db.calls.length === 1, db.calls.length)
  }

  console.log('never breaks the request')
  {
    const broken = {
      from: () => ({ upsert: () => { throw new Error('relation "funnel_events" does not exist') } }),
      rpc: () => { throw new Error('function does not exist') },
    }
    let threw = false
    try {
      await recordAppVisit(broken, trader(3 * DAY))
      await recordFunnelEvent(broken, trader(DAY), 'first_trades')
      await recordLandingVisit(broken, 'Mozilla/5.0 Chrome/130.0')
    } catch { threw = true }
    check('a missing table or function is swallowed', !threw)
  }

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`)
    process.exit(1)
  }
  console.log('\nall funnel tests passed')
}

void main()
