import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { parseSierraChartLog, mapRowToTrade } from '@/lib/sc-importer'
import { resilientUpsert, resilientBulkUpsert, resilientUpdate } from '@/lib/resilient-upsert'
import { perLegMaxDollars, type BarLike } from '@/lib/analytics'
import { computeStructure5mAlignment } from '@/lib/structure-5m'
import { isOutsideRth } from '@/lib/rth'
import { sessionUtcWindow, todayPT } from '@/lib/pt-time'
import { buildDayRegimeSeries, buildRegimeSeriesFrom1mBars, regimeAtEntry, buildDayEntryMetrics, atrAtEntry, rvolAtEntry } from '@/lib/nq-front-month'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import type { TradingDay } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export async function POST(req: Request) {
  if (!LOCAL_FEATURES_ENABLED) {
    return NextResponse.json(
      { error: 'This feature runs only in the local desktop build (it reads Sierra Chart / OBS files on your machine).', local_only: true },
      { status: 503 },
    )
  }
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

  // 3. Group the parsed rows by THEIR OWN PT session date, then ensure a
  //    trading_day per date.
  //
  //    This used to pin every parsed row to the single `date` from the import
  //    form. A Sierra log that spans more than one session therefore collapsed
  //    into one day, and the whole 4b–4e pipeline below ran once against that
  //    one date — so bars, GBX purity, the regime series and the entry metrics
  //    were all computed for the wrong session for every row that didn't belong
  //    to it.
  //
  //    That is not hypothetical: by 2026-07-27 it had put 1,173 of 5,754 native
  //    trades (20%) under the wrong day across 37 days, including one blob of
  //    430 rows spanning 57 dates. It silently invalidated a whole study before
  //    anyone noticed. See docs/findings-expanded-ib-day.md and
  //    scripts/repair-misdated-trades.ts (which cleans up history; this is the
  //    fix that stops it recurring).
  //
  //    A trading day here is the PT CALENDAR day — `sessionUtcWindow` anchors
  //    00:00:00–23:59:59 PT — so a row's correct parent is the PT date of its
  //    entry. `todayPT` is DST-exact. Rows with no parseable entry time fall
  //    back to the form date, which is the best guess available and matches the
  //    old behaviour for that (rare) case.
  const rowsByDate = new Map<string, typeof rows>()
  for (const r of rows) {
    const d = r.entry_time_iso ? todayPT(new Date(r.entry_time_iso)) : date
    const arr = rowsByDate.get(d)
    if (arr) arr.push(r)
    else rowsByDate.set(d, [r])
  }
  // With no rows at all, still touch the form date so an empty import behaves
  // exactly as it did before (day row created, import stamped).
  const dates = rowsByDate.size > 0 ? [...rowsByDate.keys()].sort() : [date]

  const dayByDate = new Map<string, TradingDay>()
  for (const d of dates) {
    const { data: dayRow, error: dayError, droppedColumns: dayDropped } = await resilientUpsert<TradingDay>(
      supabase,
      'trading_days',
      { date: d, updated_at: new Date().toISOString() },
      { onConflict: 'date' },
    )
    if (dayDropped.length > 0) allDroppedColumns['trading_days (day upsert)'] = dayDropped
    if (dayError || !dayRow) {
      console.error('[import-sc-log] trading_days upsert failed for', d, dayError)
      return NextResponse.json(
        { error: `Failed to upsert trading day ${d}: ${dayError?.message ?? 'unknown'}` },
        { status: 500 },
      )
    }
    dayByDate.set(d, dayRow)
  }
  if (dates.length > 1) {
    console.log(`[import-sc-log] log spans ${dates.length} sessions (${dates[0]} → ${dates[dates.length - 1]}); importing each to its own trading_day`)
  }

  // 4. Bulk upsert trades — resilient against missing exit_time/exit_price
  //    columns — then run the per-day derived pipeline (4b–4e) ONCE PER DATE.
  //    Every step below is keyed to a single session (that day's bars, that
  //    day's GBX purity, that day's regime series, that day's entry metrics),
  //    so it has to run inside this loop, not once for the whole file.
  let inserted = 0
  let skippedDuplicates = 0
  const perDate: { date: string; trades: number; inserted: number }[] = []
  for (const d of dates) {
    const dayRows = rowsByDate.get(d) ?? []
    if (dayRows.length === 0) continue
    const day = dayByDate.get(d)!
    const payload = dayRows.map(r => mapRowToTrade(r, day.id))
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
    const dayInserted = insertedRows?.length ?? 0
    inserted += dayInserted
    skippedDuplicates += payload.length - dayInserted
    perDate.push({ date: d, trades: payload.length, inserted: dayInserted })

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
      // PT-session bounds (not raw UTC day) so post-RTH / overnight (GBX)
      // trades — which land in the early hours of the next UTC day — get bars
      // for per-leg MFE instead of falling back to the no-bars estimate.
      const { start: dayStart, end: dayEnd } = sessionUtcWindow(d)
      const symbols = Array.from(new Set(payload.map(r => r.symbol).filter((s): s is string => !!s)))
      const barsBySymbol = new Map<string, BarLike[]>()
      for (const symbol of symbols) {
        // The shared cloud feed stores continuous bars under the bare mini
        // root (NQ/ES), not the dated contract on the trade (MNQU6.CME) — the
        // same resolution /api/bars and atr.ts apply. Try the exact symbol
        // first (local imports of dated series), then fall back to the root;
        // without the fallback every prod import computed alignment/MFE
        // against zero bars.
        const candidates = [symbol, chartSeriesRoot(symbol)].filter((s, i, a) => a.indexOf(s) === i)
        for (const barSymbol of candidates) {
          const { data: barRows } = await supabase
            .from('ohlcv_bars')
            .select('ts, high, low, close')
            .eq('symbol', barSymbol)
            .gte('ts', dayStart)
            .lte('ts', dayEnd)
            .order('ts', { ascending: true })
          if (barRows && barRows.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            barsBySymbol.set(symbol, (barRows as any[]).map(b => ({
              ts: b.ts, high: Number(b.high), low: Number(b.low), close: Number(b.close),
            })))
            break
          }
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
        let series = buildDayRegimeSeries(dataDir, d)
        let regimeSource = 'scid'
        if (!series) {
          // No readable .scid (deployed build, or the machine without Sierra
          // data): rebuild the series from the shared ohlcv_bars feed. The
          // regime study runs on NQ regardless of the instrument traded.
          // 7 calendar days ≈ 5 sessions of warmup for the K=4 zig-zag.
          regimeSource = 'ohlcv_bars'
          const warmStart = new Date(Date.parse(d + 'T00:00:00Z') - 7 * 86400000).toISOString()
          const seriesEnd = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString()
          const rows: Array<{ ts: string; close: number }> = []
          const PAGE = 1000
          for (let p = 0; ; p++) {
            const { data: page } = await supabase
              .from('ohlcv_bars')
              .select('ts, close')
              .eq('symbol', 'NQ')
              .gte('ts', warmStart)
              .lt('ts', seriesEnd)
              .order('ts', { ascending: true })
              .range(p * PAGE, p * PAGE + PAGE - 1)
            if (!page || page.length === 0) break
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rows.push(...(page as any[]).map(b => ({ ts: b.ts as string, close: Number(b.close) })))
            if (page.length < PAGE) break
          }
          series = buildRegimeSeriesFrom1mBars(rows)
        }
        if (!series) {
          console.warn(`[import-sc-log] structure_5m_regime: no series for ${d} (no .scid and no cloud NQ bars)`)
        } else {
          const { data: regimeTrades } = await supabase
            .from('trades').select('id, entry_time, structure_5m_regime').eq('trading_day_id', day.id)
          let regimeTagged = 0, regimeNull = 0, regimeErrors = 0
          for (const t of (regimeTrades ?? []) as { id: string; entry_time: string | null; structure_5m_regime: string | null }[]) {
            if (!t.entry_time) continue
            const regime = regimeAtEntry(series, Date.parse(t.entry_time))
            if (!regime) { regimeNull++; continue }
            if (t.structure_5m_regime !== regime) {
              const { error: regErr } = await supabase.from('trades').update({ structure_5m_regime: regime }).eq('id', t.id)
              if (regErr) { regimeErrors++; console.warn(`[import-sc-log] regime update failed for ${t.id}: ${regErr.message}`) }
              else regimeTagged++
            }
          }
          console.log(`[import-sc-log] structure_5m_regime (${regimeSource}): tagged=${regimeTagged}, no-regime=${regimeNull}, errors=${regimeErrors}`)
        }
      } catch (e) {
        console.warn('[import-sc-log] regime tagging skipped:', e instanceof Error ? e.message : 'unknown')
      }

      // 4e. Live entry metrics — entry_atr_1m (live ATR-10) and entry_rvol
      // (cumulative RTH volume vs prior-10-day mean), from ONE front-month 1m
      // read. So the dashboard ×ATR shows a live value (no "prep" fallback) and
      // the analytics RVOL buckets populate — without re-running the backfill.
      // Best-effort; fills nulls only (a prior backfill value stays in place).
      try {
        const dataDir = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'
        const em = buildDayEntryMetrics(dataDir, d)
        if (em) {
          const { data: emTrades } = await supabase
            .from('trades').select('id, entry_time, entry_atr_1m, entry_rvol').eq('trading_day_id', day.id)
          let atrTagged = 0, rvolTagged = 0
          for (const t of (emTrades ?? []) as { id: string; entry_time: string | null; entry_atr_1m: number | null; entry_rvol: number | null }[]) {
            if (!t.entry_time) continue
            const ms = Date.parse(t.entry_time)
            const upd: { entry_atr_1m?: number; entry_rvol?: number } = {}
            if (t.entry_atr_1m == null) { const a = atrAtEntry(em, ms); if (a != null) upd.entry_atr_1m = Math.round(a * 100) / 100 }
            if (t.entry_rvol == null) { const r = rvolAtEntry(em, ms); if (r != null) upd.entry_rvol = Math.round(r * 100) / 100 }
            if (Object.keys(upd).length) {
              await supabase.from('trades').update(upd).eq('id', t.id)
              if (upd.entry_atr_1m != null) atrTagged++
              if (upd.entry_rvol != null) rvolTagged++
            }
          }
          if (atrTagged > 0 || rvolTagged > 0) console.log(`[import-sc-log] entry metrics: atr=${atrTagged} rvol=${rvolTagged}`)
        }
      } catch (e) {
        console.warn('[import-sc-log] entry metrics skipped:', e instanceof Error ? e.message : 'unknown')
      }
    }
  }

  // 5. Mark the import on EVERY day this log touched — resilient against
  //    missing last_sc_import_* columns. Marking only the form's date would
  //    leave the other sessions looking as though they'd never been imported.
  const importedAt = new Date().toISOString()
  for (const d of dates) {
    const dayRow = dayByDate.get(d)
    if (!dayRow) continue
    const { droppedColumns: markDropped } = await resilientUpdate<TradingDay>(
      supabase,
      'trading_days',
      { last_sc_import_at: importedAt, last_sc_import_filename: file.name },
      'id',
      dayRow.id,
    )
    if (markDropped.length > 0) allDroppedColumns['trading_days (mark import)'] = markDropped
  }

  return NextResponse.json({
    inserted,
    skippedDuplicates,
    skippedFiltered,
    parseErrors,
    archivedAs: archivePath,
    // Per-session breakdown. Always present, so a log that quietly spanned more
    // than the day the trader selected SAYS SO in the import result instead of
    // looking like one big session — the failure mode that went unnoticed for
    // 37 days' worth of trades.
    dates: perDate,
    spannedSessions: perDate.length,
    droppedColumns: Object.keys(allDroppedColumns).length > 0 ? allDroppedColumns : undefined,
  })
}
