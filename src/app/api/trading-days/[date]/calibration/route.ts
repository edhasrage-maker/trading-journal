import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { resilientUpsert } from '@/lib/resilient-upsert'
import type { ChartCalibration, TradingDay } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

type CalibrationBody = Omit<ChartCalibration, 'calibrated_at'>

function isValid(body: unknown): body is CalibrationBody {
  if (!body || typeof body !== 'object') return false
  const c = body as Record<string, unknown>
  const hasAnchor = (key: string, valueKey: 'price' | 'time') => {
    const a = c[key] as Record<string, unknown> | undefined
    if (!a) return false
    if (typeof a.x_pct !== 'number' || typeof a.y_pct !== 'number') return false
    if (valueKey === 'price' && typeof a.price !== 'number') return false
    if (valueKey === 'time' && typeof a.time !== 'string') return false
    return true
  }
  return (
    hasAnchor('high', 'price') &&
    hasAnchor('low', 'price') &&
    hasAnchor('start', 'time') &&
    hasAnchor('end', 'time')
  )
}

export async function POST(req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const body = await req.json()
  if (!isValid(body)) {
    return NextResponse.json(
      { error: 'Invalid calibration payload — expected { high, low, start, end } with anchor coords + values' },
      { status: 400 },
    )
  }

  const calibration: ChartCalibration = {
    ...body,
    calibrated_at: new Date().toISOString(),
  }

  const supabase: AnyClient = await createClient()
  const { data: day, error, droppedColumns } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    {
      date,
      chart_calibration_json: calibration,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'date' },
  )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ calibration, day, droppedColumns: droppedColumns.length > 0 ? droppedColumns : undefined })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  const { data: day, error, droppedColumns } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    { date, chart_calibration_json: null, updated_at: new Date().toISOString() },
    { onConflict: 'date' },
  )

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ day, droppedColumns: droppedColumns.length > 0 ? droppedColumns : undefined })
}
