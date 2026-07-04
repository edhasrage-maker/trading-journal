import { NextResponse } from 'next/server'
import { createServiceClient, isServiceConfigured } from '@/lib/supabase/service'
import { refreshConditionLookup } from '@/lib/condition-lookup-refresh'
import { clientError } from '@/lib/api-error'

// Sequential per-user recompute can take a while with many users; give the
// function headroom above the 10s default. Force dynamic — never cached.
export const maxDuration = 60
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * GET /api/cron/refresh-condition-lookup — nightly Vercel Cron (vercel.json).
 *
 * Recomputes every user's Morning Conditions buckets (condition_thresholds +
 * condition_lookup) from their own trade history so the prep-page grades never
 * go stale. Runs with the service-role client (no user session → bypasses RLS);
 * each user is refreshed via the shared refreshConditionLookup() engine.
 *
 * Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` on scheduled
 * invocations — we require it, so a random public hit can't trigger a full
 * recompute. Cloud-only: returns 404 locally (no service key configured).
 */
export async function GET(req: Request) {
  // Cloud-only — the local single-tenant build has no service key and keeps its
  // global tables refreshed via the Settings button.
  if (!isServiceConfigured()) {
    return NextResponse.json({ error: 'Not available in this deployment.' }, { status: 404 })
  }

  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  try {
    const svc: AnyClient = createServiceClient()

    // ── Enumerate every user who has any trade history (native or historical) ──
    const userIds = new Set<string>()
    const PAGE = 1000
    for (const table of ['trades', 'historical_trades'] as const) {
      for (let p = 0; p < 100; p++) {
        const { data, error } = await svc
          .from(table)
          .select('user_id')
          .order('user_id', { ascending: true })
          .range(p * PAGE, p * PAGE + PAGE - 1)
        if (error) { console.error(`[cron/refresh] ${table} page ${p}:`, error.message); break }
        const rows = (data ?? []) as { user_id: string | null }[]
        for (const r of rows) if (r.user_id) userIds.add(r.user_id)
        if (rows.length < PAGE) break
      }
    }

    // One shared timestamp so every user's vintage matches this run.
    const refreshedAt = new Date().toISOString()
    const details: Array<{ user_id: string; ok: boolean; lookup_inserted?: number; error?: string }> = []
    let refreshed = 0
    let failed = 0

    // Sequential: keeps DB load modest and avoids blowing the function's memory
    // on many concurrent aggregations. One user's failure never aborts the rest.
    for (const userId of userIds) {
      try {
        const r = await refreshConditionLookup(svc, userId, refreshedAt)
        details.push({ user_id: userId, ok: true, lookup_inserted: r.lookup_inserted })
        refreshed++
      } catch (e) {
        console.error('[cron/refresh] user', userId, 'failed:', e)
        details.push({ user_id: userId, ok: false, error: e instanceof Error ? e.message : 'unknown' })
        failed++
      }
    }

    return NextResponse.json({
      users_total: userIds.size,
      users_refreshed: refreshed,
      users_failed: failed,
      refreshed_at: refreshedAt,
      details,
    })
  } catch (e) {
    const err = e as Error
    console.error('[cron/refresh-condition-lookup] failed:', err)
    return NextResponse.json({ error: clientError(err, 'cron failed') }, { status: 500 })
  }
}
