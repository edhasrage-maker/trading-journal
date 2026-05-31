import { createClient } from '@/lib/supabase/server'
import AnalyticsClient from '@/components/analytics/AnalyticsClient'
import { joinTradesWithContext, type TradeWithContext } from '@/lib/analytics'
import type { TradingDay, Trade, MarketContext } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

type DayRow = Pick<TradingDay, 'id' | 'date' | 'day_type'>
type ContextRow = Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>

interface HistRow {
  id: string
  net_pnl: number | null
  entry_price: number | null
  quantity: number | null
  side: string | null
  open_at: string | null
  trade_date: string | null
  realized_rr: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
}

/**
 * Map an imported historical (Tradezella) trade into the TradeWithContext shape
 * the analytics aggregations consume. We synthesize a stop price from the
 * recorded realized RR so Avg R includes these trades too (rMultiple =
 * pnl / (|entry-stop|*qty) == realized_rr by construction).
 *
 * Optional `ctx` is the market_context row for the trade's date (looked up via
 * trading_days.date in the caller). When present, the historical trade can be
 * bucketed by rvol/ADR/ATR/IB the same as native trades — otherwise it lands
 * in the "Unknown" bucket on the Condition Buckets section.
 */
function histToContext(h: HistRow, ctx: ContextRow | null): TradeWithContext {
  const entry = h.entry_price, qty = h.quantity, pnl = h.net_pnl, rr = h.realized_rr
  let stop: number | null = null
  if (entry != null && qty && pnl != null && rr != null && rr !== 0) {
    const dist = Math.abs(pnl / (rr * qty))
    if (Number.isFinite(dist) && dist > 0) stop = h.side === 'short' ? entry + dist : entry - dist
  }
  return {
    id: h.id,
    pnl,
    entry_price: entry,
    stop_price: stop,
    quantity: qty,
    direction: (h.side as 'long' | 'short' | null) ?? null,
    entry_time: h.open_at,
    tags_json: h.tags_json ?? {},
    trading_day_id: '',
    date: h.trade_date ?? '',
    day_type: (h.tags_json?.day_type as string) ?? null,
    rvol: ctx?.rvol ?? null,
    ib_size: ctx?.ib_size ?? null,
    ib_vs_10d_avg: ctx?.ib_vs_10d_avg ?? null,
    adr: ctx?.adr ?? null,
    atr_1m: ctx?.atr_1m ?? null,
  }
}

export default async function AnalyticsPage() {
  const supabase: AnyClient = await createClient()

  const [{ data: daysRaw }, { data: contextsRaw }] = await Promise.all([
    supabase
      .from('trading_days')
      .select('id, date, day_type') as Promise<{ data: DayRow[] | null }>,
    supabase
      .from('market_context')
      .select('trading_day_id, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m') as Promise<{ data: ContextRow[] | null }>,
  ])

  // Paginate past Supabase's 1000-row cap. The journal has thousands of trades,
  // and the recently-tagged ones are the NEWEST — so a single capped query
  // (ascending) returned only the oldest, untagged trades and Analytics came up
  // empty. id is the tiebreaker so range() paging is deterministic.
  const PAGE = 1000
  const trades: Trade[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('trades')
      .select('id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, trading_day_id')
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('[analytics] trades page', p, 'failed:', error.message); break }
    const rows = (data ?? []) as Trade[]
    trades.push(...rows)
    if (rows.length < PAGE) break
  }

  // Imported historical trades (e.g. Tradezella) — a separate read-only store
  // merged in for long-term tag analysis. Paginated the same way.
  const hist: HistRow[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('historical_trades')
      .select('id, net_pnl, entry_price, quantity, side, open_at, trade_date, realized_rr, tags_json')
      .order('trade_date', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('[analytics] historical page', p, 'failed:', error.message); break }
    const rows = (data ?? []) as HistRow[]
    hist.push(...rows)
    if (rows.length < PAGE) break
  }

  const days = daysRaw ?? []
  const contexts = contextsRaw ?? []
  const joined = joinTradesWithContext(trades, days, contexts)

  // Dedup against the native side: any date that has native trades wins, so
  // historical_trades rows on that date are dropped. Without this, dates the
  // user has both logged natively AND imported from Tradezella get
  // double-counted across every tag/PnL aggregate (102 trades vs 57 in
  // Tradezella for the same month, ~3x PnL, etc.). Mirror of the dedup logic
  // in /calendar/page.tsx.
  // Build a date → market_context lookup so historical trades can borrow the
  // user's manually-entered market context when a trading_day exists for the
  // same date. Without this, every TZ trade lands in the "Unknown" condition
  // bucket regardless of whether market_context has been filled in for the date.
  const ctxByTradingDay = new Map<string, ContextRow>()
  for (const c of contexts) {
    if (c.trading_day_id) ctxByTradingDay.set(c.trading_day_id, c)
  }
  const ctxByDate = new Map<string, ContextRow>()
  for (const d of days) {
    const c = ctxByTradingDay.get(d.id)
    if (c) ctxByDate.set(d.date, c)
  }

  // Tag each row with its source. We do NOT pre-dedup on the server — that
  // would collapse the historical count to ~195 (only overlap-free dates),
  // so a user picking "Historical only" wouldn't see their full 915-row
  // Tradezella set. Dedup is applied conditionally on the client based on
  // the Source filter (see AnalyticsClient.filtered).
  const merged: TradeWithContext[] = [
    ...joined.map(t => ({ ...t, source: 'native' as const })),
    ...hist.map(h => {
      const ctx = h.trade_date ? ctxByDate.get(h.trade_date.slice(0, 10)) ?? null : null
      return { ...histToContext(h, ctx), source: 'historical' as const }
    }),
  ]

  // Earliest/latest date across all sources so the date pickers can reach
  // every row.
  const allDates = [
    ...days.map(d => d.date),
    ...hist.map(h => h.trade_date).filter((d): d is string => !!d),
  ].sort()
  const defaultStartDate = allDates[0] ?? new Date().toISOString().slice(0, 10)
  const defaultEndDate = allDates[allDates.length - 1] ?? new Date().toISOString().slice(0, 10)

  return (
    <div className="max-w-6xl mx-auto">
      <AnalyticsClient
        trades={merged}
        defaultStartDate={defaultStartDate}
        defaultEndDate={defaultEndDate}
      />
    </div>
  )
}
