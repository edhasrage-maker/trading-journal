import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseSierraChartLog, mapRowToTrade } from '@/lib/sc-importer'
import { resilientUpsert, resilientBulkUpsert, resilientUpdate } from '@/lib/resilient-upsert'
import { perLegMaxDollars, type BarLike } from '@/lib/analytics'
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
    console.error('[import-sc-log] storage upload failed:', uploadError)
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
    console.error('[import-sc-log] trading_days upsert failed:', dayError)
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
        // Update SC-owned fields on existing rows (so new columns backfill
        // on re-import and fill corrections take effect). Safe because the
        // payload from mapRowToTrade deliberately excludes user-owned fields
        // (tags, screenshot, plan levels), so DO UPDATE only touches the SC
        // columns and leaves manual edits intact.
        { onConflict: 'sierra_trade_id', ignoreDuplicates: false },
      )
    if (tradesDropped.length > 0) allDroppedColumns['trades'] = tradesDropped
    if (tradesError) {
      console.error('[import-sc-log] trades bulk upsert failed:', tradesError, 'droppedColumns:', allDroppedColumns)
      return NextResponse.json(
        { error: `Failed to insert trades: ${tradesError.message}`, droppedColumns: allDroppedColumns },
        { status: 500 },
      )
    }
    inserted = insertedRows?.length ?? 0
    skippedDuplicates = payload.length - inserted

    // 4b. Auto-populate mfe_dollars_per_leg for multi-leg (scale-out) trades.
    // Previously a manual backfill step (scripts/backfill-per-leg-mfe.ts);
    // now runs at import time so the scaling-aware MFE Capture is correct
    // in the dashboard / EOD recap immediately, instead of being null until
    // the backfill is re-run.
    //
    // Uses ohlcv_bars (populated by BarWatcher every ~3 min, so today's bars
    // exist by the time SC log is uploaded). Skips silently per-trade if
    // bars are missing — those rows stay null and read-time falls back to
    // the simple peak × full-qty formula.
    const multiLegRows = payload.filter(r => Array.isArray(r.exits_json) && r.exits_json.length > 1 && !!r.symbol)
    if (multiLegRows.length > 0) {
      // Day window for bar fetch: from earliest entry to last exit + 1 min.
      // ohlcv_bars stores timestamptz; rely on the (symbol, ts) index.
      const dayStart = `${date}T00:00:00Z`
      const dayEnd = `${date}T23:59:59Z`
      const symbols = Array.from(new Set(multiLegRows.map(r => r.symbol!)))
      const barsBySymbol = new Map<string, BarLike[]>()
      for (const symbol of symbols) {
        const { data: barRows } = await supabase
          .from('ohlcv_bars')
          .select('ts, high, low')
          .eq('symbol', symbol)
          .gte('ts', dayStart)
          .lte('ts', dayEnd)
          .order('ts', { ascending: true })
        if (barRows && barRows.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          barsBySymbol.set(symbol, (barRows as any[]).map(b => ({ ts: b.ts, high: Number(b.high), low: Number(b.low) })))
        }
      }
      let computed = 0
      let barsGap = 0
      for (const r of multiLegRows) {
        const bars = barsBySymbol.get(r.symbol!)
        if (!bars || bars.length === 0) { barsGap++; continue }
        // Cast: perLegMaxDollars only reads entry_price/direction/quantity/
        // symbol/exits_json/entry_time/high|low_during_position. The full
        // TradeWithExcursion type wants more fields the SC importer doesn't
        // produce yet (pnl is here but stop_price etc. aren't); the cast is
        // safe because the function's read-set is a subset.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value = perLegMaxDollars(r as any, bars)
        if (value == null) { barsGap++; continue }
        // Update via sierra_trade_id since that's the row's stable key in
        // resilientBulkUpsert above. Fire-and-forget — one trade missing
        // mfe_dollars_per_leg doesn't fail the whole import.
        const rounded = Math.round(value * 100) / 100
        await supabase.from('trades')
          .update({ mfe_dollars_per_leg: rounded })
          .eq('sierra_trade_id', r.sierra_trade_id)
        computed++
      }
      if (computed > 0 || barsGap > 0) {
        console.log(`[import-sc-log] mfe_dollars_per_leg: computed=${computed}, bars-gap=${barsGap}, single-leg-skipped=${payload.length - multiLegRows.length}`)
      }
    }
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
