import { createClient } from '@/lib/supabase/server'
import { sessionUtcWindow } from '@/lib/pt-time'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * GET /api/bars?symbol=...&date=YYYY-MM-DD
 *
 * Returns bars for a full PT trading session, ascending by timestamp.
 * Used by the EOD page's LiveChart component.
 *
 * Bounds are anchored to the PT calendar day (sessionUtcWindow), not the raw
 * UTC day, so post-RTH / overnight (GBX) entries — which fall in the early
 * hours of the next UTC day — get their candles instead of silently dropping
 * off the right edge of the chart.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol')
  const date = searchParams.get('date')

  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 })
  if (!date) return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: `invalid date "${date}" — must be YYYY-MM-DD` }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const { start, end } = sessionUtcWindow(date)

  // Local build: bars are stored under the exact per-contract symbol the user
  // imported. Cloud build: bars come from the shared central feed keyed by the
  // mini price-series root (NQ/ES), so any micro/mini/dated contract resolves
  // to that one series. See chartSeriesRoot + scripts/public-bar-feed.ts.
  const querySymbol = LOCAL_FEATURES_ENABLED ? symbol : chartSeriesRoot(symbol)

  // Paginate past Supabase's default 1000-row response cap. A full PT session of
  // 1m bars is up to 1440 rows, so this is typically 2 round-trips.
  const PAGE = 1000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = []
  let from = 0
  // Hard ceiling so a bad query can't loop forever (10 pages = 10k bars).
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from('ohlcv_bars')
      .select('ts, open, high, low, close, volume')
      .eq('symbol', querySymbol)
      .gte('ts', start)
      .lte('ts', end)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[api/bars] query failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }

  return NextResponse.json({ bars: all })
}
