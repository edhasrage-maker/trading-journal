import { createClient } from '@/lib/supabase/server'
import { clientError } from '@/lib/api-error'
import { userConflict } from '@/lib/tenant-conflict'
import { signTradeScreenshots, signTradeScreenshot, normalizeStoredScreenshot } from '@/lib/storage-url'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })

  const supabase: AnyClient = await createClient()
  const { data: day } = await supabase.from('trading_days').select('id').eq('date', date).single()
  if (!day) return NextResponse.json([])

  const { data: trades } = await supabase
    .from('trades').select('*').eq('trading_day_id', day.id).order('entry_time', { ascending: true })
  await signTradeScreenshots(supabase, trades ?? [])
  return NextResponse.json(trades ?? [])
}

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const body = await req.json()
  const { date, ...tradeData } = body

  // Hosted build: persist screenshot as a stable storage path, de-signing any
  // signed URL the client echoed back (see normalizeStoredScreenshot). Local
  // owner build stores public URLs unchanged.
  if (!LOCAL_FEATURES_ENABLED && 'screenshot_url' in tradeData) {
    tradeData.screenshot_url = normalizeStoredScreenshot(tradeData.screenshot_url)
  }

  const { data: day, error: dayError } = await supabase
    .from('trading_days')
    .upsert({ date, updated_at: new Date().toISOString() }, { onConflict: userConflict('date') })
    .select().single()

  if (dayError) return NextResponse.json({ error: dayError.message }, { status: 500 })

  const { data: trade, error } = await supabase
    .from('trades')
    .insert({ trading_day_id: day.id, ...tradeData })
    .select().single()

  if (error) return NextResponse.json({ error: clientError(error) }, { status: 500 })
  await signTradeScreenshot(supabase, trade)
  return NextResponse.json(trade)
}
