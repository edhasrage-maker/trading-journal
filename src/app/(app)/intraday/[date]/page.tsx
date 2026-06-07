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

  // Use `*` instead of an explicit select that names `day_types` — the
  // 2026-06-03 day-types-array migration may not have been run yet, and a
  // named-column select would error the entire query out (and the page would
  // render empty even though the trading_day + trades exist). `*` returns
  // whatever columns exist; missing day_types just comes through as undefined.
  const { data: day } = await supabase.from('trading_days').select('*').eq('date', date).single()

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
        initialSessionNotes={(day?.eod_notes as string | null) ?? ''}
        prepDayTypes={
          // Multi-select array if available, else legacy single primary as a
          // one-element array. Either form seeds the new trade's day_type tag.
          (day?.day_types as string[] | null)?.filter(Boolean).length
            ? (day!.day_types as string[])
            : day?.day_type
              ? [day.day_type as string]
              : []
        }
      />
    </div>
  )
}
