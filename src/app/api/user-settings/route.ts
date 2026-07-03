/**
 * User settings API (per-user, stored on the trader_profile 'default' row).
 *
 * GET  /api/user-settings                          → { commission_per_side }
 * PUT  /api/user-settings { commission_per_side }  → upserts the value
 *
 * commission_per_side = $ per contract, per side. Applied at import to logs that
 * carry no commission (Sierra Chart = gross). Round-turn cost = value × 2.
 *
 * Single-row design — writes target id='default'; RLS scopes to the user.
 * Degrades gracefully when the column/table hasn't been migrated yet.
 */

import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { userConflict } from '@/lib/tenant-conflict'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const MIGRATION_HINT =
  'Apply supabase/migrations/20260702_commission_per_side.sql in the Supabase dashboard to enable.'

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('trader_profile')
    .select('commission_per_side, updated_at')
    .eq('id', 'default')
    .maybeSingle()
  if (error) {
    // Column absent (42703/PGRST204) or table absent (42P01/PGRST205) →
    // return a clean default + migration hint rather than a 500.
    if (['42703', 'PGRST204', '42P01', 'PGRST205'].includes(error.code)) {
      return NextResponse.json({ commission_per_side: 0, migration_pending: true, hint: MIGRATION_HINT })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    commission_per_side: Number(data?.commission_per_side ?? 0),
    updated_at: data?.updated_at ?? null,
  })
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: { commission_per_side?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const raw = body.commission_per_side
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN
  if (!Number.isFinite(value) || value < 0 || value > 1000) {
    return NextResponse.json({ error: 'commission_per_side must be a number between 0 and 1000' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('trader_profile')
    .upsert({ id: 'default', commission_per_side: value, updated_at: new Date().toISOString() }, { onConflict: userConflict('id') })
    .select('commission_per_side, updated_at')
    .single()
  if (error) {
    if (['42703', 'PGRST204', '42P01', 'PGRST205'].includes(error.code)) {
      return NextResponse.json({ error: 'commission column not found — apply the migration first', migration_pending: true, hint: MIGRATION_HINT }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    commission_per_side: Number(data.commission_per_side ?? value),
    updated_at: data.updated_at,
  })
}
