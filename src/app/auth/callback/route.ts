import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

/**
 * Magic-link / signup callback. Supabase sends users here after they click the
 * email link. Depending on the flow the link carries either a PKCE `code` or a
 * `token_hash` + `type` — handle both, then drop them straight into the app.
 *
 * FAILURE IS THE INTERESTING CASE. A sign-in link fails routinely and for
 * mundane reasons — it expired, it was already used, or (the common one) it was
 * opened on a different device than it was requested from, since the PKCE code
 * verifier lives in a cookie on the requesting browser. This used to redirect to
 * `/login?error=auth`, and /login unconditionally redirects to `/`, dropping the
 * param: the trader clicked the link in their email and landed silently back on
 * the marketing page with no idea why. So the reason is classified here and
 * carried to the landing page, which explains it above the sign-in form.
 */

/** Why a sign-in link didn't work — kept short and stable; the landing page
 *  owns the wording. See `AUTH_ERRORS` in src/components/landing/AuthCard.tsx. */
type AuthErrorReason = 'expired' | 'invalid' | 'failed'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  // Land in the app on success (not the landing, which would just bounce
  // authenticated users onward anyway).
  const next = searchParams.get('next') ?? '/dashboard'

  const fail = (reason: AuthErrorReason) =>
    NextResponse.redirect(`${origin}/?auth_error=${reason}`)

  // Supabase can bounce the user here with its own error instead of a token
  // (notably error_code=otp_expired on a stale or already-used link).
  const providerError = searchParams.get('error') ?? searchParams.get('error_code')
  if (providerError) {
    return fail(/expired/i.test(providerError) ? 'expired' : 'invalid')
  }

  const supabase = await createClient()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
    // The exchange itself failed: almost always a link that's already been used
    // or was opened in a browser without the matching code verifier.
    return fail('invalid')
  }
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return NextResponse.redirect(`${origin}${next}`)
    return fail(/expired/i.test(error.message) ? 'expired' : 'invalid')
  }

  // Neither a code nor a token_hash — a truncated or hand-edited link.
  return fail('failed')
}
