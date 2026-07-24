import { createClient } from '@/lib/supabase/server'
import { weekTradingDays, weekEnd, weekLabel, weekStartFor } from '@/lib/week-dates'
import WeeklyRecapClient, { type DayCard, type WeeklyRecapInitial } from '@/components/weekly/WeeklyRecapClient'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface PageProps {
  params: Promise<{ weekStart: string }>
}

export default async function WeeklyRecapPage({ params }: PageProps) {
  const { weekStart: rawWeekStart } = await params
  // Normalize: if user passed a non-Monday date, redirect to the Monday of
  // that week so the URL is canonical.
  const canonical = weekStartFor(rawWeekStart)
  if (canonical !== rawWeekStart) redirect(`/weekly/${canonical}`)
  const weekStart = canonical

  const supabase: AnyClient = await createClient()
  const dates = weekTradingDays(weekStart)
  const endDate = weekEnd(weekStart)

  // Pull the 5 trading_days in this window (if they exist).
  const { data: days } = await supabase
    .from('trading_days')
    .select('id, date, day_types, eod_pnl, eod_ai_analysis_json')
    .gte('date', weekStart)
    .lte('date', endDate)
    .order('date', { ascending: true })
  interface DayRow {
    id: string
    date: string
    day_types: string[] | null
    eod_pnl: number | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eod_ai_analysis_json: any
  }
  const daysByDate = new Map<string, DayRow>(((days ?? []) as DayRow[]).map(d => [d.date, d]))

  // Aggregate trades per day for the cards.
  const dayIds = Array.from(daysByDate.values()).map(d => d.id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tradesPerDay = new Map<string, any[]>()
  if (dayIds.length > 0) {
    const { data: trades } = await supabase
      .from('trades')
      .select('id, trading_day_id, direction, pnl, entry_price, stop_price, quantity, symbol, tags_json, structure_5m_alignment')
      .in('trading_day_id', dayIds)
    for (const t of (trades ?? []) as Array<{ trading_day_id: string }>) {
      const arr = tradesPerDay.get(t.trading_day_id) ?? []
      arr.push(t)
      tradesPerDay.set(t.trading_day_id, arr)
    }
  }

  // Build the day cards.
  const dayCards: DayCard[] = dates.map(date => {
    const day = daysByDate.get(date)
    if (!day) return {
      date, day_types: [], eod_pnl: null, trade_count: 0, wins: 0,
      execution_composite: null, process_verdict: null,
    }
    const trades = tradesPerDay.get(day.id) ?? []
    const wins = trades.filter((t: { pnl: number | null }) => (t.pnl ?? 0) > 0).length
    const losers = trades.filter((t: { pnl: number | null }) => (t.pnl ?? 0) < 0).length
    const pnlFromTrades = trades.reduce((s: number, t: { pnl: number | null }) => s + (t.pnl ?? 0), 0)
    return {
      date,
      day_types: day.day_types ?? [],
      eod_pnl: day.eod_pnl != null ? day.eod_pnl : (trades.length > 0 ? pnlFromTrades : null),
      trade_count: trades.length,
      wins,
      win_rate: (wins + losers) > 0 ? Math.round((wins / (wins + losers)) * 100) : null,
      execution_composite: day.eod_ai_analysis_json?.execution?.composite ?? null,
      process_verdict: day.eod_ai_analysis_json?.process?.verdict ?? null,
    } satisfies DayCard
  })

  // Load existing recap row (synthesis + notes), if any.
  let initialRecap: WeeklyRecapInitial = {
    ai_synthesis_json: null, notes_md: '', generated_at: null,
  }
  try {
    const { data: recapRow } = await supabase
      .from('weekly_recap')
      .select('ai_synthesis_json, notes_md, generated_at')
      .eq('week_start_date', weekStart)
      .maybeSingle()
    if (recapRow) {
      initialRecap = {
        ai_synthesis_json: recapRow.ai_synthesis_json ?? null,
        notes_md: recapRow.notes_md ?? '',
        generated_at: recapRow.generated_at ?? null,
      }
    }
  } catch { /* table may not exist yet — silently fall back */ }

  return (
    <div>
      <WeeklyRecapClient
        weekStart={weekStart}
        weekLabelText={weekLabel(weekStart)}
        dayCards={dayCards}
        initialRecap={initialRecap}
      />
    </div>
  )
}
