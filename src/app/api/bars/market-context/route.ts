import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { readScidBars } from '@/lib/scid-reader'
import { contextStatsForDate } from '@/lib/market-context-from-bars'
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
 * GET /api/bars/market-context?symbol=X&date=YYYY-MM-DD[&scidFile=...&priceDivisor=100]
 *
 * Computes the day's volatility/volume Market Context stats (RVOL, ADR, ATR-10,
 * IB size, IB-close snapshots, day range, current price) directly from the
 * source `.scid` — the bar-native equivalent of the numbers the user otherwise
 * reads off a Sierra screenshot via /api/extract-context. Same definitions as
 * scripts/backfill-market-context-from-csv.ts, so live and backfilled match.
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

  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  // Resolve the source .scid from the symbol's latest SCID import (same as
  // /api/bars/levels — the chart only passes its symbol).
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

  const stats = contextStatsForDate(bars, date)
  return NextResponse.json({ stats, scidFile: safeName })
}
