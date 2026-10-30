import { createClient } from '@/lib/supabase/server'
import ReviewNav from '@/components/review/ReviewNav'
import ReviewShell from '@/components/review/ReviewShell'
import { resolveReviewScope } from '@/lib/review-scope'
import { deepDiveAllowed } from '@/lib/deep-dive-access'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * The shell for Session's Week, Month and Replay Review pages. The day itself
 * lives at /session/<date>; these keep their /review URLs and carry the same
 * Session header and range switch.
 */
export default async function ReviewLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  // Deep Dive is a private beta on the hosted site; the tab only exists for the people on the list.
  const { data: { user } } = await supabase.auth.getUser()
  const deepDive = deepDiveAllowed(user?.email)

  return (
    <ReviewShell>
      <ReviewNav todayDate={scope.today} pending={scope.pending} deepDive={deepDive} />
      {children}
    </ReviewShell>
  )
}
