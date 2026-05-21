import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { resilientUpsert } from '@/lib/resilient-upsert'
import type { DailyPrep, ConditionVerdict } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface DailyPrepBody {
  rvol?: number | null
  dr_adr?: number | null
  ib?: number | null
  atr_730?: number | null
  atr_entry?: number | null
  matched_median_condition_id?: string | null
  matched_tertile_condition_id?: string | null
  consolidated_verdict?: ConditionVerdict | null
  conflict_flag?: boolean
  notes?: string | null
}

export async function GET(_req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('daily_prep')
    .select('*')
    .eq('trade_date', date)
    .maybeSingle() as { data: DailyPrep | null; error: { message: string } | null }

  if (error) {
    // If the table just doesn't exist yet (Phase 6 migration not run), return
    // an empty result rather than 500 — the panel renders fine without a snapshot.
    // PostgREST error messages we want to swallow:
    //   "Could not find the table 'public.daily_prep' in the schema cache"
    //   "relation \"public.daily_prep\" does not exist"
    //   "could not find ... column ... in the schema cache" (some columns missing — also tolerable)
    if (isMissingSchemaError(error.message)) {
      return NextResponse.json({ prep: null, migrationNeeded: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ prep: data ?? null })
}

function isMissingSchemaError(msg: string | undefined | null): boolean {
  if (!msg) return false
  return /(?:could not find|does not exist|undefined table|schema cache|relation .* does not exist)/i.test(msg)
}

export async function POST(req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const body = (await req.json()) as DailyPrepBody

  const payload: Record<string, unknown> = {
    trade_date: date,
    updated_at: new Date().toISOString(),
  }
  if (body.rvol !== undefined) payload.rvol = body.rvol
  if (body.dr_adr !== undefined) payload.dr_adr = body.dr_adr
  if (body.ib !== undefined) payload.ib = body.ib
  if (body.atr_730 !== undefined) payload.atr_730 = body.atr_730
  if (body.atr_entry !== undefined) payload.atr_entry = body.atr_entry
  if (body.matched_median_condition_id !== undefined) payload.matched_median_condition_id = body.matched_median_condition_id
  if (body.matched_tertile_condition_id !== undefined) payload.matched_tertile_condition_id = body.matched_tertile_condition_id
  if (body.consolidated_verdict !== undefined) payload.consolidated_verdict = body.consolidated_verdict
  if (body.conflict_flag !== undefined) payload.conflict_flag = body.conflict_flag
  if (body.notes !== undefined) payload.notes = body.notes

  const { data: prep, error, droppedColumns } = await resilientUpsert<DailyPrep>(
    supabase,
    'daily_prep',
    payload,
    { onConflict: 'trade_date' },
  )

  if (error) {
    const tableMissing = isMissingSchemaError(error.message)
    return NextResponse.json(
      {
        error: tableMissing
          ? 'daily_prep table is missing — run the Phase 6 schema migration in Supabase (/settings/condition-lookup page has the SQL).'
          : error.message,
        migrationNeeded: tableMissing || undefined,
      },
      { status: tableMissing ? 503 : 500 },
    )
  }
  return NextResponse.json({ prep, droppedColumns: droppedColumns.length > 0 ? droppedColumns : undefined })
}
