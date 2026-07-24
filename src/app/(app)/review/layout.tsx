import { createClient } from '@/lib/supabase/server'
import ReviewNav from '@/components/review/ReviewNav'
import { resolveReviewScope } from '@/lib/review-scope'

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

  return (
    <div className="mx-auto w-full max-w-[1080px]">
      <ReviewNav todayDate={scope.today} weekStart={scope.weekStart} pending={scope.pending} />
      {children}
    </div>
  )
}
