import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { readScidBars } from '@/lib/scid-reader'
import { computeSessionLevels, DEFAULT_LEVELS_CONFIG, type RawBar } from '@/lib/session-levels'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { existsSync } from 'fs'
import { join, basename } from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * Paginate the shared ohlcv_bars for [startIso, endIso] (cloud levels source).
 * 8 days of 1-minute bars is ~11k rows, past the 1000-row cap, so we page.
 */
async function fetchDbBars(
  supabase: AnyClient, symbol: string, startIso: string, endIso: string,
): Promise<RawBar[]> {
  const PAGE = 1000
  const out: RawBar[] = []
  let from = 0
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabase
      .from('ohlcv_bars')
      .select('ts, open, high, low, close, volume')
      .eq('symbol', symbol)
      .gte('ts', startIso)
      .lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) break
    const rows = (data ?? []) as RawBar[]
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

const SIERRA_DATA_DIR = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'
// Days of lookback so weekly anchor (last Sun 15:00 PT), prior-day, and
// overnight windows all resolve. 8 covers a weekend gap comfortably.
const LOOKBACK_DAYS = 8

/**
 * GET /api/bars/levels?symbol=X&date=YYYY-MM-DD[&scidFile=...&priceDivisor=100]
 *
 * Computes session levels (PDH/PDL, ONH/ONL, IBH/IBL + extensions, RTH/Weekly
 * open) and per-bar study series (VWAP, EMA9/EMA20) for the target day,
 * reading the source .scid directly over an 8-day lookback.
 *
 * The source .scid is resolved from the symbol's most recent SCID bar_import
 * (its source_filename records the .scid name), so the chart only needs to
 * pass its symbol. An explicit scidFile param overrides.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol')
  const date = searchParams.get('date')
  const explicitFile = searchParams.get('scidFile')
  const priceDivisor = Number(searchParams.get('priceDivisor') ?? '100') || 100

  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const emaTf = Number(searchParams.get('emaTf') ?? '5') || 5

  // Cloud build: compute levels from the shared ohlcv_bars feed (root symbol)
  // rather than a local .scid. Same session-levels engine, different bar source.
  if (!LOCAL_FEATURES_ENABLED) {
    const root = chartSeriesRoot(symbol)
    const targetStartMs = Date.parse(`${date}T00:00:00Z`)
    const startIso = new Date(targetStartMs - LOOKBACK_DAYS * 86_400_000).toISOString()
    const endIso = new Date(targetStartMs + 86_400_000).toISOString()
    const bars = await fetchDbBars(supabase, root, startIso, endIso)
    if (bars.length === 0) {
      return NextResponse.json(
        { error: `No bars for ${root} in the ${LOOKBACK_DAYS}-day lookback.`, levels: null, series: [] },
        { status: 200 },
      )
    }
    const { levels, series } = computeSessionLevels(bars, date, {
      ...DEFAULT_LEVELS_CONFIG,
      emaTimeframeMins: emaTf,
    })
    return NextResponse.json({ levels, series })
  }

  // Resolve the source .scid filename from the latest SCID import for this symbol.
  let scidFile = explicitFile
  if (!scidFile) {
    const { data } = await supabase
      .from('bar_imports')
      .select('source_filename')
      .eq('symbol', symbol)
      .order('imported_at', { ascending: false })
      .limit(20)
    for (const row of (data ?? []) as { source_filename: string | null }[]) {
      const m = /([^\s/\\]+\.scid)/i.exec(row.source_filename ?? '')
      if (m) { scidFile = m[1]; break }
    }
  }
  if (!scidFile) {
    return NextResponse.json(
      { error: `No SCID source known for ${symbol}. Import bars from a .scid first (Settings → Bar Data).`, levels: null, series: [] },
      { status: 200 },
    )
  }

  const safeName = basename(scidFile)
  if (safeName !== scidFile || !safeName.toLowerCase().endsWith('.scid')) {
    return NextResponse.json({ error: 'Invalid scidFile name' }, { status: 400 })
  }
  const fullPath = join(SIERRA_DATA_DIR, safeName)
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: `SCID file not found: ${fullPath}`, levels: null, series: [] }, { status: 200 })
  }

  // Lookback window: 8 days before through end of target day (UTC bounds).
  const targetStartMs = Date.parse(`${date}T00:00:00Z`)
  const startMs = targetStartMs - LOOKBACK_DAYS * 86_400_000
  const endMs = targetStartMs + 86_400_000

  let bars
  try {
    bars = readScidBars(fullPath, startMs, endMs, { priceDivisor }).bars
  } catch (e) {
    console.error('[bars/levels] scid read failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'SCID read failed' }, { status: 500 })
  }

  if (bars.length === 0) {
    return NextResponse.json({ error: `No bars in lookback for ${safeName}`, levels: null, series: [] }, { status: 200 })
  }

  const { levels, series } = computeSessionLevels(bars, date, {
    ...DEFAULT_LEVELS_CONFIG,
    emaTimeframeMins: emaTf,
  })
  return NextResponse.json({ levels, series, scidFile: safeName })
}
