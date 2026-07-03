/**
 * Trader profile / coaching preferences API.
 *
 * GET  /api/trader-profile          → { preferences_md, updated_at }
 * PUT  /api/trader-profile { preferences_md } → upserts the single 'default' row
 *
 * Single-row design — all writes target id='default'. RLS handles auth.
 */

import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET() {
  const supabase: AnyClient = await createClient()
  let { data, error } = await supabase
    .from('trader_profile')
    .select('preferences_md, focus_md, updated_at')
    .eq('id', 'default')
    .maybeSingle()
  // focus_md column absent (focus migration not yet applied) → 42703 / PGRST204.
  // Retry without it so the page still loads preferences; focus stays empty and
  // the client surfaces the focus-migration hint.
  let focusMigrationPending = false
  if (error && (error.code === '42703' || error.code === 'PGRST204')) {
    focusMigrationPending = true
    ;({ data, error } = await supabase
      .from('trader_profile')
      .select('preferences_md, updated_at')
      .eq('id', 'default')
      .maybeSingle())
  }
  if (error) {
    // PGRST205 / 42P01 → table missing (migration not applied).
    // Surface a clean 200 with empty profile + a hint instead of a 500 so the
    // settings page can render and tell the user what to do.
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return NextResponse.json({
        preferences_md: '',
        focus_md: '',
        updated_at: null,
        migration_pending: true,
        hint: 'Apply supabase/migrations/20260617_trader_profile.sql in the Supabase dashboard to enable.',
      })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    preferences_md: data?.preferences_md ?? '',
    focus_md: data?.focus_md ?? '',
    updated_at: data?.updated_at ?? null,
    focus_migration_pending: focusMigrationPending,
  })
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: { preferences_md?: unknown; focus_md?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  if (body.preferences_md !== undefined && typeof body.preferences_md !== 'string') {
    return NextResponse.json({ error: 'preferences_md must be a string' }, { status: 400 })
  }
  if (body.focus_md !== undefined && typeof body.focus_md !== 'string') {
    return NextResponse.json({ error: 'focus_md must be a string' }, { status: 400 })
  }
  if (body.preferences_md === undefined && body.focus_md === undefined) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = { id: 'default', updated_at: new Date().toISOString() }
  if (typeof body.preferences_md === 'string') row.preferences_md = body.preferences_md
  if (typeof body.focus_md === 'string') row.focus_md = body.focus_md

  const upsert = (select: string) =>
    supabase.from('trader_profile').upsert(row, { onConflict: 'id' }).select(select).single()

  let { data, error } = await upsert('preferences_md, focus_md, updated_at')
  // focus_md column absent → strip it from the write and retry so a
  // preferences-only save still succeeds before the focus migration runs.
  if (error && (error.code === '42703' || error.code === 'PGRST204') && 'focus_md' in row) {
    delete row.focus_md
    if (row.preferences_md === undefined) {
      return NextResponse.json({
        error: 'focus_md column not found — apply the focus migration first',
        focus_migration_pending: true,
      }, { status: 503 })
    }
    ;({ data, error } = await upsert('preferences_md, updated_at'))
  }
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return NextResponse.json({
        error: 'trader_profile table not found — apply the migration first',
        migration_pending: true,
      }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    preferences_md: data.preferences_md,
    focus_md: data.focus_md ?? '',
    updated_at: data.updated_at,
  })
}
