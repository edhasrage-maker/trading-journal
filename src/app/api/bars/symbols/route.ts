import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * GET /api/bars/symbols → distinct instruments the user has imported bars for,
 * most-recently-imported first. Powers the LiveChart header instrument dropdown
 * (e.g. NQ vs ES), so the chart can switch to any product with bar data — not
 * just the ones traded that day.
 */
export async function GET() {
  const supabase: AnyClient = await createClient()
  const { data } = await supabase
    .from('bar_imports')
    .select('symbol, imported_at')
    .order('imported_at', { ascending: false })
    .limit(300)
  const seen = new Set<string>()
  const symbols: string[] = []
  for (const r of (data ?? []) as { symbol: string | null }[]) {
    if (r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); symbols.push(r.symbol) }
  }
  return NextResponse.json({ symbols })
}
