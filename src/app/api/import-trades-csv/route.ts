import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseTradeCsv } from '@/lib/csv-trade-import'
import { parseSierraChartLog } from '@/lib/sc-importer'

/**
 * POST /api/import-trades-csv
 *
 * Cloud-safe bulk importer. Handles TWO shapes, auto-detected:
 *   1. Broker/journal trade CSVs (NinjaTrader, Tradovate, Tradezella, generic)
 *      — one row per completed trade → parseTradeCsv().
 *   2. Sierra Chart trade-activity logs (tab-separated `.txt`, one row per FILL)
 *      — reconstructed into trades by parseSierraChartLog() (the same pure parser
 *      the local SC importer uses; no filesystem access, so it runs in the cloud).
 *
 * Accepts a multipart file upload (field `file`) or a JSON body `{ csv }`.
 * Both paths converge on: group by date → find-or-create a trading_day per date →
 * upsert trades. user_id fills from the DB column default (auth.uid()); RLS scopes
 * everything to the signed-in user; sierra_trade_id is the idempotent dedup key.
 */

interface PendingTrade {
  trade_date: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: Record<string, any>
}

/**
 * A Sierra Chart trade-activity log is tab-separated and always carries the
 * `ActivityType` + `FillPrice` columns in its header. That signature is what
 * distinguishes it from a comma-separated broker/journal CSV.
 */
function isSierraLog(text: string): boolean {
  const nl = text.indexOf('\n')
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).toLowerCase()
  return firstLine.includes('\t') && firstLine.includes('activitytype') && firstLine.includes('fillprice')
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  // The generated Supabase types resolve inserts/upserts on these tables to
  // `never` (a known supabase-js typing quirk the rest of the codebase also
  // works around). Use an untyped handle for the data calls; auth stays typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

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

  // --- Parse (auto-detect Sierra Chart fill log vs. trade CSV) ---
  const pending: PendingTrade[] = []
  let total = 0
  let skipped = 0
  const warnings: string[] = []

  if (isSierraLog(csvText)) {
    const { rows, parseErrors, skippedFiltered } = parseSierraChartLog(csvText)
    skipped = skippedFiltered
    total = rows.length + skippedFiltered
    // Surface the first few parse errors (invalid rows) but don't flood the UI.
    for (const e of parseErrors.slice(0, 5)) warnings.push(e)
    if (skippedFiltered > 0) {
      warnings.push(`${skippedFiltered} fill(s) from sim/None accounts were skipped (live accounts only).`)
    }
    // Sierra logs carry no timezone marker; times are read in the server's zone.
    warnings.push('Sierra Chart times have no timezone in the log, so they may display shifted from your local clock. P&L, MFE/MAE, and pairing are unaffected.')
    for (const r of rows) {
      const trade_date = (r.entry_time_iso || '').slice(0, 10)
      if (!trade_date) { skipped++; continue }
      pending.push({
        trade_date,
        row: {
          sierra_trade_id: r.sierra_trade_id,
          symbol: r.symbol,
          entry_time: r.entry_time_iso,
          entry_price: r.entry_price,
          exit_time: r.exit_time_iso ?? null,
          exit_price: r.exit_price ?? null,
          direction: r.direction,
          quantity: r.quantity,
          pnl: r.pnl,
          high_during_position: r.high_during_position,
          low_during_position: r.low_during_position,
          exits_json: r.exits,
        },
      })
    }
  } else {
    const res = parseTradeCsv(csvText)
    total = res.total
    skipped = res.skipped
    warnings.push(...res.warnings)
    for (const t of res.trades) {
      pending.push({
        trade_date: t.trade_date,
        row: {
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
        },
      })
    }
  }

  if (pending.length === 0) {
    return NextResponse.json(
      { error: 'No importable trades were found in this file.', total, skipped, warnings },
      { status: 422 },
    )
  }

  // Find-or-create a trading_day per distinct date (RLS scopes to this user).
  const dates = Array.from(new Set(pending.map(p => p.trade_date)))
  const dayIdByDate = new Map<string, string>()
  for (const date of dates) {
    const { data: existing } = await db
      .from('trading_days').select('id').eq('date', date).maybeSingle()
    if (existing?.id) { dayIdByDate.set(date, existing.id as string); continue }
    const { data: created, error } = await db
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
  const rows = pending.map(p => ({ ...p.row, trading_day_id: dayIdByDate.get(p.trade_date)! }))

  const { data: inserted, error: insErr } = await db
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
    parsed: pending.length,
    days: dates.length,
    total,
    skipped,
    warnings,
  })
}
