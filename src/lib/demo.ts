/**
 * Read-only demo account plumbing.
 *
 * TapeScore's public site (tapescore.app) offers an "Explore the demo" button so
 * prospects can poke around every screen without signing up. It logs them into a
 * single curated, seeded account (DEMO_EMAIL) whose data is synthetic. That
 * session is made READ-ONLY at two layers:
 *   1. `src/middleware.ts` — rejects every mutating /api request from the demo
 *      user with a 403 (the primary gate; all app writes go through /api).
 *   2. RLS backstop — `supabase/migrations/20260704_demo_readonly.public.sql`
 *      denies INSERT/UPDATE/DELETE for the demo uid at the database (defends a
 *      direct PostgREST write using the demo session's JWT).
 *
 * Only relevant to the hosted build; the local single-user app has no demo
 * concept (LOCAL_FEATURES_ENABLED short-circuits the middleware).
 */
export const DEMO_EMAIL = (process.env.NEXT_PUBLIC_DEMO_EMAIL || 'demo@tapescore.app').toLowerCase()

export function isDemoEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase() === DEMO_EMAIL
}
