/**
 * Trading-defaults API (Account Settings → Profile). Per-user, stored on the
 * trader_profile 'default' row alongside commission_per_side.
 *
 * GET  /api/trading-defaults  → { display_name, default_instrument, account_size, timezone }
 * PUT  /api/trading-defaults  → upserts any provided subset of those fields
 *
 * Kept separate from /api/user-settings (commissions) so the two settings cards
 * write independently; both upsert id='default' touching only their own columns.
 * Degrades gracefully when the columns haven't been migrated yet.
 */

import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { userConflict } from '@/lib/tenant-conflict'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const MIGRATION_HINT =
  'Apply supabase/migrations/20260703_trading_defaults.sql in the Supabase dashboard to enable.'
const MIGRATION_CODES = ['42703', 'PGRST204', '42P01', 'PGRST205']

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('trader_profile')
    .select('display_name, default_instrument, account_size, timezone, updated_at')
    .eq('id', 'default')
    .maybeSingle()
  if (error) {
    if (MIGRATION_CODES.includes(error.code)) {
      return NextResponse.json({ display_name: '', default_instrument: '', account_size: null, timezone: '', migration_pending: true, hint: MIGRATION_HINT })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    display_name: data?.display_name ?? '',
    default_instrument: data?.default_instrument ?? '',
    account_size: data?.account_size ?? null,
    timezone: data?.timezone ?? '',
    updated_at: data?.updated_at ?? null,
  })
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = { id: 'default', updated_at: new Date().toISOString() }

  if ('display_name' in body) {
    if (body.display_name != null && typeof body.display_name !== 'string') return NextResponse.json({ error: 'display_name must be a string' }, { status: 400 })
    row.display_name = body.display_name ? String(body.display_name).slice(0, 80) : null
  }
  if ('default_instrument' in body) {
    if (body.default_instrument != null && typeof body.default_instrument !== 'string') return NextResponse.json({ error: 'default_instrument must be a string' }, { status: 400 })
    // May be a comma-separated list of instruments (first = primary). Cap wide enough to hold a handful.
    row.default_instrument = body.default_instrument ? String(body.default_instrument).trim().toUpperCase().slice(0, 120) : null
  }
  if ('account_size' in body) {
    const v = body.account_size
    if (v === null || v === '') row.account_size = null
    else {
      const n = typeof v === 'number' ? v : parseFloat(String(v))
      if (!Number.isFinite(n) || n < 0 || n > 1e9) return NextResponse.json({ error: 'account_size must be a non-negative number' }, { status: 400 })
      row.account_size = n
    }
  }
  if ('timezone' in body) {
    if (body.timezone != null && typeof body.timezone !== 'string') return NextResponse.json({ error: 'timezone must be a string' }, { status: 400 })
    row.timezone = body.timezone ? String(body.timezone).slice(0, 60) : null
  }

  const { data, error } = await supabase
    .from('trader_profile')
    .upsert(row, { onConflict: userConflict('id') })
    .select('display_name, default_instrument, account_size, timezone, updated_at')
    .single()
  if (error) {
    if (MIGRATION_CODES.includes(error.code)) {
      return NextResponse.json({ error: 'trading-defaults columns not found — apply the migration first', migration_pending: true, hint: MIGRATION_HINT }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    display_name: data.display_name ?? '',
    default_instrument: data.default_instrument ?? '',
    account_size: data.account_size ?? null,
    timezone: data.timezone ?? '',
    updated_at: data.updated_at,
  })
}
