import { createClient } from '@/lib/supabase/server'
import AnalyticsClient from '@/components/analytics/AnalyticsClient'
import { joinTradesWithContext, type TradeWithContext } from '@/lib/analytics'
import type { TradingDay, Trade, MarketContext } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

type DayRow = Pick<TradingDay, 'id' | 'date' | 'day_type' | 'day_types' | 'eod_pnl' | 'ai_analysis_json'>
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
  // Bar-derived excursion fields, populated by scripts/backfill-historical-mfe.ts.
  // Null on dates the CSV doesn't cover (currently ~6 weeks at the tail end
  // until the user re-exports a longer CSV / runs the .scid path). Analytics
  // gracefully shows "—" for those rows in the MFE/MAE columns.
  high_during_position: number | null
  low_during_position: number | null
  // Per-trade entry-time snapshots (backfilled by scripts/backfill-entry-metrics.ts).
  entry_atr_1m: number | null
  entry_rvol: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
}

/**
 * Map an imported historical (Tradezella) trade into the TradeWithContext shape
 * the analytics aggregations consume. We synthesize a stop price from the
 * recorded realized RR so Avg R includes these trades too (rMultiple =
 * pnl / (|entry-stop|*qty) == realized_rr by construction).
 */
/** Per-date market_context lookup so historical trades on dates that have
 *  a `trading_days` + `market_context` row (either AI-extracted from a prep
 *  screenshot, or backfilled from a 1m CSV) get bucketed correctly instead
 *  of falling into the Unknown bin. */
type ContextByDate = Map<string, Pick<ContextRow, 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>>

/** Per-date day-type lookup pulled from native `trading_days.day_types[]`
 *  (the labels the trader set during prep). Historical Tradezella trades
 *  on dates the trader prepped will inherit those labels; historical trades
 *  on un-prepped dates fall through to "Untagged" rather than borrowing
 *  Tradezella's own day_type field (which uses a different taxonomy and
 *  was conflating Untagged with TZ's "ungrouped" bucket). */
type DayTypesByDate = Map<string, string[]>

