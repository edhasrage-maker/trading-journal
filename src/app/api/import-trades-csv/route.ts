import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseTradeCsv } from '@/lib/csv-trade-import'

/**
 * POST /api/import-trades-csv
 *
 * Cloud-safe bulk importer for broker/platform CSV exports (NinjaTrader,
 * Tradovate, generic). Accepts a multipart file upload (field `file`) or a JSON
 * body `{ csv }`. Parses → groups by date → find-or-creates a trading_day per
 * date → upserts trades. user_id is filled by the DB column default (auth.uid())
 * and RLS scopes everything to the signed-in user; sierra_trade_id carries a
 * synthesized dedup key so re-importing the same file is idempotent.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let csvText = ''
  const ctype = req.headers.get('content-type') || ''
  try {
    if (ctype.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 })
      }
      csvText = await (file as File).text()
    } else {
      const body = await req.json().catch(() => ({}))
      csvText = body.csv ?? ''
    }
  } catch {
    return NextResponse.json({ error: 'Could not read the upload.' }, { status: 400 })
  }
  if (!csvText.trim()) return NextResponse.json({ error: 'The file is empty.' }, { status: 400 })

  const { trades, total, skipped, warnings } = parseTradeCsv(csvText)
  if (trades.length === 0) {
    return NextResponse.json(
      { error: 'No importable trades were found in this file.', total, skipped, warnings },
      { status: 422 },
    )
  }

  // Find-or-create a trading_day per distinct date (RLS scopes to this user).
  const dates = Array.from(new Set(trades.map(t => t.trade_date)))
  const dayIdByDate = new Map<string, string>()
  for (const date of dates) {
    const { data: existing } = await supabase
      .from('trading_days').select('id').eq('date', date).maybeSingle()
    if (existing?.id) { dayIdByDate.set(date, existing.id as string); continue }
    const { data: created, error } = await supabase
      .from('trading_days').insert({ date }).select('id').single()
    if (error || !created) {
      return NextResponse.json(
        { error: `Failed to create trading day ${date}: ${error?.message ?? 'unknown error'}` },
        { status: 500 },
      )
    }
    dayIdByDate.set(date, created.id as string)
  }

  // user_id auto-fills from the column default (auth.uid()); the stale generated
  // types don't include it, so omitting it typechecks AND is correct at runtime.
  const rows = trades.map(t => ({
    trading_day_id: dayIdByDate.get(t.trade_date)!,
    entry_time: t.entry_time,
    exit_time: t.exit_time,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    stop_price: t.stop_price,
    direction: t.direction,
    quantity: t.quantity,
    pnl: t.pnl,
    symbol: t.symbol,
    high_during_position: t.high_during_position,
    low_during_position: t.low_during_position,
    sierra_trade_id: t.dedup_key,
  }))

  const { data: inserted, error: insErr } = await supabase
    .from('trades')
    .upsert(rows, { onConflict: 'user_id,sierra_trade_id', ignoreDuplicates: true })
    .select('id')
  if (insErr) {
    return NextResponse.json(
      { error: `Insert failed: ${insErr.message}`, total, skipped, warnings },
      { status: 500 },
    )
  }

  return NextResponse.json({
    imported: inserted?.length ?? 0,
    parsed: trades.length,
    days: dates.length,
    total,
    skipped,
    warnings,
  })
}
