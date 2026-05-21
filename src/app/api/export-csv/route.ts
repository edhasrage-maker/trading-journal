import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { Trade, TradingDay, MarketContext, TradeTags } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Escape a value for CSV: wrap in quotes if it contains comma/quote/newline; escape internal quotes. */
function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function rMultiple(t: Pick<Trade, 'entry_price' | 'stop_price' | 'pnl' | 'quantity'>): string {
  if (t.entry_price == null || t.stop_price == null || t.pnl == null || t.quantity == null) return ''
  const risk = Math.abs(t.entry_price - t.stop_price) * t.quantity
  if (risk === 0) return ''
  return (t.pnl / risk).toFixed(3)
}

const HEADERS = [
  'date', 'entry_time', 'exit_time', 'symbol', 'direction', 'quantity',
  'entry_price', 'stop_price', 'tp1_price', 'exit_price', 'pnl', 'r_multiple',
  'setups', 'confluences', 'order_flow', 'trade_management', 'mistakes', 'emotions', 'trade_day_type',
  'day_day_type', 'rvol', 'ib_size', 'ib_vs_10d_avg', 'adr', 'atr_1m',
  'sierra_trade_id', 'screenshot_url', 'notes',
]

export async function GET(req: Request) {
  const url = new URL(req.url)
  const fromParam = url.searchParams.get('from')
  const toParam = url.searchParams.get('to')

  const supabase: AnyClient = await createClient()

  // Optional date filter via joining on trading_days. Easier to fetch all then filter.
  const [{ data: tradesRaw }, { data: daysRaw }, { data: ctxRaw }] = await Promise.all([
    supabase
      .from('trades')
      .select('*')
      .order('entry_time', { ascending: true }) as Promise<{ data: Trade[] | null }>,
    supabase
      .from('trading_days')
      .select('id, date, day_type') as Promise<{ data: Pick<TradingDay, 'id' | 'date' | 'day_type'>[] | null }>,
    supabase
      .from('market_context')
      .select('trading_day_id, symbol, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m') as Promise<{ data: Pick<MarketContext, 'trading_day_id' | 'symbol' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>[] | null }>,
  ])

  const trades = tradesRaw ?? []
  const dayById = new Map((daysRaw ?? []).map(d => [d.id, d]))
  const ctxByDay = new Map((ctxRaw ?? []).map(c => [c.trading_day_id, c]))

  const lines: string[] = [HEADERS.join(',')]

  for (const t of trades) {
    const day = dayById.get(t.trading_day_id)
    if (!day) continue
    if (fromParam && day.date < fromParam) continue
    if (toParam && day.date > toParam) continue

    const ctx = ctxByDay.get(t.trading_day_id)
    const tags = (t.tags_json ?? {}) as TradeTags
    const joinTags = (arr: string[] | undefined) => (arr ?? []).join('; ')

    const row = [
      day.date,
      t.entry_time ?? '',
      t.exit_time ?? '',
      ctx?.symbol ?? '',
      t.direction ?? '',
      t.quantity ?? '',
      t.entry_price ?? '',
      t.stop_price ?? '',
      t.tp1_price ?? '',
      t.exit_price ?? '',
      t.pnl ?? '',
      rMultiple(t),
      joinTags(tags.setups),
      joinTags(tags.confluences),
      joinTags(tags.order_flow),
      joinTags(tags.trade_management),
      joinTags(tags.mistakes),
      joinTags(tags.emotions),
      joinTags(tags.day_type),
      day.day_type ?? '',
      ctx?.rvol ?? '',
      ctx?.ib_size ?? '',
      ctx?.ib_vs_10d_avg ?? '',
      ctx?.adr ?? '',
      ctx?.atr_1m ?? '',
      t.sierra_trade_id ?? '',
      t.screenshot_url ?? '',
      t.notes ?? '',
    ].map(csvCell).join(',')

    lines.push(row)
  }

  const csv = lines.join('\r\n') + '\r\n'
  const today = new Date().toISOString().slice(0, 10)
  const filename = `trades-${today}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
