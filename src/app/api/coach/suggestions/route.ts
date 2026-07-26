/**
 * GET /api/coach/suggestions
 *
 * Deterministic "what should I work on?" topics for the coach's proactive
 * opener (Pt 11). Ranks the trader's weakest signals over the last 180 days and
 * returns up to 3 grounded, clickable improvement topics. NO model call — every
 * number is real and it can never invent a leak, so it costs no AI quota.
 *
 * Response: { items: Array<{ id, line, followUp }> }. Empty items[] on a clean
 * or brand-new account → the client falls back to its generic greeting.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { gatherCoachSignals, rankSuggestions } from '@/lib/coach-suggestions'

export async function GET() {
  try {
    const supabase = await createClient()
    const endDate = new Date().toISOString().slice(0, 10)
    const startDate = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const signals = await gatherCoachSignals(supabase, { startDate, endDate })
    const items = rankSuggestions(signals).map(({ id, line, followUp }) => ({ id, line, followUp }))
    return NextResponse.json({ items })
  } catch (e) {
    // Best-effort: a failure just yields no personalized opener (generic greeting).
    console.error('[coach/suggestions] failed:', e)
    return NextResponse.json({ items: [] })
  }
}
