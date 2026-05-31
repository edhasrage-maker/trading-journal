import { createClient } from '@/lib/supabase/server'
import CalendarClient from '@/components/calendar/CalendarClient'
import { buildDaySummaries, type DaySummary } from '@/lib/analytics'
import type { TradingDay, Trade } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

type DayRow = Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type'>
type TradeRow = Pick<Trade, 'id' | 'pnl' | 'trading_day_id'>
type HistRow = { trade_date: string | null; net_pnl: number | null }

const PAGE = 1000

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function CalendarPage() {
  const supabase: AnyClient = await createClient()

  const [{ data: daysRaw }, { data: tradesRaw }] = await Promise.all([
    supabase
      .from('trading_days')
      .select('id, date, eod_pnl, day_type')
      .order('date', { ascending: true }) as Promise<{ data: DayRow[] | null }>,
    supabase
      .from('trades')
      .select('id, pnl, trading_day_id') as Promise<{ data: TradeRow[] | null }>,
  ])

  // historical_trades is paginated (Supabase 1000-row cap; ~915 rows today but
  // grows on each re-import). Without pagination only the oldest 1000 land in
  // the calendar, leaving recent historical dates blank.
  const hist: HistRow[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('historical_trades')
      .select('trade_date, net_pnl, id')
      .order('trade_date', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) { console.error('[calendar] historical_trades page', p, 'failed:', error.message); break }
    const rows = (data ?? []) as HistRow[]
    hist.push(...rows)
    if (rows.length < PAGE) break
  }

  const days = daysRaw ?? []
  const trades = tradesRaw ?? []
  const nativeSummaries = buildDaySummaries(days, trades)

  // TZ-AS-BASELINE policy (mirrors AnalyticsClient): aggregate Tradezella per
  // date and use its per-position totals as the authoritative source through
  // its last covered day. Native days are kept only when their date is
  // strictly AFTER Tradezella's last date — i.e. genuinely new trading the
  // user has done since the last import. Pre-Tradezella native days are
  // intentionally hidden from the calendar so the totals match Tradezella.
  const histByDate = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>()
  let tzLastDate = ''
  for (const h of hist) {
    if (!h.trade_date) continue
    const date = h.trade_date.slice(0, 10)
    if (date > tzLastDate) tzLastDate = date
    const e = histByDate.get(date) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 }
    const pnl = h.net_pnl ?? 0
    e.pnl += pnl
    e.trades += 1
    if (pnl > 0) e.wins++
    else if (pnl < 0) e.losses++
    histByDate.set(date, e)
  }
  const histSummaries: DaySummary[] = Array.from(histByDate.entries()).map(([date, agg]) => ({
    date,
    pnl: agg.pnl,
    trade_count: agg.trades,
    wins: agg.wins,
    losses: agg.losses,
    day_type: null,
  }))
  // Native days survive only when strictly after Tradezella's last day.
  const nativeKept = tzLastDate
    ? nativeSummaries.filter(s => s.date > tzLastDate)
    : nativeSummaries

  const summaries: DaySummary[] = [...nativeKept, ...histSummaries].sort((a, b) =>
    a.date.localeCompare(b.date),
  )

  // Date range bounds — span both sources so the calendar header can navigate
  // back into the historical years even before any native day was logged.
  const allDates: string[] = summaries.map(s => s.date)
  const defaultStartDate = allDates[0] ?? new Date().toISOString().slice(0, 10)
  const defaultEndDate = allDates[allDates.length - 1] ?? new Date().toISOString().slice(0, 10)

  // Distinct day types for filter (still only from native days — historical
  // rows don't carry a day_type by design).
  const dayTypes = Array.from(
    new Set(days.map(d => (d.day_type ?? '').trim()).filter(Boolean)),
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
