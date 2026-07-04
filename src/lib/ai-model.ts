/**
 * AI model tier resolution (public/multi-tenant build).
 *
 * Every AI feature defaults to Sonnet. A user runs on Opus when EITHER:
 *   - they're the app admin — the local owner build (LOCAL_FEATURES_ENABLED) or
 *     a hosted user whose email matches ADMIN_EMAIL (same test as (app)/layout);
 *   - an admin has explicitly granted them Opus in `public.ai_model_grants`
 *     (flipped from the admin-only Model Tiers settings page).
 *
 * Resolution is server-side ONLY — never trust a client-supplied tier. The tier
 * is read from the CALLER's own grant row (owner-select RLS), so this needs the
 * user's authenticated server client, not the service role.
 *
 * Positioning note (matters once billing launches): never expose the model NAME
 * to users. Sell premium on features/limits, not "the smarter AI". This resolver
 * stays invisible.
 */

import { LOCAL_FEATURES_ENABLED } from './local-features'

export const MODEL_OPUS = 'claude-opus-4-8'
export const MODEL_SONNET = 'claude-sonnet-4-6'

export type AiTier = 'basic' | 'opus'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface MinimalUser {
  id?: string | null
  email?: string | null
}

/** True when this user is the app admin (local owner build OR the ADMIN_EMAIL
 *  hosted account). Admins always run on Opus and see admin-only surfaces. */
export function isAdminUser(user: MinimalUser | null | undefined): boolean {
  if (LOCAL_FEATURES_ENABLED) return true
  return !!user?.email && user.email === process.env.ADMIN_EMAIL
}

/**
 * Resolve the Anthropic model id for a request. Admins → Opus. Otherwise read
 * the caller's own tier from `ai_model_grants`; 'opus' → Opus, else Sonnet.
 * Fail-safe to Sonnet on any error (missing table pre-migration, RLS, etc.) so
 * a telemetry hiccup never blocks a working AI feature.
 */
export async function resolveAiModel(
  db: AnyClient, user: MinimalUser | null | undefined,
): Promise<string> {
  if (isAdminUser(user)) return MODEL_OPUS
  if (!user?.id) return MODEL_SONNET
  try {
    const { data } = await db
      .from('ai_model_grants')
      .select('tier')
      .eq('user_id', user.id)
      .maybeSingle()
    return data?.tier === 'opus' ? MODEL_OPUS : MODEL_SONNET
  } catch {
    return MODEL_SONNET
  }
}
