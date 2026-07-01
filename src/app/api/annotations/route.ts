import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * CRUD for chart_annotations — user drawings on the LiveChart, scoped per
 * trading day + symbol so a zone drawn for one day/instrument never bleeds
 * onto another.
 *
 *   GET    /api/annotations?date=YYYY-MM-DD&symbol=...   list for that day
 *   POST   /api/annotations   { date, symbol, kind, geom, note?, color? }
 *   PATCH  /api/annotations?id=...   { geom?, note?, color? }
 *   DELETE /api/annotations?id=...
 *
 * geom is opaque JSON (anchor points), interpreted by the client per `kind`.
 * For a zone it's { t1, p1, t2, p2 } (two time/price corners).
 */

const KINDS = new Set(['zone', 'level', 'trendline', 'arrow', 'text'])

/** Resolve a YYYY-MM-DD to its trading_day id. Creates the day when `create`
 *  is set (so you can annotate a session that has no prep/trades row yet). */
async function dayId(supabase: AnyClient, date: string, create: boolean): Promise<string | null> {
  const { data } = await supabase.from('trading_days').select('id').eq('date', date).maybeSingle()
  if (data?.id) return data.id
  if (!create) return null
  const { data: made } = await supabase
    .from('trading_days')
    .upsert({ date }, { onConflict: 'date' })
    .select('id')
    .single()
  return made?.id ?? null
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  const symbol = searchParams.get('symbol')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 })
  }
  const supabase: AnyClient = await createClient()
  const tdid = await dayId(supabase, date, false)
  if (!tdid) return NextResponse.json({ annotations: [] })
  let q = supabase.from('chart_annotations').select('*').eq('trading_day_id', tdid).order('created_at')
  if (symbol) q = q.eq('symbol', symbol)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ annotations: data ?? [] })
}

export async function POST(req: Request) {
  let body: { date?: string; symbol?: string; kind?: string; geom?: unknown; note?: string; color?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const { date, symbol, kind, geom, note, color } = body
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'date required' }, { status: 400 })
  if (!kind || !KINDS.has(kind)) return NextResponse.json({ error: 'invalid kind' }, { status: 400 })
  if (geom == null || typeof geom !== 'object') return NextResponse.json({ error: 'geom required' }, { status: 400 })

  const supabase: AnyClient = await createClient()
  const tdid = await dayId(supabase, date, true)
  if (!tdid) return NextResponse.json({ error: 'could not resolve trading day' }, { status: 500 })
  const { data, error } = await supabase
    .from('chart_annotations')
    .insert({ trading_day_id: tdid, symbol: symbol ?? null, kind, geom, note: note ?? '', color: color ?? '#ef4444' })
    .select('*')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ annotation: data })
}

export async function PATCH(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  let body: { geom?: unknown; note?: string; color?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.geom !== undefined) patch.geom = body.geom
  if (body.note !== undefined) patch.note = body.note
  if (body.color !== undefined) patch.color = body.color

  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase.from('chart_annotations').update(patch).eq('id', id).select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ annotation: data })
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const supabase: AnyClient = await createClient()
  const { error } = await supabase.from('chart_annotations').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
