import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { recordLandingVisit } from '@/lib/funnel'
import Landing from '@/components/landing/Landing'

// Public landing page for logged-out visitors; signed-in users go straight to
// their dashboard.
export const dynamic = 'force-dynamic'

export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/dashboard')
  // A failed sign-in link lands here with ?auth_error=… (see
  // src/app/auth/callback/route.ts). Read it server-side and pass it down, so
  // the sign-in card can explain what happened instead of the trader bouncing
  // silently back to the marketing page.
  const raw = (await searchParams).auth_error
  const authError = typeof raw === 'string' ? raw : null

  // Launch funnel: one more signed-out visit on today's count. Not a failed
  // sign-in bouncing back, and not a link prefetch.
  const h = await headers()
  const prefetch = !!h.get('next-router-prefetch') || h.get('purpose') === 'prefetch' || (h.get('sec-purpose') ?? '').includes('prefetch')
  if (!authError && !prefetch) {
    const userAgent = h.get('user-agent')
    after(() => recordLandingVisit(supabase, userAgent))
  }

  return <Landing authError={authError} />
}
