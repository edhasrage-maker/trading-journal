/**
 * ATR measurement config API (per-user, stored on the trader_profile row).
 *
 * GET  /api/atr-config                                  → { timeframe, method, period }
 * PUT  /api/atr-config { timeframe, method, period }    → upserts + returns it
 *
 * Drives the ATR@ column + the ATR-unit R fallback. Degrades gracefully to the
 * default (1m Wilder-10) when the columns haven't been migrated yet.
 */
import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { userConflict } from '@/lib/tenant-conflict'
import { NextResponse } from 'next/server'
import { normalizeAtrConfig, DEFAULT_ATR_CONFIG, type AtrMethod } from '@/lib/atr-config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const MISSING = ['42703', 'PGRST204', '42P01', 'PGRST205']
const HINT = 'Add atr_timeframe / atr_method / atr_period to trader_profile to enable a custom ATR.'

export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('trader_profile')
    .select('atr_timeframe, atr_method, atr_period')
    .eq('id', 'default')
    .maybeSingle()
  if (error) {
    if (MISSING.includes(error.code)) {
      return NextResponse.json({ ...DEFAULT_ATR_CONFIG, migration_pending: true, hint: HINT })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json(
    normalizeAtrConfig({ timeframe: data?.atr_timeframe, method: data?.atr_method, period: data?.atr_period }),
  )
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: { timeframe?: unknown; method?: unknown; period?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const cfg = normalizeAtrConfig({
    timeframe: Number(body.timeframe),
    method: body.method as AtrMethod,
    period: Number(body.period),
  })

  const { data, error } = await supabase
    .from('trader_profile')
    .upsert(
      { id: 'default', atr_timeframe: cfg.timeframe, atr_method: cfg.method, atr_period: cfg.period, updated_at: new Date().toISOString() },
      { onConflict: userConflict('id') },
    )
    .select('atr_timeframe, atr_method, atr_period')
    .single()
  if (error) {
    if (MISSING.includes(error.code)) {
      return NextResponse.json({ error: 'ATR columns not found — apply the migration first.', migration_pending: true, hint: HINT }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json(
    normalizeAtrConfig({ timeframe: data.atr_timeframe, method: data.atr_method, period: data.atr_period }),
  )
}
