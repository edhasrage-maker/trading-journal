/**
 * First-time-setup API. Per-user, on the trader_profile 'default' row.
 *
 * GET  /api/onboarding → { onboarding, scoring_profile }
 * PUT  /api/onboarding { onboarding?, scoring_profile? } → shallow-merges each
 *      into its jsonb column (partial updates don't clobber sibling keys).
 *
 * `onboarding`      = wizard progress/skip/reminder state.
 * `scoring_profile` = the trader's own risk/process/execution rules the Coach
 *                     Score grades against.
 * Degrades gracefully until the columns are migrated.
 */

import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { userConflict } from '@/lib/tenant-conflict'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const MIGRATION_HINT = 'Apply supabase/migrations/20260703_onboarding_profile.sql in the Supabase dashboard to enable.'
const MIGRATION_CODES = ['42703', 'PGRST204', '42P01', 'PGRST205']

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('trader_profile')
    .select('onboarding_json, scoring_profile_json')
    .eq('id', 'default')
    .maybeSingle()
  if (error) {
    if (MIGRATION_CODES.includes(error.code)) {
      return NextResponse.json({ onboarding: {}, scoring_profile: {}, migration_pending: true, hint: MIGRATION_HINT })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    onboarding: data?.onboarding_json ?? {},
    scoring_profile: data?.scoring_profile_json ?? {},
  })
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: { onboarding?: Record<string, unknown>; scoring_profile?: Record<string, unknown> }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  // Read existing to shallow-merge — a partial update (e.g. just steps_done)
  // must not wipe the other keys.
  const { data: existing, error: readErr } = await supabase
    .from('trader_profile')
    .select('onboarding_json, scoring_profile_json')
    .eq('id', 'default')
    .maybeSingle()
  if (readErr && !MIGRATION_CODES.includes(readErr.code)) {
    return NextResponse.json({ error: clientError(readErr) }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = { id: 'default', updated_at: new Date().toISOString() }
  if (body.onboarding && typeof body.onboarding === 'object') {
    row.onboarding_json = { ...(existing?.onboarding_json ?? {}), ...body.onboarding }
  }
  if (body.scoring_profile && typeof body.scoring_profile === 'object') {
    row.scoring_profile_json = { ...(existing?.scoring_profile_json ?? {}), ...body.scoring_profile }
  }
  if (!('onboarding_json' in row) && !('scoring_profile_json' in row)) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('trader_profile')
    .upsert(row, { onConflict: userConflict('id') })
    .select('onboarding_json, scoring_profile_json')
    .single()
  if (error) {
    if (MIGRATION_CODES.includes(error.code)) {
      return NextResponse.json({ error: 'onboarding columns not found — apply the migration first', migration_pending: true, hint: MIGRATION_HINT }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    onboarding: data.onboarding_json ?? {},
    scoring_profile: data.scoring_profile_json ?? {},
  })
}
