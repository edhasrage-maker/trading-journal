import { createClient } from '@/lib/supabase/server'
import PrepClient from '@/components/prep/PrepClient'
import { computeDrAdr } from '@/lib/dr-adr'
import type { TradingDay, MarketContext, Trade } from '@/lib/supabase/types'

export default async function PrepPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase = await createClient()

  const { data: dayRaw } = await supabase
    .from('trading_days').select('*').eq('date', date).single()
  // Normalize day_types: SELECT '*' returns the column when present, missing
  // otherwise. Coerce to a typed shape so the client always sees an array
  // (possibly empty) rather than undefined.
  const dayObj = dayRaw as (Record<string, unknown> & TradingDay) | null
  const day = dayObj ? {
    ...dayObj,
    day_types: Array.isArray(dayObj.day_types) ? dayObj.day_types as string[] : null,
  } as TradingDay : null

  const { data: contextRaw } = day
    ? await supabase.from('market_context').select('*').eq('trading_day_id', day.id).single()
    : { data: null }
  const context = contextRaw as MarketContext | null

  // Day-type options are now sourced from trade_tags so prep + intraday share
  // a single canonical list. The old hardcoded set in PrepClient.tsx was
  // misaligned with the intraday TagSelector — picking "Range Day" in prep
  // matched no chip on the intraday form because that label didn't exist in
  // trade_tags. Sourcing both from one table fixes the drift.
  const { data: dayTypeTags } = await supabase
    .from('trade_tags')
    .select('label')
    .eq('category', 'day_type')
    .order('sort_order')
  const dayTypeOptions = ((dayTypeTags ?? []) as { label: string }[]).map(t => t.label)

  // DR_ADR auto-detect. Priority:
  //   1. market_context.day_range / market_context.adr — extract-context AI
  //      reads "Day's Range" directly from Sierra's stats overlay. This is
  //      the user-canonical value and works even before bars are imported.
  //   2. Bar-based fallback (computeDrAdr) — high-low of 1-min bars in the
  //      6:30-7:30 PT window. Useful for historical days or when the user
  //      hasn't extracted today's screenshot yet.
  const FALLBACK_SYMBOL = 'MNQM6.CME'
  const symbolForBars = context?.symbol && /^[A-Z]+\d+\.[A-Z]+$/.test(context.symbol)
    ? context.symbol
    : FALLBACK_SYMBOL
  let drAdrAuto: number | null = null
  if (context?.day_range != null && context.adr != null && context.adr > 0) {
    drAdrAuto = Math.round((context.day_range / context.adr) * 100) / 100
  } else {
    const drAdrResult = await computeDrAdr(supabase, date, symbolForBars, context?.adr ?? null)
    drAdrAuto = drAdrResult.dr_adr != null
      ? Math.round(drAdrResult.dr_adr * 100) / 100
      : null
  }

  // Trades already taken on this date — feeds the LiveChart so prep shows
  // any trades that have happened so far today (overlap with the EOD chart).
  // Most prep is done before any trades fire, but mid-session re-prep should
  // see what's been done.
  const { data: tradesRaw } = day
    ? await supabase
        .from('trades')
        .select('*')
        .eq('trading_day_id', day.id)
        .order('entry_time', { ascending: true })
    : { data: [] as Trade[] }
  const trades = (tradesRaw ?? []) as Trade[]

  // Pick the chart symbol the same way EodClient does: most-common symbol on
  // the day's trades. Fallback to the symbolForBars derived above (MNQM6.CME)
  // so the chart can render even on days with no trades yet — the user can
  // still see today's price action.
  const symbolCounts = new Map<string, number>()
  for (const t of trades) {
    if (t.symbol) symbolCounts.set(t.symbol, (symbolCounts.get(t.symbol) ?? 0) + 1)
  }
  let chartSymbol: string | null = null
  let best = 0
  for (const [sym, c] of symbolCounts) if (c > best) { chartSymbol = sym; best = c }
  if (!chartSymbol) chartSymbol = symbolForBars

  return (
    <PrepClient
      date={date}
      initialDay={day}
      initialContext={context}
      dayTypeOptions={dayTypeOptions}
      drAdrAuto={drAdrAuto}
      chartSymbol={chartSymbol}
      initialTrades={trades}
    />
  )
}
