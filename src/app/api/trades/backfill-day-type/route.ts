import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { normalizeTagArray, type TradeTags } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface ReqBody {
  date: string                  // YYYY-MM-DD
  dayType?: string              // legacy single primary; if dayTypes is absent, treated as [dayType]
  dayTypes?: string[]           // multi-select array (preferred when present)
}

interface TradeRow {
  id: string
  tags_json: TradeTags | null
}

/**
 * POST /api/trades/backfill-day-type
 *   body: { date, dayType?, dayTypes? }
 *
 * Overwrites tags_json.day_type on every trade for the given date with the
 * supplied label(s), preserving all other tag categories. Trades that already
 * match the full set are skipped. dayTypes (array) wins when both are sent.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as ReqBody
  const { date } = body

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }

  // Resolve target labels: prefer the explicit dayTypes array, fall back to
  // the legacy single dayType. Dedupe, trim, drop empties.
  const candidate = Array.isArray(body.dayTypes)
    ? body.dayTypes
    : (typeof body.dayType === 'string' ? [body.dayType] : [])
  const targetLabels = [...new Set(candidate.map(l => l.trim()).filter(Boolean))]
  if (targetLabels.length === 0) {
    return NextResponse.json({ error: 'dayType or dayTypes must contain at least one non-empty label' }, { status: 400 })
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
  // Treat trades whose current day_type matches the target set (order-insensitive)
  // as already-tagged so we skip the update.
  const targetSet = new Set(targetLabels)
  const needsUpdate = all.filter(t => {
    const cur = normalizeTagArray(t.tags_json?.day_type)
    if (cur.length !== targetSet.size) return true
    return cur.some(c => !targetSet.has(c))
  })

  let updated = 0
  const failures: { id: string; error: string }[] = []
  for (const t of needsUpdate) {
    const newTags = { ...(t.tags_json ?? {}), day_type: [...targetLabels] }
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
