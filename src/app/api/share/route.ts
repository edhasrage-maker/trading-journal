import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * POST /api/share  { trading_day_id }
 *
 * Mints (or reuses) a coach-review share link for one trading day. Owner RLS on
 * `shares` scopes creation to the signed-in user; user_id fills from the column
 * default. The public /share/<token> page reads via the token-gated
 * get_shared_day() RPC, so nothing else is exposed.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  // Stale generated types resolve these inserts to `never` (known supabase-js
  // quirk the rest of the codebase works around); use an untyped handle.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  const body = await req.json().catch(() => ({}))
  const tradingDayId = body.trading_day_id
  if (!tradingDayId) {
    return NextResponse.json({ error: 'trading_day_id required' }, { status: 400 })
  }

  // Reuse an existing active link for this day so re-clicking Share doesn't
  // spawn duplicates.
  const { data: existing } = await db
    .from('shares')
    .select('token')
    .eq('trading_day_id', tradingDayId)
    .eq('revoked', false)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let token: string | undefined = existing?.token
  if (!token) {
    const { data: created, error } = await db
      .from('shares')
      .insert({ trading_day_id: tradingDayId })
      .select('token')
      .single()
    if (error || !created) {
      return NextResponse.json(
        { error: `Failed to create share: ${error?.message ?? 'unknown error'}` },
        { status: 500 },
      )
    }
    token = created.token as string
  }

  const origin = new URL(req.url).origin
  return NextResponse.json({ token, url: `${origin}/share/${token}` })
}
