import { createClient } from '@/lib/supabase/server'
import PrepClient from '@/components/prep/PrepClient'
import { computeDrAdr } from '@/lib/dr-adr'
import type { TradingDay, MarketContext } from '@/lib/supabase/types'

export default async function PrepPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase = await createClient()

  const { data: dayRaw } = await supabase
    .from('trading_days').select('*').eq('date', date).single()
  const day = dayRaw as TradingDay | null

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

  // Auto-detect DR_ADR from 1-min bars in the 6:30-7:30 PT window. Falls back
  // to null when bars haven't been imported yet for the date — pill renders
  // empty and a hard-reload after BarWatcher syncs will populate it.
  // market_context.symbol is sometimes garbled from screenshot extraction
  // (e.g. "S@30678.00") — fall back to the journal's default chart symbol.
  const FALLBACK_SYMBOL = 'MNQM6.CME'
  const symbolForBars = context?.symbol && /^[A-Z]+\d+\.[A-Z]+$/.test(context.symbol)
    ? context.symbol
    : FALLBACK_SYMBOL
  const drAdrResult = await computeDrAdr(supabase, date, symbolForBars, context?.adr ?? null)
  // Round to 2dp for display — the underlying ratio carries more precision
  // than is meaningful for the lookup buckets (which are coarse percentiles).
  const drAdrAuto = drAdrResult.dr_adr != null
    ? Math.round(drAdrResult.dr_adr * 100) / 100
    : null

  // NOTE: RVOL / ADR / ATR-10 in market_context come from /api/extract-context
  // (the Sierra Chart screenshot AI). They are NOT auto-computed from bars —
  // the screenshot is the source of truth, since Sierra Chart shows the
  // user-canonical formula values directly. DR_ADR above is the exception
  // because Sierra doesn't show that derived ratio directly.

  return (
    <PrepClient
      date={date}
      initialDay={day}
      initialContext={context}
      dayTypeOptions={dayTypeOptions}
      drAdrAuto={drAdrAuto}
    />
  )
}
