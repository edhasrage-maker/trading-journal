import { LOCAL_FEATURES_ENABLED } from './local-features'
import { isDemoEmail } from './demo'

/**
 * Who may use Deep Dive Review (Replay Review).
 *
 *  Local build   — always (it is the owner's own machine).
 *  Hosted build  — every signed-in trader except the read-only demo account.
 *    The demo's seeded trades sit outside the 90 days of tick tape the site
 *    keeps, so every replay there would only show "no tick data"; the demo also
 *    can't save a call. Until the demo is re-seeded onto recent days, it keeps
 *    the page hidden.
 *
 * Opened to everyone 2026-11-02 (was a private beta behind the
 * DEEP_DIVE_BETA_EMAILS env var, which is no longer read). Every surface still
 * checks it on the server — the Review tab, the page and the API routes — so
 * the demo can neither see the tab nor reach the data by typing the URL.
 */
export function deepDiveAllowed(email: string | null | undefined): boolean {
  if (LOCAL_FEATURES_ENABLED) return true
  if (!email) return false
  return !isDemoEmail(email)
}
