import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
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
  return <Landing authError={authError} />
}
