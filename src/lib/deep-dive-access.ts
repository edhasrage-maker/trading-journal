import { LOCAL_FEATURES_ENABLED } from './local-features'

/**
 * Who may use Deep Dive Review.
 *
 *  Local build   — always (it is the owner's own machine).
 *  Hosted build  — a private beta: only the sign-in emails listed in the
 *    server-side env var DEEP_DIVE_BETA_EMAILS (comma-separated). Unset or
 *    empty means nobody, so deploying the code changes nothing for anyone until
 *    the list is set.
 *
 * Server-only: the list is not a NEXT_PUBLIC_ variable and must never be sent
 * to the browser. Every surface checks it on the server — the Review tab, the
 * page and the API route — so a user outside the list can neither see the tab
 * nor reach the data by typing the URL.
 */
export function deepDiveAllowed(email: string | null | undefined): boolean {
  if (LOCAL_FEATURES_ENABLED) return true
  if (!email) return false
  const list = (process.env.DEEP_DIVE_BETA_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  return list.includes(email.trim().toLowerCase())
}
