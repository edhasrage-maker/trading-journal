import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  deriveMetrics, computeThresholds, buildLookupRows,
  type MarketContextLite, type TradeLite, type MetricRow,
} from '@/lib/condition-lookup-refresh'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/**
 * One-button refresh: regenerate condition_thresholds + condition_lookup
 * directly from the live trade history. Replaces the manual CSV upload
 * loop that was originally fed by an external R/Python notebook.
 *
 * Source of truth for metrics: market_context (rvol, ib_vs_10d_avg,
 * day_range, adr, atr_at_ib_close, atr_1m). Metrics that don't have a
 * persisted value (currently ATR_entry) are surfaced as null and won't
 * contribute to non-ANY bucket constraints.
 *
 * Body: none. Returns count of rows written + new vintage timestamp.
 *
 * After write, /api/condition-lookup (the existing read route used by
 * the prep page) automatically picks up the new data on next call.
 */

export async function POST() {
  try {
    return await handle()
  } catch (e) {
    const err = e as Error
    console.error('[condition-lookup/refresh] failed:', err)
    return NextResponse.json({ error: err.message ?? 'unknown server error' }, { status: 500 })
  }
}

async function handle() {
  const supabase: AnyClient = await createClient()

  // ── 1. Pull market_context + trading_days so we can map id → date ─────────
  const [{ data: contextsRaw, error: cErr }, { data: daysRaw, error: dErr }] = await Promise.all([
    supabase.from('market_context').select('trading_day_id, rvol, ib_vs_10d_avg, adr, day_range, atr_at_ib_close, atr_1m') as Promise<{ data: MarketContextLite[] | null; error: { message: string } | null }>,
    supabase.from('trading_days').select('id, date') as Promise<{ data: { id: string; date: string }[] | null; error: { message: string } | null }>,
  ])
  if (cErr) return NextResponse.json({ error: `Failed to load market_context: ${cErr.message}` }, { status: 500 })
  if (dErr) return NextResponse.json({ error: `Failed to load trading_days: ${dErr.message}` }, { status: 500 })
  const contexts = contextsRaw ?? []
  const days = daysRaw ?? []
  const dayDateById = new Map(days.map(d => [d.id, d.date]))

  // Build dateKey → MetricRow (deriving metrics from each market_context row)
  const metricsByDate = new Map<string, MetricRow>()
  for (const ctx of contexts) {
    const date = dayDateById.get(ctx.trading_day_id)
    if (!date) continue
    metricsByDate.set(date, deriveMetrics(ctx))
  }

  // ── 2. Compute thresholds from the contexts ───────────────────────────────
  const derivedMetricRows = contexts.map(ctx => deriveMetrics(ctx))
  const thresholds = computeThresholds(derivedMetricRows)

  // ── 3. Pull every trade (native + historical), paginated past 1000 cap ────
  const PAGE = 1000
  const native: { pnl: number | null; entry_time: string | null; trading_day_id: string | null }[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('trades')
      .select('pnl, entry_time, trading_day_id')
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('[refresh] trades page', p, error.message); break }
    const rows = (data ?? []) as typeof native
    native.push(...rows)
    if (rows.length < PAGE) break
  }
  const hist: { net_pnl: number | null; trade_date: string | null }[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('historical_trades')
      .select('net_pnl, trade_date')
      .order('trade_date', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('[refresh] historical_trades page', p, error.message); break }
    const rows = (data ?? []) as typeof hist
    hist.push(...rows)
    if (rows.length < PAGE) break
  }

  // Native trades: trading_day_id → date via dayDateById lookup.
  // Historical: trade_date is already a YYYY-MM-DD string.
  const trades: TradeLite[] = []
  for (const t of native) {
    const date = t.trading_day_id ? dayDateById.get(t.trading_day_id) : null
    if (!date) continue
    trades.push({ date, pnl: t.pnl })
  }
  for (const t of hist) {
    if (!t.trade_date) continue
    trades.push({ date: t.trade_date, pnl: t.net_pnl })
  }

  // ── 4. Build the full lookup ──────────────────────────────────────────────
  const lookup = buildLookupRows(trades, metricsByDate, thresholds)

  // ── 5. Wipe + insert (same pattern as the CSV upload route) ───────────────
  const { error: delT } = await supabase.from('condition_thresholds').delete().neq('metric', '__never__')
  if (delT) return NextResponse.json({ error: `Could not clear thresholds: ${delT.message}` }, { status: 500 })
  const { error: delL } = await supabase.from('condition_lookup').delete().neq('condition_id', '__never__')
  if (delL) return NextResponse.json({ error: `Could not clear lookup: ${delL.message}` }, { status: 500 })

  const { error: insT } = await supabase.from('condition_thresholds').insert(thresholds)
  if (insT) return NextResponse.json({ error: `Could not insert thresholds: ${insT.message}` }, { status: 500 })

  // Lookup is ~236 rows; chunk the insert to keep payloads small.
  const CHUNK = 100
  for (let i = 0; i < lookup.length; i += CHUNK) {
    const batch = lookup.slice(i, i + CHUNK)
    const { error: insL } = await supabase.from('condition_lookup').insert(batch)
    if (insL) return NextResponse.json({ error: `Could not insert lookup rows ${i}-${i + batch.length}: ${insL.message}` }, { status: 500 })
  }

  // ── 6. Stamp vintage ──────────────────────────────────────────────────────
  const refreshedAt = new Date().toISOString()
  await supabase
    .from('lookup_metadata')
    .upsert(
      { key: 'condition_lookup_refreshed_at', value: { at: refreshedAt }, updated_at: refreshedAt },
      { onConflict: 'key' },
    )

  return NextResponse.json({
    thresholds_inserted: thresholds.length,
    lookup_inserted: lookup.length,
    trades_aggregated: trades.length,
    market_context_rows: contexts.length,
    refreshed_at: refreshedAt,
  })
}
