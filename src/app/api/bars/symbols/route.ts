import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * GET /api/bars/symbols → distinct instruments there are bars for, powering the
 * LiveChart instrument dropdown (NQ vs ES) so the chart — and the prep's market
 * context, which follows it — can switch to any product with data, not just the
 * ones traded that day.
 *
 * TWO sources, and both are required:
 *   • bar_imports — bars this user uploaded themselves (local/personal use).
 *   • ohlcv_bars  — the SHARED public feed every cloud account charts from.
 *
 * Only the first was consulted, so on a cloud account (which uploads nothing)
 * this returned an empty list. The dropdown then collapsed to the day's default
 * symbol and there was no way to switch to ES at all — even though the shared
 * feed carries roughly as many ES bars as NQ.
 */
export async function GET() {
  const supabase: AnyClient = await createClient()

  const [importsRes, feedRes] = await Promise.all([
    supabase
      .from('bar_imports')
      .select('symbol, imported_at')
      .order('imported_at', { ascending: false })
      .limit(300),
    // Distinct-ish over a recent slice rather than the whole table: ohlcv_bars
    // holds millions of rows and the feed only carries a handful of roots, so a
    // short window names all of them for a fraction of the cost.
    supabase
      .from('ohlcv_bars')
      .select('symbol')
      .gte('ts', new Date(Date.now() - 14 * 86400_000).toISOString())
      .limit(2000),
  ])

  const seen = new Set<string>()
  const symbols: string[] = []
  const add = (s: string | null) => {
    if (s && !seen.has(s)) { seen.add(s); symbols.push(s) }
  }
  // User's own imports first — they're the more specific contract names.
  for (const r of (importsRes?.data ?? []) as { symbol: string | null }[]) add(r.symbol)
  for (const r of (feedRes?.data ?? []) as { symbol: string | null }[]) add(r.symbol)

  return NextResponse.json({ symbols })
}
