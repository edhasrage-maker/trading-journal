import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { resilientUpsert } from '@/lib/resilient-upsert'
import type { TradingDay, MarketContext, Trade } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function GET(_req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const { data: day } = await supabase
    .from('trading_days').select('*').eq('date', date).single() as { data: TradingDay | null }
  const { data: context } = await supabase
    .from('market_context').select('*').eq('trading_day_id', day?.id ?? '').single() as { data: MarketContext | null }
  return NextResponse.json({ day: day ?? null, context: context ?? null })
}

export async function POST(req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const body = await req.json()
  const { marketContext, prepNotes, chartScreenshotUrl, dayType, aiAnalysis, prepStartedAt, prepCompletedAt } = body

  // For prep_started_at: only set if not already set on the row (preserve the
  // original first-edit timestamp across subsequent saves). Read the existing
  // row first so we can decide.
  const { data: existing } = await supabase
    .from('trading_days')
    .select('prep_started_at')
    .eq('date', date)
    .maybeSingle() as { data: { prep_started_at: string | null } | null }

  const shouldSetStarted =
    prepStartedAt !== undefined && !existing?.prep_started_at

  const payload: Record<string, unknown> = {
    date,
    ...(chartScreenshotUrl !== undefined && { chart_screenshot_url: chartScreenshotUrl }),
    ...(dayType !== undefined && { day_type: dayType }),
    ...(prepNotes !== undefined && { prep_notes_json: prepNotes }),
    ...(aiAnalysis !== undefined && { ai_analysis_json: aiAnalysis }),
    ...(shouldSetStarted && { prep_started_at: prepStartedAt }),
    ...(prepCompletedAt !== undefined && { prep_completed_at: prepCompletedAt }),
    updated_at: new Date().toISOString(),
  }

  const { data: day, error: dayError, droppedColumns } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    payload,
    { onConflict: 'date' },
  )

  if (dayError) return NextResponse.json({ error: dayError.message }, { status: 500 })

  if (marketContext && day) {
    const { error: ctxError } = await supabase
      .from('market_context')
      .upsert({ trading_day_id: day.id, ...marketContext }, { onConflict: 'trading_day_id' }) as { error: { message: string } | null }
    if (ctxError) return NextResponse.json({ error: ctxError.message }, { status: 500 })
  }

  return NextResponse.json({ day, droppedColumns: droppedColumns.length > 0 ? droppedColumns : undefined })
}

/**
 * Hard-delete a trading day and all its data.
 * Cascades via FK: trades, market_context.
 * Manually cleans up blobs in Supabase Storage that the FK can't reach:
 *   - day's prep chart_screenshot_url
 *   - day's eod_chart_screenshot_url
 *   - every trade's screenshot_url
 *
 * Body: { confirm: string } — must equal the date being deleted (type-to-confirm).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const body = await req.json().catch(() => ({})) as { confirm?: string }
  if (body.confirm !== date) {
    return NextResponse.json(
      { error: `Confirmation mismatch — expected "${date}".` },
      { status: 400 },
    )
  }

  const supabase: AnyClient = await createClient()

  // Fetch the day + all its trades to collect blob URLs
  const { data: day } = await supabase
    .from('trading_days')
    .select('id, chart_screenshot_url, eod_chart_screenshot_url')
    .eq('date', date)
    .maybeSingle() as { data: Pick<TradingDay, 'id' | 'chart_screenshot_url' | 'eod_chart_screenshot_url'> | null }

  if (!day) {
    return NextResponse.json({ error: 'Day not found' }, { status: 404 })
  }

  const { data: trades } = await supabase
    .from('trades')
    .select('screenshot_url')
    .eq('trading_day_id', day.id) as { data: Pick<Trade, 'screenshot_url'>[] | null }

  // Collect screenshot URLs to remove from storage
  const blobUrls: string[] = []
  if (day.chart_screenshot_url) blobUrls.push(day.chart_screenshot_url)
  if (day.eod_chart_screenshot_url) blobUrls.push(day.eod_chart_screenshot_url)
  for (const t of trades ?? []) {
    if (t.screenshot_url) blobUrls.push(t.screenshot_url)
  }

  // Convert public URLs → storage paths and delete from the screenshots bucket
  const marker = '/storage/v1/object/public/screenshots/'
  const paths = blobUrls
    .map(u => {
      const idx = u.indexOf(marker)
      return idx === -1 ? null : decodeURIComponent(u.slice(idx + marker.length).split('?')[0])
    })
    .filter((p): p is string => p != null)

  let blobsDeleted = 0
  if (paths.length > 0) {
    const { error: storageErr } = await supabase.storage.from('screenshots').remove(paths)
    if (!storageErr) blobsDeleted = paths.length
    // Don't bail on storage errors — proceed with the row delete so the user
    // isn't blocked. Orphaned blobs can be cleaned up later.
  }

  // Cascade-delete the day (FK handles trades + market_context)
  const { error: delErr } = await supabase
    .from('trading_days')
    .delete()
    .eq('id', day.id) as { error: { message: string } | null }

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  return NextResponse.json({
    deleted: true,
    tradesDeleted: trades?.length ?? 0,
    blobsDeleted,
    blobsAttempted: paths.length,
  })
}
