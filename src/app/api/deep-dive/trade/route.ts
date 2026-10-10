import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient, isServiceConfigured } from '@/lib/supabase/service'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import { resolveRubric, type ScoringProfile } from '@/lib/scoring-profile'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * GET /api/deep-dive/trade?id=<trade uuid>&blind=1
 *   → DeepDivePayload (src/lib/orderflow/server/deep-dive-payload.ts)
 *
 * The Deep Dive workspace for one trade, exactly as it looked at the fill.
 *
 * blind=1 (the DEFAULT — anything but an explicit blind=0 is blind): the
 * response is cut on the server. Only entry-time columns are even selected from
 * the trade (no exit, P&L, notes, tags, screenshot), and the market data ends
 * before the fill second. The client is never trusted to hide anything.
 *
 * blind=0: the non-blind deep chart review — data runs on past the last exit,
 * with the exit fills for the markers.
 *
 * ACCESS. A private beta on the hosted site: only the emails in
 * DEEP_DIVE_BETA_EMAILS (deep-dive-access.ts). Everyone else gets a 404, the
 * same as a route that doesn't exist. The trade itself is read through the
 * caller's own session, so RLS scopes it to them.
 *
 * DATA. Local build: Sierra .scid files on this machine. Hosted build: the
 * tick tape the feed publishes to a private bucket, read here with the server
 * key — market data only, never another user's rows — and cut in memory.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id') ?? ''
  const blind = searchParams.get('blind') !== '0'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id=<trade uuid> required' }, { status: 400 })

  const { BLIND_TRADE_COLUMNS, FULL_TRADE_COLUMNS, buildDeepDivePayload, buildDeepDivePayloadFromTape, DeepDiveError } =
    await import('@/lib/orderflow/server/deep-dive-payload')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns newer than the generated types
  const { data: row, error } = await (supabase as any)
    .from('trades').select(blind ? BLIND_TRADE_COLUMNS : FULL_TRADE_COLUMNS).eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'trade not found' }, { status: 404 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- trader_profile is newer than the generated types
  const { data: profRow } = await (supabase as any)
    .from('trader_profile').select('scoring_profile_json').eq('id', 'default').maybeSingle()
  const sp = (profRow?.scoring_profile_json && typeof profRow.scoring_profile_json === 'object'
    ? profRow.scoring_profile_json : null) as ScoringProfile | null
  const rubric = resolveRubric(sp)
  const opts = { blind, atrStopTarget: rubric.atrStopTarget, tp1RMultiple: rubric.tp1RMultiple }

  try {
    let payload
    if (LOCAL_FEATURES_ENABLED) {
      payload = buildDeepDivePayload(row, opts)
    } else {
      if (!isServiceConfigured()) return NextResponse.json({ error: 'Deep Dive is not set up on this deployment yet.' }, { status: 503 })
      const { supabaseTapeStore } = await import('@/lib/orderflow/server/tape-store')
      payload = await buildDeepDivePayloadFromTape(row, opts, supabaseTapeStore(createServiceClient()))
    }
    return NextResponse.json({ ...payload, uses_order_flow: rubric.usesOrderFlow }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof DeepDiveError) return NextResponse.json({ error: e.message }, { status: e.status })
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: `could not build the deep dive: ${msg}` }, { status: 500 })
  }
}
