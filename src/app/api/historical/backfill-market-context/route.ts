import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { readScidBars } from '@/lib/scid-reader'
import { computeMarketContext } from '@/lib/compute-market-context'
import { existsSync } from 'fs'
import { join, basename } from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const SIERRA_DATA_DIR = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'

interface TradeDateRow { trade_date: string | null }
interface DayRow { id: string; date: string }
interface ContextRow { id: string; trading_day_id: string }

interface PerDateResult {
  date: string
  status: 'inserted' | 'updated' | 'skipped' | 'failed'
  reason?: string
  metrics?: {
    rvol: number | null
    adr: number | null
    ib_size: number | null
    ib_vs_10d_avg: number | null
    atr_1m: number | null
  }
}

/**
 * POST /api/historical/backfill-market-context
 *
 * Body: {
 *   scidFile: "NQM6.CME.scid",      // filename in SIERRA_DATA_DIR
 *   priceDivisor?: number,           // default 100 (NQ/MNQ convention)
 *   lookbackDays?: number,           // default 10
 *   dryRun?: boolean,                // compute + report, don't write
 *   force?: boolean,                 // overwrite existing market_context rows
 * }
 *
 * For every unique trade_date in historical_trades whose date falls within the
 * SCID's data window: compute the five market_context metrics (rvol, adr,
 * ib_size, ib_vs_10d_avg, atr_1m) from the SCID's 1-minute bars and upsert
 * into market_context (creating a trading_days row first if one doesn't
 * already exist for that date).
 *
 * Idempotent — by default skips dates that already have a market_context row.
 * Use force=true to overwrite. Re-run with different SCID files for different
 * contract periods (e.g. NQM5 for Jun 2025, NQU5 for Jul-Sep 2025, etc.).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const scidFile: string | undefined = body?.scidFile
  const priceDivisor = Number(body?.priceDivisor ?? 100) || 100
  const lookbackDays = Number(body?.lookbackDays ?? 10) || 10
  const dryRun: boolean = body?.dryRun === true
  const force: boolean = body?.force === true

  if (!scidFile) return NextResponse.json({ error: 'scidFile required' }, { status: 400 })

  // Path-traversal guard — only allow a bare filename in the SC data dir.
  const safeName = basename(scidFile)
  if (safeName !== scidFile || !safeName.toLowerCase().endsWith('.scid')) {
    return NextResponse.json({ error: 'invalid scidFile name' }, { status: 400 })
  }
  const fullPath = join(SIERRA_DATA_DIR, safeName)
  if (!existsSync(fullPath)) {
    return NextResponse.json({ error: `SCID file not found: ${fullPath}` }, { status: 404 })
  }

  const supabase: AnyClient = await createClient()

  // 1. Get every distinct trade_date in historical_trades.
  const PAGE = 1000
  const allDates = new Set<string>()
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('historical_trades')
      .select('trade_date')
      .order('id')
      .range(p * PAGE, p * PAGE + PAGE - 1) as { data: TradeDateRow[] | null; error: { message: string } | null }
    if (error) return NextResponse.json({ error: `historical_trades read failed: ${error.message}` }, { status: 500 })
    const rows = data ?? []
    for (const r of rows) {
      if (r.trade_date) allDates.add(r.trade_date.slice(0, 10))
    }
    if (rows.length < PAGE) break
  }
  if (allDates.size === 0) {
    return NextResponse.json({ ok: true, processed: 0, results: [], note: 'No historical trades found' })
  }

  // 2. Read the SCID file once over a generous window — full historical range
  //    + extra lookback at the start so the earliest target date has averages.
  const sortedDates = [...allDates].sort()
  const firstDate = sortedDates[0]
  const lastDate = sortedDates[sortedDates.length - 1]
  // Calendar-day pad on the start: lookbackDays trading days ≈ 1.5x calendar.
  const startMs = Date.parse(`${firstDate}T00:00:00Z`) - Math.ceil(lookbackDays * 1.5) * 86_400_000
  const endMs = Date.parse(`${lastDate}T00:00:00Z`) + 2 * 86_400_000
  let scidBars
  try {
    scidBars = readScidBars(fullPath, startMs, endMs, { priceDivisor }).bars
  } catch (e) {
    return NextResponse.json({
      error: `SCID read failed: ${e instanceof Error ? e.message : 'unknown'}`,
    }, { status: 500 })
  }
  if (scidBars.length === 0) {
    return NextResponse.json({
      ok: true, processed: 0, results: [],
      note: `SCID file ${safeName} has no bars in the historical_trades date range (${firstDate} → ${lastDate}).`,
    })
  }
  // SCID data window — only process dates that fall inside it.
  const scidStartIso = scidBars[0].ts
  const scidEndIso = scidBars[scidBars.length - 1].ts
  const scidStartDate = scidStartIso.slice(0, 10)
  const scidEndDate = scidEndIso.slice(0, 10)

  // 3. Pull existing trading_days + market_context once.
  const { data: daysData } = await supabase
    .from('trading_days')
    .select('id, date') as { data: DayRow[] | null }
  const dayByDate = new Map<string, string>()
  for (const d of daysData ?? []) dayByDate.set(d.date, d.id)

  const dayIds = (daysData ?? []).map(d => d.id)
  const existingContextDayIds = new Set<string>()
  if (dayIds.length > 0) {
    // Page through context rows for completeness even though usually <1000.
    for (let p = 0; p < 50; p++) {
      const { data } = await supabase
        .from('market_context')
        .select('id, trading_day_id')
        .in('trading_day_id', dayIds)
        .order('id')
        .range(p * PAGE, p * PAGE + PAGE - 1) as { data: ContextRow[] | null }
      const rows = data ?? []
      for (const r of rows) existingContextDayIds.add(r.trading_day_id)
      if (rows.length < PAGE) break
    }
  }

  // 4. Iterate dates that fall inside the SCID window.
  const datesToProcess = sortedDates.filter(d => d >= scidStartDate && d <= scidEndDate)
  const results: PerDateResult[] = []
  let inserted = 0, updated = 0, skipped = 0, failed = 0

  for (const date of datesToProcess) {
    try {
      const existingDayId = dayByDate.get(date)
      const hasContext = existingDayId ? existingContextDayIds.has(existingDayId) : false
      if (hasContext && !force) {
        results.push({ date, status: 'skipped', reason: 'market_context already exists (pass force=true to overwrite)' })
        skipped++
        continue
      }

      const metrics = computeMarketContext(scidBars, date, { lookbackDays })
      // If literally every metric is null, the SCID had no data for this date.
      const anyValue = metrics.rvol != null || metrics.adr != null || metrics.ib_size != null
        || metrics.ib_vs_10d_avg != null || metrics.atr_1m != null
      if (!anyValue) {
        results.push({ date, status: 'failed', reason: 'no bars on this date in the selected SCID' })
        failed++
        continue
      }

      if (dryRun) {
        results.push({ date, status: hasContext ? 'updated' : 'inserted', metrics })
        if (hasContext) updated++; else inserted++
        continue
      }

      // Ensure a trading_day exists.
      let dayId = existingDayId
      if (!dayId) {
        const { data: created, error: dayErr } = await supabase
          .from('trading_days')
          .insert({ date })
          .select('id')
          .single() as { data: { id: string } | null; error: { message: string } | null }
        if (dayErr || !created) {
          results.push({ date, status: 'failed', reason: `trading_days insert: ${dayErr?.message ?? 'unknown'}` })
          failed++
          continue
        }
        dayId = created.id
        dayByDate.set(date, dayId)
      }

      // Upsert market_context — UPDATE existing row, otherwise INSERT.
      const payload = {
        trading_day_id: dayId,
        symbol: 'NQ',
        rvol: metrics.rvol,
        adr: metrics.adr,
        ib_size: metrics.ib_size,
        ib_vs_10d_avg: metrics.ib_vs_10d_avg,
        atr_1m: metrics.atr_1m,
      }
      if (hasContext) {
        const { error: upErr } = await supabase
          .from('market_context')
          .update(payload)
          .eq('trading_day_id', dayId)
        if (upErr) {
          results.push({ date, status: 'failed', reason: `market_context update: ${upErr.message}` })
          failed++; continue
        }
        results.push({ date, status: 'updated', metrics })
        updated++
      } else {
        const { error: insErr } = await supabase
          .from('market_context')
          .insert(payload)
        if (insErr) {
          results.push({ date, status: 'failed', reason: `market_context insert: ${insErr.message}` })
          failed++; continue
        }
        existingContextDayIds.add(dayId)
        results.push({ date, status: 'inserted', metrics })
        inserted++
      }
    } catch (e) {
      results.push({ date, status: 'failed', reason: e instanceof Error ? e.message : 'unknown error' })
      failed++
    }
  }

  return NextResponse.json({
    ok: true,
    scidFile: safeName,
    scidWindow: { start: scidStartDate, end: scidEndDate },
    totalHistoricalDates: allDates.size,
    inRange: datesToProcess.length,
    outOfRange: allDates.size - datesToProcess.length,
    processed: results.length,
    inserted, updated, skipped, failed,
    results,
    dryRun,
  })
}
