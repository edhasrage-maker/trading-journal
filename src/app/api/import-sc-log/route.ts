import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseSierraChartLog, mapRowToTrade } from '@/lib/sc-importer'
import { resilientUpsert, resilientBulkUpsert, resilientUpdate } from '@/lib/resilient-upsert'
import type { TradingDay } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const date = (formData.get('date') as string | null) ?? new Date().toISOString().slice(0, 10)

  if (!file) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  // 1. Archive raw upload to sc-logs bucket
  const archivePath = `${date}-${Date.now()}-${file.name}`
  const buffer = await file.arrayBuffer()
  const { error: uploadError } = await supabase.storage
    .from('sc-logs')
    .upload(archivePath, buffer, { contentType: file.type || 'text/plain', upsert: true })
  if (uploadError) {
    return NextResponse.json(
      { error: `Failed to archive log: ${uploadError.message}` },
      { status: 500 },
    )
  }

  // 2. Parse
  const text = new TextDecoder().decode(buffer)
  const { rows, parseErrors, skippedFiltered } = parseSierraChartLog(text)

  const allDroppedColumns: Record<string, string[]> = {}

  // 3. Ensure trading_day exists (resilient — old columns only, should always work)
  const { data: day, error: dayError, droppedColumns: dayDropped } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    { date, updated_at: new Date().toISOString() },
    { onConflict: 'date' },
  )
  if (dayDropped.length > 0) allDroppedColumns['trading_days (day upsert)'] = dayDropped
  if (dayError || !day) {
    return NextResponse.json(
      { error: `Failed to upsert trading day: ${dayError?.message ?? 'unknown'}` },
      { status: 500 },
    )
  }

  // 4. Bulk upsert trades — resilient against missing exit_time/exit_price columns
  let inserted = 0
  let skippedDuplicates = 0
  if (rows.length > 0) {
    const payload = rows.map(r => mapRowToTrade(r, day.id))
    const { data: insertedRows, error: tradesError, droppedColumns: tradesDropped } =
      await resilientBulkUpsert<{ id: string }>(
        supabase,
        'trades',
        payload,
        { onConflict: 'sierra_trade_id', ignoreDuplicates: true },
      )
    if (tradesDropped.length > 0) allDroppedColumns['trades'] = tradesDropped
    if (tradesError) {
      return NextResponse.json(
        { error: `Failed to insert trades: ${tradesError.message}`, droppedColumns: allDroppedColumns },
        { status: 500 },
      )
    }
    inserted = insertedRows?.length ?? 0
    skippedDuplicates = payload.length - inserted
  }

  // 5. Mark import on day — resilient against missing last_sc_import_* columns
  const { droppedColumns: markDropped } = await resilientUpdate<TradingDay>(
    supabase,
    'trading_days',
    {
      last_sc_import_at: new Date().toISOString(),
      last_sc_import_filename: file.name,
    },
    'id',
    day.id,
  )
  if (markDropped.length > 0) allDroppedColumns['trading_days (mark import)'] = markDropped

  return NextResponse.json({
    inserted,
    skippedDuplicates,
    skippedFiltered,
    parseErrors,
    archivedAs: archivePath,
    droppedColumns: Object.keys(allDroppedColumns).length > 0 ? allDroppedColumns : undefined,
  })
}
