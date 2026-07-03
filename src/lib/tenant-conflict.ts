/**
 * Multi-tenant upsert conflict keys.
 *
 * The SAME codebase serves two databases:
 *   • Local (single-user) personal DB  → per-user tables carry a UNIQUE on the
 *     bare natural key (e.g. trading_days UNIQUE(date)).
 *   • Public (multi-tenant) DB          → the overlay recomposes every per-user
 *     UNIQUE to (user_id, <natural key>) so rows are scoped per account
 *     (see supabase/schema.public.sql). On INSERT, user_id auto-fills from the
 *     column default auth.uid(), so callers never pass it explicitly.
 *
 * An upsert's `onConflict` target MUST match the active DB's constraint, or
 * Postgres throws "no unique or exclusion constraint matching the ON CONFLICT
 * specification" (HTTP 500). This helper picks the right one from the build mode.
 *
 * Use for PER-USER tables only. Do NOT use for shared tables (ohlcv_bars keyed
 * on symbol,ts) or child tables already unique via their parent (market_context
 * keyed on trading_day_id — each day belongs to exactly one user).
 */
import { LOCAL_FEATURES_ENABLED } from './local-features'

/** `userConflict('date')` → 'date' locally, 'user_id,date' on the public build. */
export function userConflict(base: string): string {
  return LOCAL_FEATURES_ENABLED ? base : `user_id,${base}`
}
