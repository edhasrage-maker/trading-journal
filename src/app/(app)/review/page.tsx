import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveReviewScope } from '@/lib/review-scope'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Review is the per-session debrief now (Today · Week) — the all-trades overview
 * moved to its own top-level Dashboard. Bare /review opens the session awaiting
 * completion if there is one, otherwise the most recent day with trades.
 *
 * That fallback is the whole point and it used to be a lie: the comment here
 * promised "otherwise the most recent trading day" while the redirect used
 * scope.today unconditionally, so Review opened an empty page every weekend,
 * every holiday, and every morning before the first fill.
 */
export default async function ReviewIndex() {
  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  // Today wins only when there's something on it — an unfinished session is
  // exactly what you came back for. Otherwise the last day with data.
  const target = scope.pending ? scope.today : (scope.lastDataDate ?? scope.today)
  redirect(`/review/today/${target}`)
}
