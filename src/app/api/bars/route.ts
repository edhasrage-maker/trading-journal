import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * GET /api/bars?symbol=...&date=YYYY-MM-DD
 *
 * Returns bars for a single calendar day (UTC), ascending by timestamp.
 * Used by the EOD page's LiveChart component.
 *
 * Caveat: bounds are UTC-date for v1. RTH session for US futures (typically
 * 06:30-13:00 PT = 13:30-20:00 UTC) fits within a single UTC day, so this is
 * usually correct. Overnight session bars on the previous trading day will
 * appear under the next UTC date — acceptable trade-off for v1; TZ-aware
 * boundaries can be added later if it becomes a friction point.
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
  const start = `${date}T00:00:00Z`
  const end = `${date}T23:59:59.999Z`

  // Paginate past Supabase's default 1000-row response cap. A full UTC day of
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
      .eq('symbol', symbol)
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
