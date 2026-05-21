import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { resilientUpsert } from '@/lib/resilient-upsert'
import type { TradingDay, EodAiAnalysis } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface EodPostBody {
  eod_notes?: string | null
  eod_pnl?: number | null
  eod_chart_screenshot_url?: string | null
  eod_ai_analysis_json?: EodAiAnalysis
}

export async function POST(req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const body = (await req.json()) as EodPostBody

  const update: Record<string, unknown> = {
    date,
    updated_at: new Date().toISOString(),
  }
  if (body.eod_notes !== undefined) update.eod_notes = body.eod_notes
  if (body.eod_pnl !== undefined) update.eod_pnl = body.eod_pnl
  if (body.eod_chart_screenshot_url !== undefined) update.eod_chart_screenshot_url = body.eod_chart_screenshot_url
  if (body.eod_ai_analysis_json !== undefined) update.eod_ai_analysis_json = body.eod_ai_analysis_json

  const { data: day, error, droppedColumns } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    update,
    { onConflict: 'date' },
  )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ day, droppedColumns: droppedColumns.length > 0 ? droppedColumns : undefined })
}
