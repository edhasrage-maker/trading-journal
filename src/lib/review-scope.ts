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
}

/**
 * A session is "awaiting completion" when the trader traded today but hasn't
 * closed the loop on it — no realised P&L recorded and no debrief written. That
 * is the one state where Review should open straight to Today rather than the
 * monthly findings, because it's exactly where the Prep commitment resolves.
 */
export async function resolveReviewScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Supabase server client is intentionally loose here, matching the route pages
  supabase: any,
): Promise<ReviewScope> {
  const today = todayPT()
  const scope: ReviewScope = { today, weekStart: weekStartFor(today), pending: false }

  try {
    const { data: day } = await supabase
      .from('trading_days')
      .select('id, eod_pnl, eod_notes')
      .eq('date', today)
      .maybeSingle() as { data: { id: string; eod_pnl: number | null; eod_notes: string | null } | null }

    if (!day) return scope

    const reviewed = day.eod_pnl != null || !!day.eod_notes?.trim()
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
