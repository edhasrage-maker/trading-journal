import { createClient } from '@/lib/supabase/server'
import PrepClient from '@/components/prep/PrepClient'
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

  return <PrepClient date={date} initialDay={day} initialContext={context} />
}
