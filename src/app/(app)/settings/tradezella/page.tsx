import { createClient } from '@/lib/supabase/server'
import TradezellaImportClient from '@/components/settings/TradezellaImportClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function TradezellaSettingsPage() {
  const supabase = await createClient()

  // Summary card data: total historical rows + the most recent trade date.
  // historical_trades.imported_at would be more accurate for "last import",
  // but trade_date is what the user thinks in terms of.
  const { count } = await supabase
    .from('historical_trades')
    .select('*', { count: 'exact', head: true })

  const { data: latest } = await supabase
    .from('historical_trades')
    .select('trade_date, imported_at')
    .order('imported_at', { ascending: false })
    .limit(1)

  const latestRow = (latest ?? [])[0] as { trade_date: string | null; imported_at: string | null } | undefined

  return (
    <TradezellaImportClient
      totalHistorical={count ?? 0}
      latestTradeDate={latestRow?.trade_date ?? null}
      latestImportedAt={latestRow?.imported_at ?? null}
    />
  )
}
