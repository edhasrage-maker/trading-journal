/**
 * Store each imported trade's stop orders in trades.review_json.stops, read-merge
 * (the other review parts are left exactly as they are). Used by both Sierra
 * importers after their upsert, so a day re-imported with orders included gets
 * stop history on the trades it already had. Server-only (needs a Supabase client).
 */
import { makeTradeStops, sameStopHistory } from '@/lib/sc-stops'
import type { TradeStopOrder, TradeStops } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

interface Row {
  id: string
  sierra_trade_id: string
  entry_time: string | null
  entry_price: number | null
  direction: string | null
  symbol: string | null
  review_json: Record<string, unknown> | null
}

const CHUNK = 100

/**
 * Write the stop history for the trades with these Sierra ids (RLS scopes the
 * lookup to the signed-in trader). A trade whose stored history already says
 * the same is left alone, so a re-import doesn't touch the row. Returns how many
 * trades were written.
 */
export async function writeTradeStops(db: AnyClient, items: ReadonlyMap<string, TradeStopOrder[]>): Promise<number> {
  const sids = [...items.keys()].filter(Boolean)
  let written = 0
  for (let i = 0; i < sids.length; i += CHUNK) {
    const chunk = sids.slice(i, i + CHUNK)
    const { data, error } = await db.from('trades')
      .select('id, sierra_trade_id, entry_time, entry_price, direction, symbol, review_json')
      .in('sierra_trade_id', chunk)
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as Row[]) {
      const orders = items.get(r.sierra_trade_id)
      if (!orders) continue
      const prev = (r.review_json?.stops ?? null) as TradeStops | null
      const next = makeTradeStops(orders, r)
      if (sameStopHistory(prev, next)) continue
      // read-merge on the row as it is NOW, so a review part written meanwhile survives
      const { data: fresh, error: re } = await db.from('trades').select('review_json').eq('id', r.id).maybeSingle()
      if (re || !fresh) continue
      const { error: ue } = await db.from('trades').update({ review_json: { ...(fresh.review_json ?? {}), stops: next } }).eq('id', r.id)
      if (ue) throw new Error(ue.message)
      written++
    }
  }
  return written
}
