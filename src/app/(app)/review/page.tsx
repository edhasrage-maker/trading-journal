import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveReviewScope } from '@/lib/review-scope'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Review is the per-session debrief now (Today · Week) — the all-trades overview
 * moved to its own top-level Dashboard. Bare /review opens Today: the session
 * awaiting completion if there is one, otherwise the most recent trading day.
 */
export default async function ReviewIndex() {
  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  redirect(`/review/today/${scope.today}`)
}
