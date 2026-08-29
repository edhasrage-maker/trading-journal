import { todayPT } from './pt-time'
import { weekStartFor } from './week-dates'

/**
 * Shared scope resolution for the Review destination.
 *
 * Review answers the same question at four zoom levels, so every entry point
 * needs the same three facts: which day "Today" means, which Monday "Week"
 * means, and whether there is a session still waiting to be closed out.
 */

export interface ReviewScope {
  /** PT session date — not machine-local, so a mis-set OS timezone can't file
   *  the review under the wrong calendar day. */
  today: string
  /** Monday of the current trading week. */
  weekStart: string
  /** True when today has trades but no completed review yet. */
  pending: boolean
  /** Most recent date that actually has trades behind it — what Review should
   *  open on. Null when the account has no trades at all. */
  lastDataDate: string | null
}

/**
 * A session is "awaiting completion" when the trader traded today but hasn't
 * closed the loop on it. "Closed the loop" is ANY real review signal, because
 * traders finish a session different ways and the banner must not nag someone
 * who has already reviewed:
 *   - session_ended_at set  — they manually ended the session (Pt 13)
 *   - eod_ai_analysis_json  — they ran Analyze Session (the EOD debrief)
 *   - eod_pnl               — they recorded a realised P&L
 *   - eod_notes             — they wrote a debrief note
 * Any one of those means done. (An earlier version only checked the last two,
 * so a trader who ran the analysis and ended the session was still told the day
 * wasn't reviewed.)
 */
export async function resolveReviewScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Supabase server client is intentionally loose here, matching the route pages
  supabase: any,
): Promise<ReviewScope> {
  const today = todayPT()
  const scope: ReviewScope = { today, weekStart: weekStartFor(today), pending: false, lastDataDate: null }

  // The most recent day with trades behind it. Review opens on the last session
  // you actually traded, not on today — on a weekend, a holiday, or any morning
  // before the first fill, "today" is an empty page, and an empty page is a
  // worse answer than the session you probably came back to look at.
  try {
    const { data } = await supabase
      .from('trading_days')
      .select('date, trades!inner(id)')
      .lte('date', today)
      .order('date', { ascending: false })
      .limit(1) as { data: Array<{ date: string }> | null }
    scope.lastDataDate = data?.[0]?.date ?? null
  } catch { /* best-effort — Review still opens on today */ }

  try {
    const { data: day } = await supabase
      .from('trading_days')
      .select('id, eod_pnl, eod_notes, session_ended_at, eod_ai_analysis_json')
      .eq('date', today)
      .maybeSingle() as {
        data: {
          id: string
          eod_pnl: number | null
          eod_notes: string | null
          session_ended_at: string | null
          eod_ai_analysis_json: Record<string, unknown> | null
        } | null
      }

    if (!day) return scope

    const reviewed =
      !!day.session_ended_at ||
      (day.eod_ai_analysis_json != null && Object.keys(day.eod_ai_analysis_json).length > 0) ||
      day.eod_pnl != null ||
      !!day.eod_notes?.trim()
    if (reviewed) return scope

    const { count } = await supabase
      .from('trades')
      .select('id', { count: 'exact', head: true })
      .eq('trading_day_id', day.id) as { count: number | null }

    scope.pending = (count ?? 0) > 0
  } catch {
    // Never block the page on this — worst case Review opens to Month.
  }

  return scope
}
