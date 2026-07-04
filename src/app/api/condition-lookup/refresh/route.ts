import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { refreshConditionLookup } from '@/lib/condition-lookup-refresh'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { clientError } from '@/lib/api-error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * One-button refresh (Settings → Morning Conditions): regenerate
 * condition_thresholds + condition_lookup directly from live trade history.
 *
 *   • LOCAL build   → GLOBAL pass over the single-tenant tables (no user_id).
 *   • CLOUD build   → PER-USER pass scoped to the signed-in trader. Each user
 *                     rebuilds only their own buckets; the nightly Vercel cron
 *                     (/api/cron/refresh-condition-lookup) does the same for
 *                     everyone.
 *
 * The heavy lifting lives in refreshConditionLookup() so this route and the
 * cron share one code path.
 */
export async function POST() {
  try {
    const supabase: AnyClient = await createClient()

    let userId: string | null = null
    if (!LOCAL_FEATURES_ENABLED) {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        return NextResponse.json({ error: 'Not authenticated.' }, { status: 403 })
      }
      userId = user.id
    }

    const result = await refreshConditionLookup(supabase, userId)
    return NextResponse.json(result)
  } catch (e) {
    const err = e as Error
    console.error('[condition-lookup/refresh] failed:', err)
    return NextResponse.json({ error: clientError(err, 'unknown server error') }, { status: 500 })
  }
}
