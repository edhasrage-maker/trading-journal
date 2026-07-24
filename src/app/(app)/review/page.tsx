import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveReviewScope } from '@/lib/review-scope'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Bare /review resolves to a scope rather than rendering its own view.
 *
 * If a session is awaiting completion, open straight to Today — that's the
 * payoff of the whole loop, the place the Prep commitment gets resolved.
 * Otherwise open Month, the findings view (decided 2026-07-22: Month, not
 * last-viewed).
 */
export default async function ReviewIndex() {
  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  redirect(scope.pending ? `/review/today/${scope.today}` : '/review/month')
}
