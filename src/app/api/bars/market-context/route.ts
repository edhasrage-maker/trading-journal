import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { readScidBars, type OneMinBar } from '@/lib/scid-reader'
import { contextStatsForDate } from '@/lib/market-context-from-bars'
import type { SessionKind } from '@/lib/session-levels'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { clientError } from '@/lib/api-error'
import { existsSync } from 'fs'
import { join, basename } from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const SIERRA_DATA_DIR = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'
// Wide enough to cover the target day plus ≥10 prior TRADING days (for the
// RVOL/ADR/IB-vs-10d trailing baselines) across weekends/holidays. 22 calendar
// days ≈ 15 trading days, so the target always gets a full 10-day baseline.
const LOOKBACK_DAYS = 22

/**
 * Paginate the shared ohlcv_bars for [startIso, endIso] (cloud stats source).
 * 22 days of 1-minute bars is ~30k rows, so page generously.
 */
async function fetchDbBars(
  supabase: AnyClient, symbol: string, startIso: string, endIso: string,
): Promise<OneMinBar[]> {
  const PAGE = 1000
  const out: OneMinBar[] = []
  let from = 0
  for (let page = 0; page < 40; page++) {
    const { data, error } = await supabase
      .from('ohlcv_bars')
      .select('ts, open, high, low, close, volume')
      .eq('symbol', symbol)
      .gte('ts', startIso)
      .lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) break
    const rows = (data ?? []) as OneMinBar[]
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

/**
 * GET /api/bars/market-context?symbol=X&date=YYYY-MM-DD[&scidFile=...&priceDivisor=100]
 *
 * Computes the day's volatility/volume Market Context stats (RVOL, ADR, ATR-10,
 * IB size, IB-close snapshots, day range, current price). Local build reads the
 * source `.scid`; cloud build computes from the shared ohlcv_bars feed (same
 * contextStatsForDate engine, different bar source) — so tapescore.app auto-fills
 * these too. Definitions match scripts/backfill-market-context-from-csv.ts.
 *
 * `stats.realized` is false when today's session hasn't printed yet (morning
 * prep) — in that case only adr/atr_1m/atr_10d_avg come back (carried from the
 * last completed day); the realized fields are null.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol')
  const date = searchParams.get('date')
  const explicitFile = searchParams.get('scidFile')
  const priceDivisor = Number(searchParams.get('priceDivisor') ?? '100') || 100
  const sessionParam = searchParams.get('session')
  const session: SessionKind = sessionParam === 'asia' || sessionParam === 'london' ? sessionParam : 'rth'

  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  // Cloud build: compute from the shared ohlcv_bars feed (root symbol) rather
  // than a local .scid. Same engine, DB bar source.
  if (!LOCAL_FEATURES_ENABLED) {
    const root = chartSeriesRoot(symbol)
    const targetStartMs = Date.parse(`${date}T00:00:00Z`)
    const startIso = new Date(targetStartMs - LOOKBACK_DAYS * 86_400_000).toISOString()
    const endIso = new Date(targetStartMs + 86_400_000).toISOString()
    const bars = await fetchDbBars(supabase, root, startIso, endIso)
    if (bars.length === 0) {
      return NextResponse.json(
        { error: `No bars for ${root} in the ${LOOKBACK_DAYS}-day lookback.`, stats: null },
        { status: 200 },
      )
    }
    const stats = contextStatsForDate(bars, date, session)
    return NextResponse.json({ stats })
  }

  // Local: resolve the source .scid from the symbol's latest SCID import (same
  // as /api/bars/levels — the chart only passes its symbol).
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
    return NextResponse.json({ error: `No SCID source known for ${symbol}.`, stats: null }, { status: 200 })
  }

  const safeName = basename(scidFile)
  if (safeName !== scidFile || !safeName.toLowerCase().endsWith('.scid')) {
    return NextResponse.json({ error: 'Invalid scidFile name' }, { status: 400 })
  }
  const fullPath = join(SIERRA_DATA_DIR, safeName)
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: `SCID file not found: ${fullPath}`, stats: null }, { status: 200 })
  }

  const targetStartMs = Date.parse(`${date}T00:00:00Z`)
  const startMs = targetStartMs - LOOKBACK_DAYS * 86_400_000
  const endMs = targetStartMs + 86_400_000

  let bars
  try {
    bars = readScidBars(fullPath, startMs, endMs, { priceDivisor }).bars
  } catch (e) {
    console.error('[bars/market-context] scid read failed:', e)
    return NextResponse.json({ error: clientError(e, 'SCID read failed') }, { status: 500 })
  }
  if (bars.length === 0) {
    return NextResponse.json({ error: `No bars in lookback for ${safeName}`, stats: null }, { status: 200 })
  }

  const stats = contextStatsForDate(bars, date, session)
  return NextResponse.json({ stats, scidFile: safeName })
}
