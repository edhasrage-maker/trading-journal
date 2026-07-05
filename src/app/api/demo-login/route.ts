import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
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
 * CAPTCHA interaction: once CAPTCHA is enabled on the Supabase project, the
 * server-side password grant below would itself demand a captcha token it can't
 * produce (a server can't solve a human challenge), which would break the demo.
 * So when a service-role key is configured (SUPABASE_SERVICE_ROLE_KEY), we sign
 * the demo in via an admin-minted magic link + verifyOtp — that path bypasses
 * CAPTCHA and still keeps the password out of the browser. Without the key, we
 * fall back to the original password grant (fine while CAPTCHA is off).
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

  // CAPTCHA-safe path: admin magic link → verifyOtp (no captcha required).
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (serviceKey && supabaseUrl) {
    try {
      const admin = createAdminClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: DEMO_EMAIL })
      const tokenHash = data?.properties?.hashed_token
      if (error || !tokenHash) throw error ?? new Error('no token')
      const { error: verifyError } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
      if (verifyError) throw verifyError
      return NextResponse.json({ ok: true })
    } catch {
      // Fall through to the legacy password path (e.g. transient admin error).
    }
  }

  const { error } = await supabase.auth.signInWithPassword({ email: DEMO_EMAIL, password })
  if (error) {
    return NextResponse.json({ error: 'Could not start the demo. Please try again.' }, { status: 401 })
  }
  return NextResponse.json({ ok: true })
}
