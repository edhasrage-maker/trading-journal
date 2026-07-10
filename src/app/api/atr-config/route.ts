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
import { normalizeAtrConfig, normalizeGiveBackAtr, DEFAULT_ATR_CONFIG, type AtrMethod } from '@/lib/atr-config'
import { getGiveBackAtr } from '@/lib/atr-config-server'

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
  // give_back_atr degrades independently (its own migration) — read it best-effort
  // so the ATR config still loads even when that column isn't present yet.
  const give_back_atr = await getGiveBackAtr(supabase)
  if (error) {
    if (MISSING.includes(error.code)) {
      return NextResponse.json({ ...DEFAULT_ATR_CONFIG, give_back_atr, migration_pending: true, hint: HINT })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    ...normalizeAtrConfig({ timeframe: data?.atr_timeframe, method: data?.atr_method, period: data?.atr_period }),
    give_back_atr,
  })
}

export async function PUT(req: Request) {
  const supabase: AnyClient = await createClient()
  let body: { timeframe?: unknown; method?: unknown; period?: unknown; give_back_atr?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }

  const cfg = normalizeAtrConfig({
    timeframe: Number(body.timeframe),
    method: body.method as AtrMethod,
    period: Number(body.period),
  })
  const giveBack = normalizeGiveBackAtr(body.give_back_atr)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = {
    id: 'default',
    atr_timeframe: cfg.timeframe, atr_method: cfg.method, atr_period: cfg.period,
    give_back_atr: giveBack,
    updated_at: new Date().toISOString(),
  }
  const upsert = (select: string) =>
    supabase.from('trader_profile').upsert(row, { onConflict: userConflict('id') }).select(select).single()

  let { data, error } = await upsert('atr_timeframe, atr_method, atr_period, give_back_atr')
  // give_back_atr column absent (its migration not yet applied) → strip it and
  // retry so the ATR settings still save; the multiple stays at its (unsaved)
  // normalized value and the client can surface a migration hint.
  let giveBackPending = false
  if (error && MISSING.includes(error.code) && 'give_back_atr' in row) {
    giveBackPending = true
    delete row.give_back_atr
    ;({ data, error } = await upsert('atr_timeframe, atr_method, atr_period'))
  }
  if (error) {
    if (MISSING.includes(error.code)) {
      return NextResponse.json({ error: 'ATR columns not found — apply the migration first.', migration_pending: true, hint: HINT }, { status: 503 })
    }
    return NextResponse.json({ error: clientError(error) }, { status: 500 })
  }
  return NextResponse.json({
    ...normalizeAtrConfig({ timeframe: data.atr_timeframe, method: data.atr_method, period: data.atr_period }),
    give_back_atr: data.give_back_atr != null ? normalizeGiveBackAtr(data.give_back_atr) : giveBack,
    give_back_migration_pending: giveBackPending,
  })
}
