import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import Papa from 'papaparse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const FIELDS = ['pdh', 'pdl', 'onh', 'onl', 'ibh', 'ibl', 'ib_size', 'rvol', 'adr', 'ib_vs_10d_avg', 'atr_1m'] as const
type Field = typeof FIELDS[number]

interface CsvRow extends Partial<Record<Field, string>> {
  trade_date?: string
}

interface PerRowResult {
  trade_date: string
  status: 'inserted' | 'updated' | 'skipped' | 'failed'
  reason?: string
}

/**
 * POST /api/historical/import-market-context-csv
 * Body: { csv: string, dryRun?: boolean, force?: boolean }
 *
 * Accepts a CSV with columns `trade_date,pdh,pdl,onh,onl,ibh,ibl,ib_size,rvol,
 * adr,ib_vs_10d_avg,atr_1m`. Lines starting with '#' are treated as comments.
 * Empty numeric fields become NULL. Each row creates the trading_days entry
 * if it doesn't exist, then upserts the market_context row.
 *
 * Counterpart of the SCID-based backfill — meant for the "another Claude on a
 * different PC fills in the data" workflow (see docs/MARKET_CONTEXT_HANDOFF.md).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const csv: string | undefined = body?.csv
  const dryRun: boolean = body?.dryRun === true
  const force: boolean = body?.force === true

  if (!csv || typeof csv !== 'string') {
    return NextResponse.json({ error: 'csv (string) required' }, { status: 400 })
  }

  // Strip leading '#' comment lines so PapaParse sees only headers + data.
  const cleaned = csv
    .split(/\r?\n/)
    .filter(l => !/^\s*#/.test(l))
    .join('\n')

  const parsed = Papa.parse<CsvRow>(cleaned, { header: true, skipEmptyLines: true })
  if (parsed.errors.length > 0) {
    return NextResponse.json({
      error: 'CSV parse error',
      details: parsed.errors.slice(0, 5).map(e => `row ${e.row}: ${e.message}`),
    }, { status: 400 })
  }
  const rows = parsed.data

  // Validate header has at minimum trade_date — extra columns are OK.
  if (rows.length === 0 || !('trade_date' in rows[0])) {
    return NextResponse.json({ error: 'CSV must include a trade_date column' }, { status: 400 })
  }

  const supabase: AnyClient = await createClient()

  // Pre-fetch trading_days so we batch lookups.
  const { data: daysRaw } = await supabase
    .from('trading_days')
    .select('id, date') as { data: Array<{ id: string; date: string }> | null }
  const dayByDate = new Map<string, string>()
  for (const d of daysRaw ?? []) dayByDate.set(d.date, d.id)

  const results: PerRowResult[] = []
  let inserted = 0, updated = 0, skipped = 0, failed = 0

  const toNum = (v: string | undefined): number | null => {
    if (v == null) return null
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  for (const row of rows) {
    const date = row.trade_date?.trim() ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      results.push({ trade_date: date || '(blank)', status: 'failed', reason: 'invalid trade_date — must be YYYY-MM-DD' })
      failed++
      continue
    }

    try {
      // Ensure trading_day exists.
      let dayId = dayByDate.get(date)
      if (!dayId && !dryRun) {
        const { data: created, error: dayErr } = await supabase
          .from('trading_days')
          .insert({ date })
          .select('id')
          .single() as { data: { id: string } | null; error: { message: string } | null }
        if (dayErr || !created) {
          results.push({ trade_date: date, status: 'failed', reason: `trading_days insert: ${dayErr?.message ?? 'unknown'}` })
          failed++
          continue
        }
        dayId = created.id
        dayByDate.set(date, dayId)
      }
      if (dryRun && !dayId) dayId = '(would-create)'

      // Build payload from the row's numeric fields.
      const payload: Record<string, unknown> = { trading_day_id: dayId, symbol: 'NQ' }
      for (const f of FIELDS) payload[f] = toNum(row[f])

      // Check existing context row.
      const { data: existing } = !dryRun && dayId !== '(would-create)'
        ? await supabase
            .from('market_context')
            .select('id')
            .eq('trading_day_id', dayId)
            .maybeSingle() as { data: { id: string } | null }
        : { data: null }
      const hasContext = !!existing

      if (hasContext && !force && !dryRun) {
        results.push({ trade_date: date, status: 'skipped', reason: 'market_context already exists (pass force=true to overwrite)' })
        skipped++
        continue
      }

      if (dryRun) {
        results.push({ trade_date: date, status: hasContext ? 'updated' : 'inserted' })
        if (hasContext) updated++; else inserted++
        continue
      }

      if (hasContext) {
        const { error: upErr } = await supabase
          .from('market_context')
          .update(payload)
          .eq('trading_day_id', dayId)
        if (upErr) {
          results.push({ trade_date: date, status: 'failed', reason: `update: ${upErr.message}` })
          failed++; continue
        }
        results.push({ trade_date: date, status: 'updated' })
        updated++
      } else {
        const { error: insErr } = await supabase
          .from('market_context')
          .insert(payload)
        if (insErr) {
          results.push({ trade_date: date, status: 'failed', reason: `insert: ${insErr.message}` })
          failed++; continue
        }
        results.push({ trade_date: date, status: 'inserted' })
        inserted++
      }
    } catch (e) {
      results.push({ trade_date: date, status: 'failed', reason: e instanceof Error ? e.message : 'unknown error' })
      failed++
    }
  }

  return NextResponse.json({
    ok: true,
    totalRows: rows.length,
    inserted, updated, skipped, failed,
    results,
    dryRun,
  })
}
