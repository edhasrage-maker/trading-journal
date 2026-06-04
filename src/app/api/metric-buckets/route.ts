import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { computeBuckets, type MetricBuckets, type DaySample } from '@/lib/metric-buckets'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000

/**
 * GET /api/metric-buckets
 *
 * Builds per-metric tercile buckets from the trader's historical session data
 * and ranks each bucket by realized day-level PnL. Result feeds the prep page's
 * "Suggested: Bad/Mid/Good" hint next to RVOL / ADR / IB Size / ATR-10 (1m).
 *
 * Response shape: { rvol: MetricBuckets, adr: MetricBuckets, ib_size, atr_1m,
 *                   total_days, date_range }
 *
 * Performance source for each day, in priority order:
 *   1. trading_days.eod_pnl (explicit override)
 *   2. SUM(trades.pnl) for that day
 *   3. Day is excluded if neither is available.
 *
 * Metric values come from market_context joined by trading_day_id.
 *
 * Sample-size guard: any metric with <9 qualifying days returns
 * insufficient_data=true and the UI shows no suggestion.
 */
export async function GET() {
  const supabase: AnyClient = await createClient()

  // Pull every trading_day with a date — we'll join market_context and trades
  // in the next step. Pagination here is overkill for typical journal sizes
  // (a few hundred sessions) but matches the convention from analytics.
  const days: Array<{ id: string; date: string; eod_pnl: number | null }> = []
  for (let p = 0; p < 5; p++) {
    const { data, error } = await supabase
      .from('trading_days')
      .select('id, date, eod_pnl')
      .order('date', { ascending: false })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const batch = (data ?? []) as Array<{ id: string; date: string; eod_pnl: number | null }>
    days.push(...batch)
    if (batch.length < PAGE) break
  }

  if (days.length === 0) {
    return NextResponse.json({
      rvol: emptyBuckets(),
      adr: emptyBuckets(),
      ib_size: emptyBuckets(),
      atr_1m: emptyBuckets(),
      total_days: 0,
      date_range: null,
    })
  }

  const dayIds = days.map(d => d.id)

  // Batch the joined queries. Market context for metric values, trades for
  // fallback PnL when eod_pnl is null. Each ID is 36 chars and PostgREST
  // serializes .in() into the URL query string — 500+ UUIDs blows past
  // HTTP URL length limits and the request just hangs until it errors with
  // "fetch failed" at ~8s. Chunk to keep each request under ~2KB of IDs.
  const CHUNK = 50  // 50 * 36 chars = ~1.8KB worst-case
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function fetchChunked<T>(table: string, select: string): Promise<T[]> {
    const out: T[] = []
    for (let i = 0; i < dayIds.length; i += CHUNK) {
      const slice = dayIds.slice(i, i + CHUNK)
      const { data, error } = await supabase.from(table).select(select).in('trading_day_id', slice)
      if (error) throw new Error(`${table}: ${error.message}`)
      out.push(...((data ?? []) as T[]))
    }
    return out
  }

  let ctxRaw: Array<{ trading_day_id: string; rvol: number | null; adr: number | null; ib_size: number | null; atr_1m: number | null }>
  let tradesRaw: Array<{ trading_day_id: string; pnl: number | null }>
  try {
    [ctxRaw, tradesRaw] = await Promise.all([
      fetchChunked<typeof ctxRaw[number]>('market_context', 'trading_day_id, rvol, adr, ib_size, atr_1m'),
      fetchChunked<typeof tradesRaw[number]>('trades', 'trading_day_id, pnl'),
    ])
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'fetch failed' }, { status: 500 })
  }

  interface MarketCtxSlim {
    trading_day_id: string
    rvol: number | null
    adr: number | null
    ib_size: number | null
    atr_1m: number | null
  }
  const ctxByDay = new Map<string, MarketCtxSlim>()
  for (const c of ctxRaw) ctxByDay.set(c.trading_day_id, c)
  const tradePnlByDay = new Map<string, number>()
  for (const t of tradesRaw) {
    if (t.pnl == null) continue
    tradePnlByDay.set(t.trading_day_id, (tradePnlByDay.get(t.trading_day_id) ?? 0) + t.pnl)
  }

  // Build per-metric DaySample lists.
  const collect = (metric: keyof Omit<MarketCtxSlim, 'trading_day_id'>): DaySample[] => {
    const out: DaySample[] = []
    for (const d of days) {
      const ctx = ctxByDay.get(d.id)
      if (!ctx) continue
      const v = ctx[metric]
      if (v == null) continue
      const pnl = d.eod_pnl ?? tradePnlByDay.get(d.id)
      if (pnl == null) continue
      out.push({ value: v, pnl })
    }
    return out
  }

  const rvolSamples = collect('rvol')
  const adrSamples = collect('adr')
  const ibSamples = collect('ib_size')
  const atrSamples = collect('atr_1m')

  return NextResponse.json({
    rvol: computeBuckets(rvolSamples),
    adr: computeBuckets(adrSamples),
    ib_size: computeBuckets(ibSamples),
    atr_1m: computeBuckets(atrSamples),
    total_days: days.length,
    date_range: {
      from: days[days.length - 1].date,
      to: days[0].date,
    },
  })
}

function emptyBuckets(): MetricBuckets {
  return { buckets: [], total_days_sampled: 0, insufficient_data: true }
}