function histToContext(h: HistRow, ctxByDate: ContextByDate, dayTypesByDate: DayTypesByDate): TradeWithContext {
  const entry = h.entry_price, qty = h.quantity, pnl = h.net_pnl, rr = h.realized_rr
  let stop: number | null = null
  if (entry != null && qty && pnl != null && rr != null && rr !== 0) {
    const dist = Math.abs(pnl / (rr * qty))
    if (Number.isFinite(dist) && dist > 0) stop = h.side === 'short' ? entry + dist : entry - dist
  }
  // Day types for historical trades come from the NATIVE trading_days lookup
  // (the trader's own prep-tagged labels), NOT from Tradezella's tags_json.
  // Tradezella's day_type field uses a different taxonomy (and most TZ trades
  // predate the trader's current taxonomy anyway), so importing those labels
  // muddies the Day Type analytics. If the trader prepped the day natively,
  // those day_types carry over; otherwise the trade is honestly "Untagged".
  const dayTypes = h.trade_date ? (dayTypesByDate.get(h.trade_date) ?? []) : []
  // Inherit any market_context that exists for this date — Tradezella doesn't
  // export RVol/IB/ADR/ATR, but if the user later logged a prep on the same
  // date OR ran the CSV-driven backfill, those fields are available here.
  const ctx = h.trade_date ? ctxByDate.get(h.trade_date) : undefined
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
    // symbol left null intentionally: Tradezella history doesn't carry the
    // contract symbol, and `realized_rr` was already computed externally with
    // whatever multiplier was appropriate. Passing null makes symbolToMultiplier
    // return 1, so rMultiple computes pnl / (|entry-stop|*qty) — which equals
    // realized_rr by construction (see the stop synthesis above). Setting a
    // real symbol here would scale R by 1/multiplier and break parity with
    // realized_rr.
    symbol: null,
    // Excursion fields are backfilled from 1m CSV bars by
    // scripts/backfill-historical-mfe.ts. Tradezella's own price_mfe/mae
    // fields are intentionally NOT used here — the trader distrusts them.
    // Trades on dates not covered by the CSV stay null and analytics
    // shows "—" the same way it does for native trades without excursion
    // data.
    high_during_position: h.high_during_position,
    low_during_position: h.low_during_position,
    entry_atr_1m: h.entry_atr_1m,
    entry_rvol: h.entry_rvol,
    date: h.trade_date ?? '',
    day_type: dayTypes[0] ?? null,
    day_types: dayTypes,
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
      .select('id, date, day_type, day_types, eod_pnl, ai_analysis_json') as Promise<{ data: DayRow[] | null }>,
    supabase
      .from('market_context')
      .select('trading_day_id, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m') as Promise<{ data: ContextRow[] | null }>,
  ])

  // Paginate past Supabase's 1000-row cap. The journal has thousands of trades,
  // and the recently-tagged ones are the NEWEST — so a single capped query
  // (ascending) returned only the oldest, untagged trades and Analytics came up
  // empty. id is the tiebreaker so range() paging is deterministic.
  const PAGE = 1000
  // entry_atr_1m / entry_rvol added by the 2026-06-09 migration — Supabase
  // generated types haven't been regenerated yet, so we widen the row type
  // locally. When the types are next regenerated, drop the intersection.
  type TradeRowWithEntryMetrics = Trade & { entry_atr_1m: number | null; entry_rvol: number | null }
  const trades: TradeRowWithEntryMetrics[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('trades')
      .select('id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, trading_day_id, symbol, high_during_position, low_during_position, entry_atr_1m, entry_rvol')
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('[analytics] trades page', p, 'failed:', error.message); break }
    // Runtime shape includes entry_atr_1m + entry_rvol (added to SELECT above);
    // generated Trade type doesn't know about them yet so we widen via unknown.
    const rows = (data ?? []) as unknown as TradeRowWithEntryMetrics[]
    trades.push(...rows)
    if (rows.length < PAGE) break
  }

  // Imported historical trades (e.g. Tradezella) — a separate read-only store
  // merged in for long-term tag analysis. Paginated the same way.
  const hist: HistRow[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('historical_trades')
      .select('id, net_pnl, entry_price, quantity, side, open_at, trade_date, realized_rr, high_during_position, low_during_position, entry_atr_1m, entry_rvol, tags_json')
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
  // Build a date→context map so historical (Tradezella) trades can inherit
  // market_context populated by either the prep screenshot AI or the
  // CSV-driven backfill — without it they all fall into the Unknown bucket.
  const dayDateById = new Map(days.map(d => [d.id, d.date]))
  const ctxByDate: ContextByDate = new Map()
  for (const c of contexts) {
    const date = dayDateById.get(c.trading_day_id)
    if (date) ctxByDate.set(date, c)
  }
  // Build a date→day_types[] map from native trading_days so historical
  // trades pick up the trader's own prep-tagged labels (not Tradezella's
  // taxonomy). Native rows have either day_types[] (current) or day_type
  // (legacy single); fall back to [day_type] when the array is empty.
  const dayTypesByDate: DayTypesByDate = new Map()
  for (const d of days) {
    const types = (d.day_types && d.day_types.length > 0)
      ? d.day_types
      : (d.day_type ? [d.day_type] : [])
    if (types.length > 0) dayTypesByDate.set(d.date, types)
  }
  const joined = joinTradesWithContext(trades, days, contexts)
  const merged = [...joined, ...hist.map(h => histToContext(h, ctxByDate, dayTypesByDate))]

  // Earliest date across native days + historical trades, so "All" covers both.
  const allDates = [...days.map(d => d.date), ...hist.map(h => h.trade_date).filter((d): d is string => !!d)].sort()
  const defaultStartDate = allDates[0] ?? new Date().toISOString().slice(0, 10)
  const defaultEndDate = allDates[allDates.length - 1] ?? new Date().toISOString().slice(0, 10)

  // Per-day stats for the period-comparison view: date, eod_pnl override,
  // process score from the prep AI analysis. Per-trade win rate / count is
  // computed client-side from the trades array — keeps this projection
  // small and avoids re-querying.
  const dayStats = days.map(d => ({
    date: d.date,
    eod_pnl: d.eod_pnl ?? null,
    process_score: (d.ai_analysis_json?.score as number | undefined) ?? null,
  }))

  return (
    <div className="max-w-6xl mx-auto">
      <AnalyticsClient
        trades={merged}
        dayStats={dayStats}
        defaultStartDate={defaultStartDate}
        defaultEndDate={defaultEndDate}
      />
    </div>
  )
}
