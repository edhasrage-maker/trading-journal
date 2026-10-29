import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { COACH_SOURCES, type CoachSource } from '@/lib/coach-tag-audit'
import type { Pick } from '@/lib/coach-tag-audit-server'

export const dynamic = 'force-dynamic'

/**
 * The coach tag audit (src/lib/coach-tag-audit.ts) — the caller's own rows only.
 *
 * GET  ?trade=<id>  → { coach: string[] }   `category|label` of the tags the coach put on (the "coach" mark)
 *
 * POST { action: 'record', tradeId, picks: [{category,label,source}], before? }
 *        what the coach picked on a trade (the trade form, after a save)
 *      { action: 'keep',   tradeId, keys: string[] }   ✓ (one tag, or "All right")
 *      { action: 'remove', tradeId, key }              ✕ — the tag comes off the trade
 *      { action: 'undo',   tradeId, key }              back to "to check"
 */
const UUID = /^[0-9a-f-]{36}$/i
const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  const trade = new URL(req.url).searchParams.get('trade')
  if (!trade || !UUID.test(trade)) return NextResponse.json({ error: 'trade id required' }, { status: 400 })
  try {
    const { coachAppliedKeys } = await import('@/lib/coach-tag-audit-server')
    return NextResponse.json({ coach: await coachAppliedKeys(supabase, trade) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[coach-tags GET]', e)
    return NextResponse.json({ error: clientError(e, 'Could not read the coach tags.') }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const tradeId = str(body.tradeId, 36)
  if (!tradeId || !UUID.test(tradeId)) return NextResponse.json({ error: 'tradeId required' }, { status: 400 })
  try {
    const srv = await import('@/lib/coach-tag-audit-server')
    switch (body.action) {
      case 'record': {
        const picks: Pick[] = (Array.isArray(body.picks) ? body.picks : []).slice(0, 100).flatMap((p: Record<string, unknown>) => {
          const category = str(p?.category, 60), label = str(p?.label)
          const source = p?.source as CoachSource
          return category && label && COACH_SOURCES.includes(source) ? [{ category, label, source }] : []
        })
        const before = body.before && typeof body.before === 'object' && !Array.isArray(body.before) ? body.before as Record<string, unknown> : null
        return NextResponse.json(await srv.recordPicks(supabase, tradeId, picks, before))
      }
      case 'keep': {
        const keys = (Array.isArray(body.keys) ? body.keys : []).map(k => str(k, 260)).filter((k): k is string => !!k).slice(0, 100)
        await srv.keepTags(supabase, tradeId, keys)
        return NextResponse.json({ ok: true })
      }
      case 'remove':
      case 'undo': {
        const key = str(body.key, 260)
        if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })
        await (body.action === 'remove' ? srv.removeTag : srv.undoTag)(supabase, tradeId, key)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if ((await import('@/lib/coach-tag-audit-server')).tableMissing(err)) {
      return NextResponse.json({ error: 'The coach tag audit table isn’t set up yet.' }, { status: 503 })
    }
    console.error('[coach-tags POST]', e)
    return NextResponse.json({ error: clientError(e, 'Could not save that.') }, { status: 500 })
  }
}
