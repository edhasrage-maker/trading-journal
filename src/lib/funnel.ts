/**
 * Launch funnel — where new traders drop off, measured in our own database
 * (supabase/migrations/20261025_launch_funnel.public.sql). No third-party
 * analytics and no tracking cookies: a milestone is one row per account, and
 * a landing visit is a bare per-day count.
 *
 *   landing visit → signed_up → first_trades → first_score → came_back
 *
 * Hosted build only — the local owner build has one user and no funnel. The
 * demo account and the admin are never counted. Every call is best effort:
 * nothing here can fail or slow the request it rides on (before the migration
 * runs, the writes simply error and are ignored).
 */
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { isDemoEmail } from '@/lib/demo'
import { todayPT } from '@/lib/pt-time'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- funnel tables aren't in the generated types (same workaround as the rest of the codebase)
type AnyClient = any

export type FunnelEvent = 'signed_up' | 'first_trades' | 'first_score' | 'came_back'

interface FunnelUser {
  id: string
  email?: string | null
  created_at: string
}

/** A new trader, as opposed to the demo account or the admin. */
function counts(user: FunnelUser | null | undefined): user is FunnelUser {
  if (LOCAL_FEATURES_ENABLED || !user) return false
  const email = (user.email ?? '').toLowerCase()
  const admin = (process.env.ADMIN_EMAIL ?? '').toLowerCase()
  return !isDemoEmail(email) && !(admin && email === admin)
}

async function insertOnce(supabase: AnyClient, rows: Record<string, unknown>[]): Promise<void> {
  try {
    await supabase.from('funnel_events').upsert(rows, { onConflict: 'user_id,event', ignoreDuplicates: true })
  } catch {
    // Best effort — see the header.
  }
}

/** A milestone, recorded the first time it happens for this account. */
export async function recordFunnelEvent(supabase: AnyClient, user: FunnelUser | null | undefined, event: FunnelEvent): Promise<void> {
  if (!counts(user)) return
  await insertOnce(supabase, [{ user_id: user.id, event }])
}

/**
 * A full page load inside the app. Records the sign-up (dated to the account's
 * creation, so traders who joined before the funnel existed still land in
 * their real week) and, from the next Pacific-time day on, "came back".
 */
export async function recordAppVisit(supabase: AnyClient, user: FunnelUser | null | undefined): Promise<void> {
  if (!counts(user)) return
  const rows: Record<string, unknown>[] = [{ user_id: user.id, event: 'signed_up', created_at: user.created_at }]
  if (todayPT() > todayPT(new Date(user.created_at))) rows.push({ user_id: user.id, event: 'came_back' })
  await insertOnce(supabase, rows)
}

/** User agents that aren't people: crawlers, link previews, uptime checks. */
const NOT_A_PERSON = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|lighthouse|headless|curl|wget|python|axios|node-fetch|vercel/i

/** A signed-out view of the landing page: one more on today's count. */
export async function recordLandingVisit(supabase: AnyClient, userAgent: string | null): Promise<void> {
  if (LOCAL_FEATURES_ENABLED || !userAgent || NOT_A_PERSON.test(userAgent)) return
  try {
    await supabase.rpc('record_landing_visit')
  } catch {
    // Best effort — see the header.
  }
}
