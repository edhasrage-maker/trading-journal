import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * POST /api/trades/rule-tags   body: { ids?: string[] }   (at most 200 ids)
 *   → { checked, changed, tags: { [tradeId]: string[] } }
 *
 * Brings the app's rule mistake tags up to date (src/lib/rule-tags.ts,
 * src/lib/rule-tags-server.ts): a rule that fails and counts on a trade puts
 * its mistake tag on it; a tag the app added for a rule that no longer fails
 * comes off; tags the trader added are never touched. With `ids`, just those
 * trades (the Recap and the Log after their entry snapshots are read); without,
 * every trade the trader's rules reach (after a rule change in Settings).
 * The caller's own rows only (their session client; RLS).
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  let body: { ids?: unknown }
  try { body = await req.json() } catch { body = {} }
  let ids: string[] | undefined
  if (body?.ids !== undefined) {
    ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))]
    if (ids.length > 200) return NextResponse.json({ error: 'at most 200 trades per request' }, { status: 400 })
  }
  try {
    const { applyRuleTags } = await import('@/lib/rule-tags-server')
    const res = await applyRuleTags(supabase, ids)
    return NextResponse.json(res, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[trades/rule-tags]', e)
    return NextResponse.json({ error: clientError(e, 'Could not update the rule tags.') }, { status: 500 })
  }
}
