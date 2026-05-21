import { createClient } from '@/lib/supabase/server'
import { format } from 'date-fns'
import IntradayClient from '@/components/intraday/IntradayClient'
import type { Trade, TradeTag } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function IntradayPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
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
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Intraday</h1>
        <p className="text-gray-400 text-sm mt-1">
          {format(new Date(date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')}
        </p>
      </div>
      <IntradayClient
        date={date}
        initialTrades={trades}
        allTags={(tags ?? []) as TradeTag[]}
      />
    </div>
  )
}
