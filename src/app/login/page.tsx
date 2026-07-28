import { redirect } from 'next/navigation'

// The login form now lives inline on the public landing page (/). Redirect any
// direct/bookmarked /login hits there so there's a single branded entry point.
//
// Carries `?error=` / `?auth_error=` through as `auth_error`: this route used to
// redirect unconditionally, which silently swallowed the reason a sign-in link
// had failed — the trader clicked the link in their email and landed on the
// marketing page with no explanation. Links already in inboxes still point at
// /login?error=auth, so that spelling is mapped onto the current vocabulary.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = params.auth_error ?? params.error
  const reason = typeof raw === 'string' ? raw : null
  const mapped = reason === 'auth' ? 'failed' : reason
  redirect(mapped ? `/?auth_error=${encodeURIComponent(mapped)}` : '/')
}
