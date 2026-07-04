import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { signTradeScreenshot, normalizeStoredScreenshot } from '@/lib/storage-url'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
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

  // Hosted build: de-sign echoed screenshot URLs back to a stable storage path.
  if (!LOCAL_FEATURES_ENABLED && 'screenshot_url' in tradeData) {
    tradeData.screenshot_url = normalizeStoredScreenshot(tradeData.screenshot_url)
  }

  const { data, error } = await supabase
    .from('trades')
    .update({ ...tradeData, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select().single()

  if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })
  await signTradeScreenshot(supabase, data)
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase: AnyClient = await createClient()
  const { error } = await supabase.from('trades').delete().eq('id', id)
  if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })
  return NextResponse.json({ ok: true })
}
