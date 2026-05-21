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

  const [{ data: tradesRaw }, { data: daysRaw }, { data: contextsRaw }] = await Promise.all([
    supabase
      .from('trades')
      .select('id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, trading_day_id')
      .order('entry_time', { ascending: true }) as Promise<{ data: Trade[] | null }>,
    supabase
      .from('trading_days')
      .select('id, date, day_type') as Promise<{ data: DayRow[] | null }>,
    supabase
      .from('market_context')
      .select('trading_day_id, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m') as Promise<{ data: ContextRow[] | null }>,
  ])

  const trades = tradesRaw ?? []
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
