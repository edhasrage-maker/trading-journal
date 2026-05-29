import { createClient } from '@/lib/supabase/server'
import AnalyticsClient from '@/components/analytics/AnalyticsClient'
import { joinTradesWithContext } from '@/lib/analytics'
import type { TradingDay, Trade, MarketContext } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

type DayRow = Pick<TradingDay, 'id' | 'date' | 'day_type'>
type ContextRow = Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>

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

  const days = daysRaw ?? []
  const contexts = contextsRaw ?? []
  const joined = joinTradesWithContext(trades, days, contexts)

  const sortedDates = days.map(d => d.date).sort()
  const defaultStartDate = sortedDates[0] ?? new Date().toISOString().slice(0, 10)
  const defaultEndDate = sortedDates[sortedDates.length - 1] ?? new Date().toISOString().slice(0, 10)

  return (
    <div className="max-w-6xl mx-auto">
      <AnalyticsClient
        trades={joined}
        defaultStartDate={defaultStartDate}
        defaultEndDate={defaultEndDate}
      />
    </div>
  )
}
