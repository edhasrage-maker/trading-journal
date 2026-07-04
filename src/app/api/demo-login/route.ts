import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { DEMO_EMAIL } from '@/lib/demo'

export const dynamic = 'force-dynamic'

/**
 * POST /api/demo-login — one-click sign-in to the seeded read-only demo account.
 *
 * Signs in server-side with credentials held in the deployment env (DEMO_PASSWORD),
 * so the demo password is NEVER shipped to the browser bundle. On success the
 * Supabase session cookie is set on the response (route handlers can write
 * cookies) and the client redirects to /dashboard.
 *
 * Cloud-only: the local single-user build has no demo account → 404.
 */
export async function POST() {
  if (LOCAL_FEATURES_ENABLED) {
    return NextResponse.json({ error: 'Not available in this deployment.' }, { status: 404 })
  }
  const password = process.env.DEMO_PASSWORD
  if (!password) {
    return NextResponse.json({ error: 'Demo is not configured.' }, { status: 503 })
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email: DEMO_EMAIL, password })
  if (error) {
    return NextResponse.json({ error: 'Could not start the demo. Please try again.' }, { status: 401 })
  }
  return NextResponse.json({ ok: true })
}
