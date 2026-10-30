import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveReviewScope } from '@/lib/review-scope'
import { isBeforeRthClose } from '@/lib/rth'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Bare /session picks the day to open. Today while there's a session to trade
 * or finish — a weekday before the close, or traded today but not yet reviewed.
 * Otherwise the last day you actually traded: on a weekend, a holiday or the
 * evening after, today is an empty page and that session is what you came for.
 */
export default async function SessionIndexRedirect() {
  const supabase = await createClient()
  const scope = await resolveReviewScope(supabase)
  const weekday = new Date(`${scope.today}T12:00:00Z`).getUTCDay()
  const tradingNow = weekday >= 1 && weekday <= 5 && isBeforeRthClose(scope.today)
  const target = scope.pending || tradingNow ? scope.today : (scope.lastDataDate ?? scope.today)
  redirect(`/session/${target}`)
}
