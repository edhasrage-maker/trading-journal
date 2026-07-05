import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { runLookup, type MetricInputs } from '@/lib/condition-lookup'
import type { ConditionLookupRow, ConditionThreshold } from '@/lib/supabase/types'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { clientError } from '@/lib/api-error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Given today's 5 metric values, returns the median-view best match, tertile-view
 * best match, consolidated verdict, conflict flag, and data vintage.
 *
 * Body: { rvol?, dr_adr?, ib?, atr_730?, atr_entry? }  (all optional numbers)
 *   - missing values restrict that metric to ANY-only rows
 */

interface LookupBody {
  rvol?: number | null
  dr_adr?: number | null
  ib?: number | null
  atr_730?: number | null
  atr_entry?: number | null
}

export async function POST(req: Request) {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error('[condition-lookup] failed:', err)
    return NextResponse.json({ error: clientError(err, 'unknown server error') }, { status: 500 })
  }
}

async function handle(req: Request) {
  const body = (await req.json()) as LookupBody
  const inputs: MetricInputs = {
    rvol: body.rvol ?? null,
    dr_adr: body.dr_adr ?? null,
    ib: body.ib ?? null,
    atr_730: body.atr_730 ?? null,
    atr_entry: body.atr_entry ?? null,
  }

  const supabase: AnyClient = await createClient()

  // Vintage source differs by deployment: the LOCAL single-tenant build stamps
  // one global key in lookup_metadata; the CLOUD per-user build keeps a row per
  // user in condition_lookup_meta (RLS scopes the read to the caller).
  const vintagePromise = LOCAL_FEATURES_ENABLED
    ? (supabase.from('lookup_metadata').select('value').eq('key', 'condition_lookup_refreshed_at').maybeSingle() as Promise<{ data: { value: { at: string } | null } | null }>)
      .then(({ data }) => data?.value?.at ?? null)
    : (supabase.from('condition_lookup_meta').select('refreshed_at').maybeSingle() as Promise<{ data: { refreshed_at: string | null } | null }>)
      .then(({ data }) => data?.refreshed_at ?? null)

  const [
    { data: thresholds, error: tErr },
    { data: lookup, error: lErr },
    refreshedAt,
  ] = await Promise.all([
    supabase.from('condition_thresholds').select('*') as Promise<{ data: ConditionThreshold[] | null; error: { message: string } | null }>,
    supabase.from('condition_lookup').select('*') as Promise<{ data: ConditionLookupRow[] | null; error: { message: string } | null }>,
    vintagePromise,
  ])

  if (tErr) return NextResponse.json({ error: clientError(`Failed to load thresholds: ${tErr.message}`, 'Could not load condition data.') }, { status: 500 })
  if (lErr) return NextResponse.json({ error: clientError(`Failed to load lookup: ${lErr.message}`, 'Could not load condition data.') }, { status: 500 })

  // Per-user builds: a new trader with little/no history has no buckets yet. The
  // local build should always have data (the manual button seeds it), so keep
  // pointing there for setup. Both surface via the panel's `error` string.
  const emptyMsg = LOCAL_FEATURES_ENABLED
    ? 'No condition data loaded. Click "Refresh now" in Settings → Morning Conditions.'
    : 'Not enough trade history yet — your Morning Conditions populate after the nightly refresh once you’ve logged enough sessions.'
  if (!thresholds || thresholds.length === 0) {
    return NextResponse.json({ error: emptyMsg }, { status: 503 })
  }
  if (!lookup || lookup.length === 0) {
    return NextResponse.json({ error: emptyMsg }, { status: 503 })
  }

  const outcome = runLookup(inputs, thresholds, lookup)

  return NextResponse.json({
    ...outcome,
    vintage: {
      refreshed_at: refreshedAt,
      lookup_row_count: lookup.length,
      threshold_count: thresholds.length,
    },
  })
}
