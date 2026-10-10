import { createClient } from '@/lib/supabase/server'
import ReviewNav from '@/components/review/ReviewNav'
import ReviewShell from '@/components/review/ReviewShell'
import { resolveReviewScope } from '@/lib/review-scope'
import { deepDiveAllowed } from '@/lib/deep-dive-access'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * The Review shell. One destination, four time scopes — Today (the session
 * debrief that used to be /eod), Week, Month (the findings view that used to be
 * /dashboard) and All time.
 */
export default async function ReviewLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  // Deep Dive is a private beta on the hosted site; the tab only exists for the people on the list.
  const { data: { user } } = await supabase.auth.getUser()
  const deepDive = deepDiveAllowed(user?.email)

  return (
    <ReviewShell>
      <ReviewNav todayDate={scope.today} weekStart={scope.weekStart} pending={scope.pending} deepDive={deepDive} />
      {children}
    </ReviewShell>
  )
}
