import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase: AnyClient = await createClient()
  const body = await req.json()
  // `date` is the page's trading day, not a column on trades (it maps to
  // trading_day_id, already set on the row). Strip it so the update doesn't
  // reference a non-existent column — same as POST. Editing never changes the day.
  const { date: _date, ...tradeData } = body
  void _date

  const { data, error } = await supabase
    .from('trades')
    .update({ ...tradeData, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase: AnyClient = await createClient()
  const { error } = await supabase.from('trades').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
