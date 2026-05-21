import { createClient } from '@/lib/supabase/server'
import EodClient from '@/components/eod/EodClient'
import type { TradingDay, Trade, TradeTag, MarketContext } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function EodPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()

  const { data: day } = await supabase
    .from('trading_days')
    .select('*')
    .eq('date', date)
    .maybeSingle() as { data: TradingDay | null }

  let trades: Trade[] = []
  let marketContext: MarketContext | null = null
  if (day) {
    const { data: tradesData } = await supabase
      .from('trades')
      .select('*')
      .eq('trading_day_id', day.id)
      .order('entry_time', { ascending: true }) as { data: Trade[] | null }
    trades = tradesData ?? []

    const { data: ctxData } = await supabase
      .from('market_context')
      .select('*')
      .eq('trading_day_id', day.id)
      .maybeSingle() as { data: MarketContext | null }
    marketContext = ctxData
  }

  const { data: tags } = await supabase
    .from('trade_tags')
    .select('*')
    .order('sort_order') as { data: TradeTag[] | null }

  return (
    <EodClient
      date={date}
      initialDay={day}
      initialTrades={trades}
      initialMarketContext={marketContext}
      allTags={tags ?? []}
    />
  )
}
