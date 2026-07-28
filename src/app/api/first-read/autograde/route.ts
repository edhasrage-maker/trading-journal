/**
 * GET /api/first-read/autograde → the payload needed to grade the trader's most
 * recent session, or `{ date: null }` when there's nothing to do.
 *
 * WHY THIS EXISTS. A TapeScore only comes from the end-of-day read, which runs
 * per session and on request — so a journal that has just imported its history
 * has a score on exactly zero days, and the product's headline number is blank
 * at the one moment it most needs to land. The import flow uses this to grade
 * the newest session automatically, so the first dashboard has a real score on
 * it instead of an invitation to go and get one.
 *
 * It returns DATA rather than doing the analysis, so the caller can reuse the
 * exact endpoints the EOD recap already uses (/api/analyze-eod → /api/trading-
 * days/<date>/eod). One grading path, no second implementation to drift.
 *
 * Refuses when the day is already analyzed, so a re-import never spends a
 * second AI call on the same session. RLS scopes every read to the caller.
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { Trade } from '@/lib/supabase/types'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET() {
  const supabase: AnyClient = await createClient()

  // Most recent day that actually has trades (the inner join does the work).
  const { data: dayRows } = await supabase
    .from('trading_days')
    .select('id, date, eod_notes, prep_notes_json, ai_analysis_json, eod_ai_analysis_json, session_ended_at, trades!inner(id)')
    .order('date', { ascending: false })
    .limit(1)
  const day = dayRows?.[0]
  if (!day) return NextResponse.json({ date: null, reason: 'no sessions' })
  if (day.eod_ai_analysis_json) {
    return NextResponse.json({ date: null, reason: 'already graded' })
  }

  const { data: trades } = await supabase
    .from('trades')
    .select('*')
    .eq('trading_day_id', day.id)
    .order('entry_time', { ascending: true })
  if (!trades || trades.length === 0) {
    return NextResponse.json({ date: null, reason: 'no trades' })
  }

  const { data: ctx } = await supabase
    .from('market_context')
    .select('*')
    .eq('trading_day_id', day.id)
    .maybeSingle()

  return NextResponse.json({
    date: day.date as string,
    tradeCount: (trades as Trade[]).length,
    trades,
    eodNotes: day.eod_notes ?? '',
    prepNotes: day.prep_notes_json ?? undefined,
    prepAnalysis: day.ai_analysis_json ?? undefined,
    marketContext: ctx ?? undefined,
    sessionEndedAt: day.session_ended_at ?? null,
  })
}
