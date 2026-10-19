import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { deepDiveAllowed } from '@/lib/deep-dive-access'
import { resolveScreenshotUrls } from '@/lib/storage-url'
import { tradeTagGroups, type TagGroup } from '@/lib/trade-tag-groups'

export const dynamic = 'force-dynamic'

export interface ReplayDetails {
  /** Signed screenshot URL, or null when the trade has none. */
  screenshot: string | null
  tags: TagGroup[]
}

const UUID = /^[0-9a-f-]{36}$/i

/**
 * GET /api/deep-dive/details?id=<trade uuid>  → ReplayDetails
 *
 * Replay Review's "Your trade" panel: the trade's screenshot and tags. Both can
 * give the result away (a live Sierra screenshot shows the open P&L; a Mistake
 * tag says how it went), so the workspace asks for this only in Full review,
 * never in Blind. Same private beta as the page; RLS scopes the row.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  if (!deepDiveAllowed(user.email)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!UUID.test(id)) return NextResponse.json({ error: 'id=<trade uuid> required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose client, matching the other Replay routes
  const { data: row, error } = await (supabase as any)
    .from('trades').select('screenshot_url, tags_json').eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'trade not found' }, { status: 404 })

  const [screenshot] = await resolveScreenshotUrls(supabase, [row.screenshot_url])
  const out: ReplayDetails = { screenshot: screenshot ?? null, tags: tradeTagGroups(row.tags_json) }
  return NextResponse.json(out, { headers: { 'Cache-Control': 'no-store' } })
}
