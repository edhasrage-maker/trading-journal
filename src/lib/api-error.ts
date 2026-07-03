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
  // Cloud: keep the detail out of the client response, but not out of the logs.
  if (msg) console.error('[api error]', msg)
  return fallback
}
