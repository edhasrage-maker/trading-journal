import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { normalizeTagArray, type TradeTags } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface ReqBody {
  date: string       // YYYY-MM-DD
  dayType: string    // e.g. "Trend Day"
}

interface TradeRow {
  id: string
  tags_json: TradeTags | null
}

/**
 * POST /api/trades/backfill-day-type
 *   body: { date, dayType }
 *
 * Overwrites tags_json.day_type = [dayType] on every trade for the given date,
 * preserving all other tag categories. Trades that already have exactly this
 * single-element day_type are skipped to avoid noisy updated_at bumps.
 *
 * Trading_days.day_type itself is NOT touched here — the prep save handles that.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as ReqBody
  const { date, dayType } = body

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }
  if (typeof dayType !== 'string' || !dayType.trim()) {
    return NextResponse.json({ error: 'dayType must be a non-empty string' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  const { data: day } = await supabase
    .from('trading_days')
    .select('id')
    .eq('date', date)
    .single()
  if (!day) {
    return NextResponse.json({ updated: 0, total: 0, skipped: 0 })
  }

  const { data: trades, error } = await supabase
    .from('trades')
    .select('id, tags_json')
    .eq('trading_day_id', day.id) as { data: TradeRow[] | null; error: { message: string } | null }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const all = trades ?? []
  const needsUpdate = all.filter(t => {
    const cur = normalizeTagArray(t.tags_json?.day_type)
    return cur.length !== 1 || cur[0] !== dayType
  })

  let updated = 0
  const failures: { id: string; error: string }[] = []
  for (const t of needsUpdate) {
    const newTags = { ...(t.tags_json ?? {}), day_type: [dayType] }
    const { error: upErr } = await supabase
      .from('trades')
      .update({ tags_json: newTags, updated_at: new Date().toISOString() })
      .eq('id', t.id)
    if (upErr) {
      failures.push({ id: t.id, error: upErr.message })
    } else {
      updated++
    }
  }

  return NextResponse.json({
    updated,
    total: all.length,
    skipped: all.length - needsUpdate.length,
    ...(failures.length > 0 && { failures }),
  })
}
