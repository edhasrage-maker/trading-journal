/**
 * Trader profile / coaching preferences API.
 *
 * GET  /api/trader-profile          → { preferences_md, updated_at }
 * PUT  /api/trader-profile { preferences_md } → upserts the single 'default' row
 *
 * Single-row design — all writes target id='default'. RLS handles auth.
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('trader_profile')
    .select('preferences_md, updated_at')
    .eq('id', 'default')
    .maybeSingle()
  if (error) {
    // PGRST205 / 42P01 → table missing (migration not applied).
    // Surface a clean 200 with empty profile + a hint instead of a 500 so the
    // settings page can render and tell the user what to do.
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return NextResponse.json({
        preferences_md: '',
        updated_at: null,
        migration_pending: true,
        hint: 'Apply supabase/migrations/20260617_trader_profile.sql in the Supabase dashboard to enable.',
      })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({
    preferences_md: data?.preferences_md ?? '',
    updated_at: data?.updated_at ?? null,
  })
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: { preferences_md?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  if (typeof body.preferences_md !== 'string') {
    return NextResponse.json({ error: 'preferences_md must be a string' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('trader_profile')
    .upsert(
      { id: 'default', preferences_md: body.preferences_md, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
    .select('preferences_md, updated_at')
    .single()
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return NextResponse.json({
        error: 'trader_profile table not found — apply the migration first',
        migration_pending: true,
      }, { status: 503 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({
    preferences_md: data.preferences_md,
    updated_at: data.updated_at,
  })
}
