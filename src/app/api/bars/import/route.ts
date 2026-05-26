import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseBarCsv } from '@/lib/bar-importer'
import type { BarGranularity } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const ALLOWED_GRANULARITIES: BarGranularity[] = ['1m', '5m', '15m', '1h', '1d']
// Supabase has practical row-count and request-size limits. 1000 rows/upsert
// is a comfortable batch — covers a typical day of 1m bars (~390 RTH) in one
// shot, falls back gracefully for larger windows.
const UPSERT_CHUNK_SIZE = 1000

/**
 * CSV bar-import endpoint.
 *
 * Form fields:
 *   file:        the CSV (required)
 *   symbol:      e.g. "MNQM6.CME" — keyed alongside ts in ohlcv_bars (required)
 *   granularity: '1m' | '5m' | '15m' | '1h' | '1d' (required)
 *
 * On success returns:
 *   { inserted, symbol, granularity, dateRangeStart, dateRangeEnd, parseErrors? }
 *
 * Upserts on conflict (symbol, ts) DO UPDATE so re-imports refresh bars.
 * Tracking row inserted into bar_imports for the history widget.
 */
export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const form = await req.formData()
  const file = form.get('file') as File | null
  const symbol = ((form.get('symbol') as string | null) ?? '').trim()
  const granularity = ((form.get('granularity') as string | null) ?? '1m') as BarGranularity

  if (!file) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }
  if (!symbol) {
    return NextResponse.json({ error: 'Missing symbol' }, { status: 400 })
  }
  if (!ALLOWED_GRANULARITIES.includes(granularity)) {
    return NextResponse.json(
      { error: `Invalid granularity "${granularity}"; must be one of ${ALLOWED_GRANULARITIES.join(', ')}` },
      { status: 400 },
    )
  }

  const text = await file.text()
  const { rows, parseErrors, dateRangeStart, dateRangeEnd } = parseBarCsv(text)

  if (rows.length === 0) {
    return NextResponse.json(
      { error: 'No valid bars to import', parseErrors },
      { status: 400 },
    )
  }

  const payload = rows.map(r => ({
    symbol,
    ts: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }))

  let upserted = 0
  for (let i = 0; i < payload.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = payload.slice(i, i + UPSERT_CHUNK_SIZE)
    const { error } = await supabase
      .from('ohlcv_bars')
      .upsert(chunk, { onConflict: 'symbol,ts' })
    if (error) {
      console.error('[bars/import] upsert chunk failed at row', i, ':', error)
      return NextResponse.json(
        {
          error: `Upsert failed at chunk starting row ${i}: ${error.message}`,
          parseErrors,
          partialUpserted: upserted,
        },
        { status: 500 },
      )
    }
    upserted += chunk.length
  }

  // Tracking row — non-fatal if it fails; the bars are already in.
  const { error: trackError } = await supabase.from('bar_imports').insert({
    symbol,
    granularity,
    date_range_start: dateRangeStart,
    date_range_end: dateRangeEnd,
    rows_inserted: upserted,
    rows_updated: null,
    source_filename: file.name,
  })
  if (trackError) {
    console.error('[bars/import] bar_imports tracking insert failed:', trackError)
  }

  return NextResponse.json({
    upserted,
    symbol,
    granularity,
    dateRangeStart,
    dateRangeEnd,
    parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
  })
}

/**
 * History endpoint — returns recent bar_imports rows for the settings UI.
 */
export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data, error } = await supabase
    .from('bar_imports')
    .select('*')
    .order('imported_at', { ascending: false })
    .limit(50)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data ?? [])
}
