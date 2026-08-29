import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { resolveReviewScope } from '@/lib/review-scope'
import { todayPT } from '@/lib/pt-time'

export const dynamic = 'force-dynamic'

/** Set by the masthead whenever a dated Review page is open; expires by itself
 *  after an hour. See REVIEW_VISIT_COOKIE in src/components/Masthead.tsx. */
const REVIEW_VISIT_COOKIE = 'ts_review_visit'

/**
 * Bare /prep — the nav's Prep link whenever the current URL carries no date.
 *
 * Which day Prep means, in order:
 *   1. The session you were reviewing in the last hour. Reading Friday's recap
 *      and then clicking Prep means you want Friday's prep, not today's; the
 *      cookie expires on its own so tomorrow this stops applying without anyone
 *      clearing anything.
 *   2. Today, when today is a trading day — the normal case.
 *   3. Otherwise the last day with trades. Prep for a Sunday is a page about a
 *      session that will not happen, and an empty page is a worse answer than
 *      the session you were last in.
 *
 * Weekends are caught by the weekday test; holidays are not, because we keep no
 * exchange calendar. A holiday therefore still opens today — the same as before.
 */
export default async function PrepIndexRedirect() {
  const today = todayPT()

  const recent = (await cookies()).get(REVIEW_VISIT_COOKIE)?.value
  if (recent && /^\d{4}-\d{2}-\d{2}$/.test(recent)) redirect(`/prep/${recent}`)

  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
  if (weekday !== 0 && weekday !== 6) redirect(`/prep/${today}`)

  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  redirect(`/prep/${scope.lastDataDate ?? today}`)
}
