import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseTradeCsv } from '@/lib/csv-trade-import'
import { parseSierraChartLog } from '@/lib/sc-importer'
import { isNinjaTraderGrid, parseNinjaTraderGrid } from '@/lib/ninjatrader-import'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { liveAtr, postExitExtension } from '@/lib/atr'
import { clientError } from '@/lib/api-error'

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

/** Page the shared ohlcv_bars for [startIso, endIso] (past the 1000-row cap). */
async function fetchBars(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, symbol: string, startIso: string, endIso: string,
): Promise<Array<{ ts: string; high: number; low: number; close: number }>> {
  const PAGE = 1000
  const out: Array<{ ts: string; high: number; low: number; close: number }> = []
  let from = 0
  for (let page = 0; page < 40; page++) {
    const { data, error } = await db
      .from('ohlcv_bars')
      .select('ts, high, low, close')
      .eq('symbol', symbol)
      .gte('ts', startIso)
      .lte('ts', endIso)
      .order('ts', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) break
    const rows = (data ?? []) as Array<{ ts: string; high: number; low: number; close: number }>
    out.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

/**
 * Apply the user's per-side commission to GROSS-P&L imports (Sierra Chart).
 * Round-turn cost per trade = rate × contracts × 2 (entry + exit). No-op when
 * the setting is 0 or the column hasn't been migrated. Sources that already
 * carry commission (NinjaTrader, Tradezella) never call this.
 */
async function applyGrossCommissions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, pending: PendingTrade[], warnings: string[],
): Promise<void> {
  const { data, error } = await db
    .from('trader_profile')
    .select('commission_per_side')
    .eq('id', 'default')
    .maybeSingle()
  if (error) return // column/table not migrated → skip silently
  const rate = Number(data?.commission_per_side ?? 0)
  if (!(rate > 0)) return

  let n = 0
  for (const p of pending) {
    const q = Number(p.row.quantity)
    if (p.row.pnl == null || !Number.isFinite(q) || q <= 0) continue
    p.row.pnl = Math.round((p.row.pnl - rate * q * 2) * 100) / 100
    n++
  }
  if (n > 0) warnings.push(`Applied $${rate.toFixed(2)}/side commission (round-turn) to ${n} trade(s).`)
}

/**
 * Fill the derived market-data fields the local `.scid` pipeline normally
 * provides but cloud imports lack, from the central bar feed:
 *   - high/low-during-position (MFE/MAE source) — clipped from bars over the hold
 *   - entry_atr_1m (1-min Wilder ATR-10 at entry) — powers the ×ATR MFE/MAE unit
 *   - post_exit_favorable/against_pts (30-min continuation after exit)
 * The bars — not the trade log — are the source of truth. Runs once per symbol
 * root over the union window (extended back 60m so ATR-10 can seed, and forward
 * 30m so post-exit has its window). Best-effort: trades outside the bar coverage
 * keep their nulls.
 */
async function backfillExcursionsFromBars(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, pending: PendingTrade[], warnings: string[],
): Promise<void> {
  const bySymbol = new Map<string, number[]>()
  for (let i = 0; i < pending.length; i++) {
    const r = pending[i].row
    const needsExcursion = r.high_during_position == null || r.low_during_position == null
    const needsAtr = r.entry_atr_1m == null
    const needsPostExit = r.post_exit_favorable_pts == null
    if (!needsExcursion && !needsAtr && !needsPostExit) continue
    if (!r.entry_time || !r.symbol) continue // ATR needs entry; excursion/post-exit also need exit (checked below)
    const root = chartSeriesRoot(String(r.symbol))
    if (!bySymbol.has(root)) bySymbol.set(root, [])
    bySymbol.get(root)!.push(i)
  }

  let filled = 0, atrFilled = 0, peFilled = 0
  for (const [root, idxs] of bySymbol) {
    let min = Infinity, max = -Infinity
    for (const i of idxs) {
      const r = pending[i].row
      const s = Date.parse(r.entry_time)
      min = Math.min(min, s)
      max = Math.max(max, r.exit_time ? Date.parse(r.exit_time) : s)
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue
    // Extend the window 60 min before the earliest entry so ATR-10 has enough
    // preceding 1-min bars to seed (Wilder needs period+1 bars strictly before
    // entry), and 30 min past the latest exit so post-exit has its full window.
    const bars = await fetchBars(db, root, new Date(min - 60 * 60_000).toISOString(), new Date(max + 30 * 60_000).toISOString())
    if (bars.length === 0) continue
    const parsed = bars.map(b => ({ t: Date.parse(b.ts), high: b.high, low: b.low }))
    for (const i of idxs) {
      const r = pending[i].row
      const s = Date.parse(r.entry_time)
      // high/low excursion over the hold (needs an exit).
      if ((r.high_during_position == null || r.low_during_position == null) && r.exit_time) {
        const e = Date.parse(r.exit_time)
        let hi = -Infinity, lo = Infinity
        for (const b of parsed) {
          // Include the entry minute's bar (bar ts is the minute open, so allow 60s slack).
          if (b.t >= s - 60_000 && b.t <= e) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low }
        }
        if (hi > -Infinity && lo < Infinity) {
          r.high_during_position = Math.round(hi * 100) / 100
          r.low_during_position = Math.round(lo * 100) / 100
          filled++
        }
      }
      // Entry ATR-10 (1-min Wilder) snapshot at entry — bars strictly before entry.
      if (r.entry_atr_1m == null) {
        const atr = liveAtr(bars, new Date(s), 10)
        if (atr != null) { r.entry_atr_1m = Math.round(atr * 100) / 100; atrFilled++ }
      }
      // Post-exit continuation over the 30 min after exit (same source as the
      // local Sierra import + backfill-post-exit script). Needs exit data.
      if (r.post_exit_favorable_pts == null && r.exit_time && r.exit_price != null && r.direction) {
        const pe = postExitExtension(bars, { direction: r.direction, exit_price: r.exit_price, exit_time: r.exit_time }, 30)
        if (pe) {
          r.post_exit_favorable_pts = Math.round(pe.continued_favorable_pts * 100) / 100
          r.post_exit_against_pts = Math.round(pe.continued_against_pts * 100) / 100
          peFilled++
        }
      }
    }
  }
  if (filled > 0) warnings.push(`Filled MFE/MAE for ${filled} trade(s) from market data.`)
  if (atrFilled > 0) warnings.push(`Filled entry ATR for ${atrFilled} trade(s) from market data.`)
  if (peFilled > 0) warnings.push(`Filled post-exit continuation for ${peFilled} trade(s) from market data.`)
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
  // The browser's IANA timezone, sent by the client. Sierra logs store naive
  // local times with no zone, so we read them in the uploader's timezone rather
  // than the (UTC) server's — otherwise every fill displays hours off.
  let clientTz: string | undefined
  const ctype = req.headers.get('content-type') || ''
  try {
    if (ctype.includes('multipart/form-data')) {
      const form = await req.formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 })
      }
      csvText = await (file as File).text()
      const tzv = form.get('tz')
      if (typeof tzv === 'string' && tzv) clientTz = tzv
    } else {
      const body = await req.json().catch(() => ({}))
      csvText = body.csv ?? ''
      if (typeof body.tz === 'string' && body.tz) clientTz = body.tz
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
  // True when the source exports GROSS P&L (no commission of its own) → apply
  // the user's per-side commission setting. Sierra logs are gross; NinjaTrader
  // (per-fill commission) and Tradezella (Net P&L) already include costs.
  let grossSource = false

  if (isSierraLog(csvText)) {
    grossSource = true // Sierra exports gross P&L → apply commission setting
    const { rows, parseErrors, skippedFiltered } = parseSierraChartLog(csvText, clientTz)
    skipped = skippedFiltered
    total = rows.length + skippedFiltered
    // Surface the first few parse errors (invalid rows) but don't flood the UI.
    for (const e of parseErrors.slice(0, 5)) warnings.push(e)
    if (skippedFiltered > 0) {
      warnings.push(`${skippedFiltered} fill(s) from sim/None accounts were skipped (live accounts only).`)
    }
    // Sierra logs carry no timezone marker. With the browser tz we read them in
    // the uploader's zone (correct); only warn when that wasn't available.
    if (!clientTz) {
      warnings.push('Your timezone wasn\'t detected, so Sierra times were read as server time and may display shifted. P&L, MFE/MAE, and pairing are unaffected.')
    }
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
  } else if (isNinjaTraderGrid(csvText)) {
    // NinjaTrader executions grid: fill-level, reconstructed into round-trip
    // trades. Same ParsedSCRow shape as the Sierra path, so map identically.
    const { rows, parseErrors } = parseNinjaTraderGrid(csvText, clientTz)
    total = rows.length
    for (const e of parseErrors.slice(0, 5)) warnings.push(e)
    if (!clientTz) {
      warnings.push('Your timezone wasn\'t detected, so NinjaTrader times were read as server time and may display shifted.')
    }
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

  // Backfill MFE/MAE from the central bar feed for trades whose source carried
  // no excursion data (NinjaTrader, generic CSV). Non-fatal — import proceeds
  // even if bars are unavailable for the window.
  try {
    await backfillExcursionsFromBars(db, pending, warnings)
  } catch {
    warnings.push('Could not backfill MFE/MAE from market data (import still completed).')
  }

  // Apply the user's commission setting to gross-P&L sources (Sierra Chart).
  if (grossSource) {
    try {
      await applyGrossCommissions(db, pending, warnings)
    } catch { /* non-fatal: keep gross P&L */ }
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
        { error: clientError(`Failed to create trading day ${date}: ${error?.message ?? 'unknown error'}`, `Could not create the trading day for ${date}. Please try again.`) },
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
    // Conflict key differs per DB: the personal (single-user) DB has a UNIQUE on
    // sierra_trade_id alone; the public multi-tenant DB recomposes it to
    // (user_id, sierra_trade_id). Pick the one that matches the active mode.
    .upsert(rows, {
      onConflict: LOCAL_FEATURES_ENABLED ? 'sierra_trade_id' : 'user_id,sierra_trade_id',
      ignoreDuplicates: true,
    })
    .select('id')
  if (insErr) {
    return NextResponse.json(
      { error: clientError(`Insert failed: ${insErr.message}`, 'Could not import your trades. Please try again.'), total, skipped, warnings },
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
