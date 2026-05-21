import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { runLookup, type MetricInputs } from '@/lib/condition-lookup'
import type { ConditionLookupRow, ConditionThreshold } from '@/lib/supabase/types'

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
    return NextResponse.json({ error: err.message ?? 'unknown server error' }, { status: 500 })
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

  const [
    { data: thresholds, error: tErr },
    { data: lookup, error: lErr },
    { data: meta },
  ] = await Promise.all([
    supabase.from('condition_thresholds').select('*') as Promise<{ data: ConditionThreshold[] | null; error: { message: string } | null }>,
    supabase.from('condition_lookup').select('*') as Promise<{ data: ConditionLookupRow[] | null; error: { message: string } | null }>,
    supabase.from('lookup_metadata').select('value, updated_at').eq('key', 'condition_lookup_refreshed_at').maybeSingle() as Promise<{ data: { value: { at: string } | null; updated_at: string } | null }>,
  ])

  if (tErr) return NextResponse.json({ error: `Failed to load thresholds: ${tErr.message}` }, { status: 500 })
  if (lErr) return NextResponse.json({ error: `Failed to load lookup: ${lErr.message}` }, { status: 500 })

  if (!thresholds || thresholds.length === 0) {
    return NextResponse.json(
      { error: 'No condition thresholds loaded. Upload the CSVs at /settings/condition-lookup first.' },
      { status: 503 },
    )
  }
  if (!lookup || lookup.length === 0) {
    return NextResponse.json(
      { error: 'No condition lookup rows loaded. Upload the CSVs at /settings/condition-lookup first.' },
      { status: 503 },
    )
  }

  const outcome = runLookup(inputs, thresholds, lookup)
  const refreshedAt = meta?.value?.at ?? null

  return NextResponse.json({
    ...outcome,
    vintage: {
      refreshed_at: refreshedAt,
      lookup_row_count: lookup.length,
      threshold_count: thresholds.length,
    },
  })
}
