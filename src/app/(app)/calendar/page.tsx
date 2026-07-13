import { createClient } from '@/lib/supabase/server'
import CalendarClient from '@/components/calendar/CalendarClient'
import { buildDaySummaries } from '@/lib/analytics'
import { tapeScoreFromAnalyses } from '@/lib/tapescore'
import type { CalendarDay } from '@/lib/calendar-insights'
import type { TradingDay, Trade } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

// ai_analysis_json (prep score) + eod_ai_analysis_json (process/execution) drive
// the per-day TapeScore the calendar now colors by — same derivation the
// dashboard uses (src/lib/tapescore.ts).
type DayRow = Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type' | 'day_types' | 'ai_analysis_json' | 'eod_ai_analysis_json'>
type TradeRow = Pick<Trade, 'id' | 'pnl' | 'trading_day_id'>

export default async function CalendarPage() {
  const supabase: AnyClient = await createClient()

  const [{ data: daysRaw }, { data: tradesRaw }] = await Promise.all([
    supabase
      .from('trading_days')
      .select('id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json')
      .order('date', { ascending: true }) as Promise<{ data: DayRow[] | null }>,
    supabase
      .from('trades')
      .select('id, pnl, trading_day_id') as Promise<{ data: TradeRow[] | null }>,
  ])

  const days = daysRaw ?? []
  const trades = tradesRaw ?? []
  const summaries = buildDaySummaries(days, trades)

  // Merge each day's derived TapeScore + breach flag onto its summary.
  const rowByDate = new Map(days.map(d => [d.date, d]))
  const calendarDays: CalendarDay[] = summaries.map(s => {
    const row = rowByDate.get(s.date)
    const ts = tapeScoreFromAnalyses(row?.eod_ai_analysis_json, row?.ai_analysis_json?.score ?? null)
    return {
      date: s.date,
      pnl: s.pnl,
      trade_count: s.trade_count,
      wins: s.wins,
      losses: s.losses,
      day_type: s.day_type,
      day_types: s.day_types,
      tapescore: ts?.score ?? null,
      band: ts?.band ?? null,
      breach: ts?.components.verdict === 'Breach',
    }
  })

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
        days={calendarDays}
        defaultStartDate={defaultStartDate}
        defaultEndDate={defaultEndDate}
        dayTypes={dayTypes}
      />
    </div>
  )
}
