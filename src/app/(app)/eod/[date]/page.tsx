import { createClient } from '@/lib/supabase/server'
import EodClient from '@/components/eod/EodClient'
import { liveAtr, fetchAllBars, postExitExtension, type AtrBar, type PostExitData } from '@/lib/atr'
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

  // Per-trade LIVE ATR: compute ATR-10 Wilder from 1-min bars at each trade's
  // entry_time and pass to EodClient as a map { tradeId → atrPts }. The trade
  // list surfaces this as an "ATR @ entry" chip so the trader can see how
  // volatile the market actually was when each trade fired (the prep ATR is
  // a single morning snapshot, often stale by trade time).
  const liveAtrByTradeId: Record<string, number> = {}
  const postExitByTradeId: Record<string, PostExitData> = {}
  if (trades.length > 0) {
    const symbolDatePairs = new Set<string>()
    for (const t of trades) {
      if (t.symbol && t.entry_time) symbolDatePairs.add(`${t.symbol}|${date}`)
    }
    const barsBySymbolDate = new Map<string, AtrBar[]>()
    await Promise.all(
      Array.from(symbolDatePairs).map(async key => {
        const [symbol] = key.split('|')
        const bars = await fetchAllBars(supabase, symbol, date)
        barsBySymbolDate.set(key, bars)
      }),
    )
    for (const t of trades) {
      if (!t.symbol || !t.entry_time) continue
      const bars = barsBySymbolDate.get(`${t.symbol}|${date}`)
      if (!bars || bars.length === 0) continue
      const value = liveAtr(bars, new Date(t.entry_time), 10)
      if (value != null) liveAtrByTradeId[t.id] = value
    }

    // Post-Exit Continuation @ 30 min — uses the same bar set we fetched for
    // live ATR. For each trade with an exit, look at the 30 minutes after
    // exit_time and record max continuation in trade direction and max
    // reversal against it. Trade list displays "compared to what you took".
    for (const t of trades) {
      if (!t.symbol) continue
      const bars = barsBySymbolDate.get(`${t.symbol}|${date}`)
      if (!bars || bars.length === 0) continue
      const ext = postExitExtension(bars, {
        direction: t.direction,
        exit_price: t.exit_price,
        exit_time: t.exit_time,
      }, 30)
      if (ext != null) postExitByTradeId[t.id] = ext
    }
  }

  return (
    <EodClient
      date={date}
      initialDay={day}
      initialTrades={trades}
      initialMarketContext={marketContext}
      allTags={tags ?? []}
      liveAtrByTradeId={liveAtrByTradeId}
      postExitByTradeId={postExitByTradeId}
    />
  )
}
