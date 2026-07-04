import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/types'

/**
 * Service-role Supabase client — BYPASSES RLS. Server-only.
 *
 * Used ONLY by the nightly cron (`/api/cron/refresh-condition-lookup`), which
 * has no user session and must read+write every user's condition buckets. The
 * public schema (schema.public.sql §7) always intended these reference tables
 * to be service-role-written; this is that writer.
 *
 * NEVER import this from a client component or a user-facing route — it would
 * leak the ability to read across tenants. The key lives only in the cloud
 * deployment's env (SUPABASE_SERVICE_ROLE_KEY, a `sb_secret_…` key); it is
 * unset locally, so `isServiceConfigured()` gates callers off in the local build.
 */
export function isServiceConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY
}

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Service client not configured (SUPABASE_SERVICE_ROLE_KEY missing).')
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
