import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { todayPT } from '@/lib/pt-time'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nav-anchor → { anchor, today, prepToday, lastTradeDate }
 *
 * The date the review tabs (Intraday / EOD / Weekly) should default to when the
 * user isn't already on a dated route:
 *   - `today` once today's Daily Prep has been started (trading_days.prep_notes_json
 *     for today is non-empty) — you're focused on today.
 *   - otherwise the most recent day you actually traded — so the tabs land on your
 *     last session instead of an empty today.
 * RLS scopes everything to the signed-in user, so the anchor is per-user.
 */
export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = await createClient()
  const today = todayPT()

  // Has today's prep been started? (non-empty prep_notes_json on today's day)
  let prepToday = false
  try {
    const { data } = await supabase
      .from('trading_days')
      .select('prep_notes_json')
      .eq('date', today)
      .maybeSingle()
    const p = data?.prep_notes_json
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      prepToday = Object.values(p).some(v =>
        typeof v === 'string' ? v.trim() !== '' :
        typeof v === 'number' ? Number.isFinite(v) :
        Array.isArray(v) ? v.length > 0 :
        v != null && v !== false,
      )
    }
  } catch { /* best-effort — fall back to last-traded */ }

  // Most recent day that has trades.
  let lastTradeDate: string | null = null
  try {
    const { data } = await supabase
      .from('trading_days')
      .select('date, trades!inner(id)')
      .order('date', { ascending: false })
      .limit(1)
    lastTradeDate = data?.[0]?.date ?? null
  } catch { /* best-effort */ }

  const anchor = prepToday ? today : (lastTradeDate ?? today)
  return NextResponse.json({ anchor, today, prepToday, lastTradeDate })
}
