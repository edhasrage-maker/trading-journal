import { createClient } from '@/lib/supabase/server'
import PrepClient from '@/components/prep/PrepClient'
import { computeDrAdr } from '@/lib/dr-adr'
import { computeAdr, computeAtr1m } from '@/lib/market-stats'
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

  // Auto-compute ADR + ATR-10 (1m) for the Market Context stats block. Only
  // surface them when the user hasn't already saved a value — never overwrite
  // a typed/extracted value with a computed one. RVOL is intentionally not
  // auto-computed here (convention question; see src/lib/market-stats.ts).
  const [adrResult, atrResult] = await Promise.all([
    context?.adr == null ? computeAdr(supabase, symbolForBars, date) : Promise.resolve({ adr: null, samples: 0 }),
    context?.atr_1m == null ? computeAtr1m(supabase, symbolForBars, date) : Promise.resolve({ atr_1m: null, full_warmup: false }),
  ])
  const autoStats = {
    adr: adrResult.adr != null ? Math.round(adrResult.adr * 100) / 100 : null,
    adr_samples: adrResult.samples,
    atr_1m: atrResult.atr_1m != null ? Math.round(atrResult.atr_1m * 100) / 100 : null,
    atr_1m_full_warmup: atrResult.full_warmup,
  }

  return (
    <PrepClient
      date={date}
      initialDay={day}
      initialContext={context}
      dayTypeOptions={dayTypeOptions}
      drAdrAuto={drAdrAuto}
      autoStats={autoStats}
    />
  )
}
