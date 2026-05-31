import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { importScidDay, resolveSymbolScidMap } from '@/lib/import-scid-day'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Local (server === user's machine) calendar date, YYYY-MM-DD. */
function localToday(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * POST /api/bars/auto-import[?date=YYYY-MM-DD]
 *
 * Background refresh for the bar watcher. For every symbol that has ever been
 * imported, it re-derives that symbol's source .scid (from the latest
 * bar_imports row) and re-imports the target day — defaulting to today — so the
 * current session's bars stay fresh without any manual selection.
 *
 * Does NOT write bar_imports history rows (writeHistory: false) so polling
 * every few minutes doesn't flood the "Recent imports" table. The original
 * manual import per symbol is what establishes the symbol→.scid mapping; after
 * that, this keeps it current.
 *
 * Returns a per-symbol summary so the client can surface a status/toast.
 */
export async function POST(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date') || localToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'invalid date (YYYY-MM-DD)' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()
  const mapping = await resolveSymbolScidMap(supabase)
  if (mapping.size === 0) {
    return NextResponse.json({
      date,
      results: [],
      note: 'No symbol→.scid mapping yet. Import once from Settings → Bar Data to establish it.',
    })
  }

  const results: Array<{ symbol: string; scidFile: string; upserted?: number; error?: string }> = []
  for (const [symbol, scidFile] of mapping) {
    const outcome = await importScidDay(supabase, { scidFile, storeAs: symbol, date, writeHistory: false })
    if (outcome.ok) {
      results.push({ symbol, scidFile, upserted: outcome.result.upserted })
    } else {
      // "No ticks for today" is expected before/after hours — keep it quiet but reported.
      results.push({ symbol, scidFile, error: outcome.error })
    }
  }

  const totalUpserted = results.reduce((s, r) => s + (r.upserted ?? 0), 0)
  return NextResponse.json({ date, totalUpserted, results })
}
