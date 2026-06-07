import type { SupabaseClient } from '@supabase/supabase-js'

export type NormalizedTrade = {
  source: 'trades' | 'historical_trades'
  id: string
  symbol: string | null
  entry_time: string
  direction: 'long' | 'short'
  entry_price: number
  pnl: number
}

const PAGE = 1000

export async function loadNativeTrades(
  sb: SupabaseClient, from: string, to: string,
): Promise<NormalizedTrade[]> {
  const out: NormalizedTrade[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from('trades')
      .select('id, symbol, entry_time, direction, entry_price, pnl')
      .gte('entry_time', `${from}T00:00:00Z`)
      .lt('entry_time', `${to}T23:59:59.999Z`)
      .not('entry_time', 'is', null)
      .not('pnl', 'is', null)
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw error
    for (const r of data ?? []) {
      if (!r.entry_time || !r.direction || r.entry_price == null) continue
      out.push({
        source: 'trades',
        id: r.id,
        symbol: r.symbol,
        entry_time: r.entry_time,
        direction: r.direction,
        entry_price: Number(r.entry_price),
        pnl: Number(r.pnl ?? 0),
      })
    }
    if (!data || data.length < PAGE) break
  }
  return out
}

export async function loadHistoricalTrades(
  sb: SupabaseClient, from: string, to: string,
): Promise<NormalizedTrade[]> {
  const out: NormalizedTrade[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from('historical_trades')
      .select('id, symbol, open_at, side, entry_price, net_pnl')
      .gte('open_at', `${from}T00:00:00Z`)
      .lt('open_at', `${to}T23:59:59.999Z`)
      .not('open_at', 'is', null)
      .order('open_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw error
    for (const r of data ?? []) {
      if (!r.open_at || !r.side || r.entry_price == null) continue
      out.push({
        source: 'historical_trades',
        id: r.id,
        symbol: r.symbol,
        entry_time: r.open_at,
        direction: r.side === 'long' ? 'long' : 'short',
        entry_price: Number(r.entry_price),
        pnl: Number(r.net_pnl ?? 0),
      })
    }
    if (!data || data.length < PAGE) break
  }
  return out
}

export type Bar = { ts: string; close: number }

// Bars for (symbol, dayUtcDate) plus 24h on either side so EMA warmup + slope lookback are covered.
export async function loadBarsForDay(
  sb: SupabaseClient, symbol: string, dayIsoDate: string,
): Promise<Bar[]> {
  const dayStart = new Date(`${dayIsoDate}T00:00:00Z`)
  const fromTs = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const toTs = new Date(dayStart.getTime() + 48 * 60 * 60 * 1000).toISOString()
  const out: Bar[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from('ohlcv_bars')
      .select('ts, close')
      .eq('symbol', symbol)
      .gte('ts', fromTs)
      .lt('ts', toTs)
      .order('ts', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw error
    for (const r of data ?? []) out.push({ ts: r.ts, close: Number(r.close) })
    if (!data || data.length < PAGE) break
  }
  return out
}
