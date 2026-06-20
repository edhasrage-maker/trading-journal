import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseSierraChartLog, mapRowToTrade } from '@/lib/sc-importer'
import { resilientUpsert, resilientBulkUpsert, resilientUpdate } from '@/lib/resilient-upsert'
import { perLegMaxDollars, type BarLike } from '@/lib/analytics'
import { computeStructure5mAlignment } from '@/lib/structure-5m'
import { isOutsideRth } from '@/lib/rth'
import { buildDayRegimeSeries, regimeAtEntry } from '@/lib/nq-front-month'
import type { TradingDay } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  const supabase: AnyClient = await createClient()
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const date = (formData.get('date') as string | null) ?? new Date().toISOString().slice(0, 10)

  if (!file) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  // 1. Archive raw upload to sc-logs bucket
  const archivePath = `${date}-${Date.now()}-${file.name}`
  const buffer = await file.arrayBuffer()
  const { error: uploadError } = await supabase.storage
    .from('sc-logs')
    .upload(archivePath, buffer, { contentType: file.type || 'text/plain', upsert: true })
  if (uploadError) {
    console.error('[import-sc-log] storage upload failed:', uploadError)
    return NextResponse.json(
      { error: `Failed to archive log: ${uploadError.message}` },
      { status: 500 },
    )
  }

  // 2. Parse
  const text = new TextDecoder().decode(buffer)
  const { rows, parseErrors, skippedFiltered } = parseSierraChartLog(text)

  const allDroppedColumns: Record<string, string[]> = {}

  // 3. Ensure trading_day exists (resilient — old columns only, should always work)
  const { data: day, error: dayError, droppedColumns: dayDropped } = await resilientUpsert<TradingDay>(
    supabase,
    'trading_days',
    { date, updated_at: new Date().toISOString() },
    { onConflict: 'date' },
  )
  if (dayDropped.length > 0) allDroppedColumns['trading_days (day upsert)'] = dayDropped
  if (dayError || !day) {
    console.error('[import-sc-log] trading_days upsert failed:', dayError)
    return NextResponse.json(
      { error: `Failed to upsert trading day: ${dayError?.message ?? 'unknown'}` },
      { status: 500 },
    )
  }

  // 4. Bulk upsert trades — resilient against missing exit_time/exit_price columns
  let inserted = 0
  let skippedDuplicates = 0
  if (rows.length > 0) {
    const payload = rows.map(r => mapRowToTrade(r, day.id))
    const { data: insertedRows, error: tradesError, droppedColumns: tradesDropped } =
      await resilientBulkUpsert<{ id: string }>(
        supabase,
        'trades',
        payload,
        // Update SC-owned fields on existing rows (so new columns backfill
        // on re-import and fill corrections take effect). Safe because the
        // payload from mapRowToTrade deliberately excludes user-owned fields
        // (tags, screenshot, plan levels), so DO UPDATE only touches the SC
        // columns and leaves manual edits intact.
        { onConflict: 'sierra_trade_id', ignoreDuplicates: false },
      )
    if (tradesDropped.length > 0) allDroppedColumns['trades'] = tradesDropped
    if (tradesError) {
      console.error('[import-sc-log] trades bulk upsert failed:', tradesError, 'droppedColumns:', allDroppedColumns)
      return NextResponse.json(
        { error: `Failed to insert trades: ${tradesError.message}`, droppedColumns: allDroppedColumns },
        { status: 500 },
      )
    }
    inserted = insertedRows?.length ?? 0
    skippedDuplicates = payload.length - inserted

    // 4b. Auto-populate per-trade derived fields from ohlcv_bars (which
    // BarWatcher refreshes every ~3 min, so today's bars exist by the time
    // SC log is uploaded). Fetches bars ONCE per traded symbol, then runs:
    //   - mfe_dollars_per_leg for multi-leg (scale-out) trades — scaling-
    //     aware MFE max-possible. Previously a manual backfill; runs now
    //     so dashboard / EOD capture % is correct immediately.
    //   - structure_5m_alignment for every trade — was the entry following
    //     or fading the 5m EMA-20 trend at entry minute.
    // Skips silently per-trade if bars are missing for that symbol; those
    // rows stay null and the UI shows the simple-formula fallback or "—".
    if (payload.length > 0) {
      const dayStart = `${date}T00:00:00Z`
      const dayEnd = `${date}T23:59:59Z`
      const symbols = Array.from(new Set(payload.map(r => r.symbol).filter((s): s is string => !!s)))
      const barsBySymbol = new Map<string, BarLike[]>()
      for (const symbol of symbols) {
        const { data: barRows } = await supabase
          .from('ohlcv_bars')
          .select('ts, high, low, close')
          .eq('symbol', symbol)
          .gte('ts', dayStart)
          .lte('ts', dayEnd)
          .order('ts', { ascending: true })
        if (barRows && barRows.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          barsBySymbol.set(symbol, (barRows as any[]).map(b => ({
            ts: b.ts, high: Number(b.high), low: Number(b.low), close: Number(b.close),
          })))
        }
      }

      // Per-leg MFE for scale-out trades.
      const multiLegRows = payload.filter(r => Array.isArray(r.exits_json) && r.exits_json.length > 1 && !!r.symbol)
      let mfeComputed = 0
      let mfeBarsGap = 0
      for (const r of multiLegRows) {
        const bars = barsBySymbol.get(r.symbol!)
        if (!bars || bars.length === 0) { mfeBarsGap++; continue }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value = perLegMaxDollars(r as any, bars)
        if (value == null) { mfeBarsGap++; continue }
        const rounded = Math.round(value * 100) / 100
        await supabase.from('trades')
          .update({ mfe_dollars_per_leg: rounded })
          .eq('sierra_trade_id', r.sierra_trade_id)
        mfeComputed++
      }
      if (mfeComputed > 0 || mfeBarsGap > 0) {
        console.log(`[import-sc-log] mfe_dollars_per_leg: computed=${mfeComputed}, bars-gap=${mfeBarsGap}, single-leg-skipped=${payload.length - multiLegRows.length}`)
      }

      // 5m structure alignment for every trade (long, short, single- or
      // multi-leg). Needs the day's 1m bars before entry to seed the EMA.
      let structComputed = 0
      let structNoData = 0
      const counts: Record<string, number> = { following: 0, fading: 0, neutral: 0 }
      for (const r of payload) {
        if (!r.symbol || !r.entry_time || !r.direction) { structNoData++; continue }
        const bars = barsBySymbol.get(r.symbol)
        if (!bars || bars.length === 0) { structNoData++; continue }
        const alignment = computeStructure5mAlignment(
          { entry_time: r.entry_time, direction: r.direction },
          bars,
        )
        if (alignment == null) { structNoData++; continue }
        await supabase.from('trades')
          .update({ structure_5m_alignment: alignment })
          .eq('sierra_trade_id', r.sierra_trade_id)
        structComputed++
        counts[alignment]++
      }
      if (structComputed > 0 || structNoData > 0) {
        console.log(`[import-sc-log] structure_5m_alignment: computed=${structComputed}, no-data=${structNoData}, following=${counts.following}, fading=${counts.fading}, neutral=${counts.neutral}`)
      }

      // 4c. Auto-tag GBX (Globex / overnight). Any trade entered outside RTH
      // (06:30–13:00 PT) gets a per-trade day_type='GBX' (session attribute;
      // never clobbers an existing day_type). A PURE-GBX day (every trade that
      // day was outside RTH) also gets a day-level GBX chip; that chip is
      // dropped again if a later import turns the day mixed. Re-reads the whole
      // day's trades so pre-existing rows are covered and pure/mixed is exact.
      {
        const { data: dayTrades } = await supabase
          .from('trades').select('id, entry_time, tags_json').eq('trading_day_id', day.id)
        const all = (dayTrades ?? []) as { id: string; entry_time: string | null; tags_json: Record<string, unknown> | null }[]
        let gbxTagged = 0, outCount = 0
        for (const t of all) {
          if (!t.entry_time || !isOutsideRth(t.entry_time)) continue
          outCount++
          const tj = (t.tags_json && typeof t.tags_json === 'object') ? t.tags_json : {}
          if (tj.day_type) continue  // respect an existing day_type (incl already-GBX)
          await supabase.from('trades').update({ tags_json: { ...tj, day_type: 'GBX' } }).eq('id', t.id)
          gbxTagged++
        }
        // Day-level chip: keep GBX in day_types iff the day is pure-GBX.
        const pureGbx = all.length > 0 && outCount === all.length
        const { data: td } = await supabase.from('trading_days').select('day_type, day_types').eq('id', day.id).single()
        const cur: string[] = Array.isArray(td?.day_types) ? td.day_types : []
        const hasGbx = cur.includes('GBX')
        if (pureGbx && !hasGbx) {
          const upd: { day_types: string[]; day_type?: string } = { day_types: [...cur, 'GBX'] }
          if (!td?.day_type && cur.length === 0) upd.day_type = 'GBX'
          await supabase.from('trading_days').update(upd).eq('id', day.id)
        } else if (!pureGbx && hasGbx) {
          const next = cur.filter(x => x !== 'GBX')
          const upd: { day_types: string[]; day_type?: string | null } = { day_types: next }
          if (td?.day_type === 'GBX') upd.day_type = next[0] ?? null
          await supabase.from('trading_days').update(upd).eq('id', day.id)
        }
        if (gbxTagged > 0 || pureGbx) {
          console.log(`[import-sc-log] GBX: tagged ${gbxTagged} out-of-RTH trade(s); pureGbxDay=${pureGbx}`)
        }
      }

      // 4d. Pivot market-structure regime (structure_5m_regime). Build ONE 5m
      // series for the day's front-month contract, then tag each trade. Best-
      // effort and wrapped — a missing/slow .scid never breaks the import; the
      // backfill (scripts/backfill-structure-regime.ts) is authoritative.
      try {
        const dataDir = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'
        const series = buildDayRegimeSeries(dataDir, date)
        if (series) {
          const { data: regimeTrades } = await supabase
            .from('trades').select('id, entry_time, structure_5m_regime').eq('trading_day_id', day.id)
          let regimeTagged = 0
          for (const t of (regimeTrades ?? []) as { id: string; entry_time: string | null; structure_5m_regime: string | null }[]) {
            if (!t.entry_time) continue
            const regime = regimeAtEntry(series, Date.parse(t.entry_time))
            if (regime && t.structure_5m_regime !== regime) {
              await supabase.from('trades').update({ structure_5m_regime: regime }).eq('id', t.id)
              regimeTagged++
            }
          }
          if (regimeTagged > 0) console.log(`[import-sc-log] structure_5m_regime: tagged ${regimeTagged}`)
        }
      } catch (e) {
        console.warn('[import-sc-log] regime tagging skipped:', e instanceof Error ? e.message : 'unknown')
      }
    }
  }

  // 5. Mark import on day — resilient against missing last_sc_import_* columns
  const { droppedColumns: markDropped } = await resilientUpdate<TradingDay>(
    supabase,
    'trading_days',
    {
      last_sc_import_at: new Date().toISOString(),
      last_sc_import_filename: file.name,
    },
    'id',
    day.id,
  )
  if (markDropped.length > 0) allDroppedColumns['trading_days (mark import)'] = markDropped

  return NextResponse.json({
    inserted,
    skippedDuplicates,
    skippedFiltered,
    parseErrors,
    archivedAs: archivePath,
    droppedColumns: Object.keys(allDroppedColumns).length > 0 ? allDroppedColumns : undefined,
  })
}
