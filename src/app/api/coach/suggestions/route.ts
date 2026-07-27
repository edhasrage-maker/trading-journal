/**
 * GET /api/coach/suggestions
 *
 * Deterministic "what should I work on?" topics for the coach's proactive
 * opener (Pt 11). Ranks the trader's weakest signals AND the deep-dive
 * investigations, returning grounded, clickable improvement topics. NO model
 * call — every number is real and it can never invent a leak, so it costs no
 * AI quota.
 *
 * Response: { items: Array<{ id, line, followUp }> }. Empty items[] on a clean
 * or brand-new account → the client falls back to its generic greeting.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { gatherCoachSignals, rankSuggestions } from '@/lib/coach-suggestions'
import { fetchDiveRows } from '@/lib/deep-dive/gather'
import { diveSuggestions, runDives } from '@/lib/deep-dive/registry'

/** Topics shown in the opener. Dives usually out-score the tag signals, so this
 *  is one wider than the original 3 to leave room for both kinds. */
const MAX_TOPICS = 4

export async function GET() {
  try {
    const supabase = await createClient()
    const endDate = new Date().toISOString().slice(0, 10)
    const startDate = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10)

    // Two sources, one ranking. Signals are tag/day-derived over 180 days; dives
    // are deterministic investigations over the FULL book (a session-clock or
    // scale-out verdict off 90 days is mostly noise). Both score 0..1, so they
    // merge on severity and the strongest findings take the slots.
    const [signals, diveRows] = await Promise.all([
      gatherCoachSignals(supabase, { startDate, endDate }),
      fetchDiveRows(supabase).catch(() => [] as Awaited<ReturnType<typeof fetchDiveRows>>),
    ])
    const items = [
      ...rankSuggestions(signals, MAX_TOPICS),
      ...diveSuggestions(runDives(diveRows)),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TOPICS)
      .map(({ id, line, followUp }) => ({ id, line, followUp }))
    return NextResponse.json({ items })
  } catch (e) {
    // Best-effort: a failure just yields no personalized opener (generic greeting).
    console.error('[coach/suggestions] failed:', e)
    return NextResponse.json({ items: [] })
  }
}
