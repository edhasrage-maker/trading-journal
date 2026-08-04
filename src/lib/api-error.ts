/**
 * Scrub API error detail for the client.
 *
 * A public/multi-tenant deploy should not echo raw exception text, DB error
 * messages, or provider internals back to users (info leak). But the founder's
 * LOCAL build wants the full detail for debugging. So:
 *   • LOCAL build (LOCAL_FEATURES_ENABLED) → returns the real message (behavior
 *     unchanged from before this helper existed).
 *   • Cloud build → returns a generic `fallback`, and logs the full detail
 *     server-side so it's still recoverable from server logs.
 *
 * Usage — replace `error: e.message` / `error: String(e)` / `error: detail`:
 *   catch (e) {
 *     return NextResponse.json({ error: clientError(e) }, { status: 500 })
 *   }
 * Pass a route-specific fallback when a friendlier message helps:
 *   clientError(e, 'Could not save your notes. Please try again.')
 */
import { LOCAL_FEATURES_ENABLED } from './local-features'

export function clientError(
  detail: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const msg = detail instanceof Error ? detail.message : String(detail ?? '')
  if (LOCAL_FEATURES_ENABLED) return msg || fallback
  // Provider credit/quota exhaustion is an OPERATOR problem, not a user or
  // data one — scrubbing it to the generic fallback cost a night of chasing
  // two different "failed" toasts that were both an empty Anthropic balance
  // (2026-08-04). Say "temporarily unavailable" honestly; the full detail
  // still goes to the server logs below.
  const providerCapacity = /credit balance|billing|quota|rate.?limit|overloaded/i.test(msg)
  if (msg) console.error(providerCapacity ? '[api error — provider quota/billing]' : '[api error]', msg)
  if (providerCapacity) {
    return 'AI is temporarily unavailable (service capacity). Your data is saved — try again shortly.'
  }
  return fallback
}
