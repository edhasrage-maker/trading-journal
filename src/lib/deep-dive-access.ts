import { LOCAL_FEATURES_ENABLED } from './local-features'

/**
 * Who may use Deep Dive Review (Replay Review).
 *
 *  Local build   — always (it is the owner's own machine).
 *  Hosted build  — every signed-in trader, the read-only demo included. The
 *    demo can call, reveal and play forward, but saves nothing: src/proxy.ts
 *    turns away its writes (the call, tag edits, Coach Review, the Score read),
 *    so its trades are scored when they are seeded (scripts/seed-demo.ts).
 *
 * Opened to everyone 2026-11-02 (was a private beta behind the
 * DEEP_DIVE_BETA_EMAILS env var, which is no longer read); the demo joined the
 * same day, once it was seeded onto days inside the tick tape. Every surface
 * still checks this on the server — the Review tab, the page and the API routes.
 */
export function deepDiveAllowed(email: string | null | undefined): boolean {
  if (LOCAL_FEATURES_ENABLED) return true
  return !!email
}
