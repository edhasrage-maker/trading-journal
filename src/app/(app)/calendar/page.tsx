import { createClient } from '@/lib/supabase/server'
import CalendarClient from '@/components/calendar/CalendarClient'
import { buildDaySummaries } from '@/lib/analytics'
import type { TradingDay, Trade } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

type DayRow = Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type' | 'day_types'>
type TradeRow = Pick<Trade, 'id' | 'pnl' | 'trading_day_id'>

export default async function CalendarPage() {
  const supabase: AnyClient = await createClient()

  const [{ data: daysRaw }, { data: tradesRaw }] = await Promise.all([
    supabase
      .from('trading_days')
      .select('id, date, eod_pnl, day_type, day_types')
      .order('date', { ascending: true }) as Promise<{ data: DayRow[] | null }>,
    supabase
      .from('trades')
      .select('id, pnl, trading_day_id') as Promise<{ data: TradeRow[] | null }>,
  ])

  const days = daysRaw ?? []
  const trades = tradesRaw ?? []
  const summaries = buildDaySummaries(days, trades)

  // Date range bounds
  const defaultStartDate = days.length > 0 ? days[0].date : new Date().toISOString().slice(0, 10)
  const defaultEndDate = days.length > 0 ? days[days.length - 1].date : new Date().toISOString().slice(0, 10)

  // Distinct day types for filter — flatten across the multi-select array,
  // falling back to the legacy single column when the array is empty.
  const dayTypes = Array.from(
    new Set(
      days.flatMap(d => {
        const arr = (d.day_types && d.day_types.length > 0)
          ? d.day_types
          : (d.day_type ? [d.day_type] : [])
        return arr.map(s => s.trim()).filter(Boolean)
      }),
    ),
  ).sort()

  return (
    <div className="max-w-6xl mx-auto">
      <CalendarClient
        summaries={summaries}
        defaultStartDate={defaultStartDate}
        defaultEndDate={defaultEndDate}
        dayTypes={dayTypes}
      />
    </div>
  )
}
