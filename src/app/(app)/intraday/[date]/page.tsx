import { createClient } from '@/lib/supabase/server'
import IntradayClient from '@/components/intraday/IntradayClient'
import type { Trade, TradeTag } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function IntradayPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>
  searchParams: Promise<{ trade?: string }>
}) {
  const { date } = await params
  const { trade: openTradeId } = await searchParams
  const supabase: AnyClient = await createClient()

  const { data: day } = await supabase.from('trading_days').select('id').eq('date', date).single()

  let trades: Trade[] = []
  if (day) {
    const { data } = await supabase
      .from('trades').select('*').eq('trading_day_id', day.id).order('entry_time', { ascending: true })
    trades = (data ?? []) as Trade[]
  }

  const { data: tags } = await supabase.from('trade_tags').select('*').order('sort_order')

  return (
    <div className="max-w-4xl mx-auto">
      <IntradayClient
        date={date}
        initialTrades={trades}
        allTags={(tags ?? []) as TradeTag[]}
        initialOpenTradeId={openTradeId ?? null}
      />
    </div>
  )
}
