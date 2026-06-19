import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { Trade, TradingDay, MarketContext, TradeTags, EodAiAnalysis } from '@/lib/supabase/types'

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

/** MFE / MAE in points, direction-aware. Long: MFE = high-entry, MAE = entry-low. */
function mfeMaePts(t: Pick<Trade, 'entry_price' | 'direction' | 'high_during_position' | 'low_during_position'>): { mfe: string; mae: string } {
  if (t.entry_price == null || t.direction == null || t.high_during_position == null || t.low_during_position == null) {
    return { mfe: '', mae: '' }
  }
  const isLong = t.direction === 'long'
  const mfe = isLong ? t.high_during_position - t.entry_price : t.entry_price - t.low_during_position
  const mae = isLong ? t.entry_price - t.low_during_position : t.high_during_position - t.entry_price
  return { mfe: mfe.toFixed(2), mae: mae.toFixed(2) }
}

const TRADE_HEADERS = [
  'date', 'entry_time', 'exit_time', 'symbol', 'direction', 'quantity',
  'entry_price', 'stop_price', 'tp1_price', 'exit_price', 'pnl', 'r_multiple',
  // Excursion + scaling-aware capture (added 2026-06-17)
  'mfe_pts', 'mae_pts', 'mfe_dollars_per_leg',
  // Entry-moment context (added 2026-06-17)
  'entry_atr_1m', 'entry_rvol',
  // Auto-detected 5m structure alignment (added 2026-06-17)
  'structure_5m_alignment',
  'setups', 'confluences', 'order_flow', 'trade_management', 'mistakes', 'emotions', 'trade_day_type',
  'day_day_type', 'rvol', 'ib_size', 'ib_vs_10d_avg', 'adr', 'atr_1m',
  // Per-day EOD AI scores joined in (scalar only — full breakdown in the days export)
  'day_process_verdict', 'day_process_pass_count', 'day_execution_composite',
  'sierra_trade_id', 'screenshot_url', 'notes',
]

const DAY_HEADERS = [
  'date', 'day_types', 'eod_pnl',
  'process_verdict', 'process_pass_count',
  'P1', 'P2', 'P3', 'P4', 'P5',
  'execution_composite', 'exec_parameters', 'mfe_capture', 'prep_adherence', 'mae_heat', 'profit_factor',
  'process_headline', 'execution_headline',
  'rvol', 'ib_size', 'adr', 'atr_1m',
]

/** Count P1-P5 passes in an EOD analysis. */
function passCount(eod: EodAiAnalysis | null | undefined): string {
  const per = eod?.process?.per_rule
  if (!per) return ''
  const ids = ['P1', 'P2', 'P3', 'P4', 'P5'] as const
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return String(ids.filter(id => (per as any)[id]?.status === 'pass').length)
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const fromParam = url.searchParams.get('from')
  const toParam = url.searchParams.get('to')
  const type = url.searchParams.get('type') === 'days' ? 'days' : 'trades'

  const supabase: AnyClient = await createClient()

  // ── DAY SUMMARY EXPORT ───────────────────────────────────────────────────
  if (type === 'days') {
    const [{ data: daysRaw }, { data: ctxRaw }] = await Promise.all([
      supabase
        .from('trading_days')
        .select('id, date, day_types, day_type, eod_pnl, eod_ai_analysis_json')
        .order('date', { ascending: true }) as Promise<{ data: Array<Pick<TradingDay, 'id' | 'date' | 'day_types' | 'day_type' | 'eod_pnl'> & { eod_ai_analysis_json: EodAiAnalysis | null }> | null }>,
      supabase
        .from('market_context')
        .select('trading_day_id, rvol, ib_size, adr, atr_1m') as Promise<{ data: Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'adr' | 'atr_1m'>[] | null }>,
    ])
    const ctxByDay = new Map((ctxRaw ?? []).map(c => [c.trading_day_id, c]))
    const lines: string[] = [DAY_HEADERS.join(',')]
    for (const d of daysRaw ?? []) {
      if (fromParam && d.date < fromParam) continue
      if (toParam && d.date > toParam) continue
      const eod = d.eod_ai_analysis_json
      const per = eod?.process?.per_rule
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ruleStatus = (id: string) => (per as any)?.[id]?.status ?? ''
      const ex = eod?.execution
      const ctx = ctxByDay.get(d.id)
      const dayTypes = (d.day_types && d.day_types.length > 0) ? d.day_types.join('; ') : (d.day_type ?? '')
      const row = [
        d.date, dayTypes, d.eod_pnl ?? '',
        eod?.process?.verdict ?? '', passCount(eod),
        ruleStatus('P1'), ruleStatus('P2'), ruleStatus('P3'), ruleStatus('P4'), ruleStatus('P5'),
        ex?.composite != null ? ex.composite.toFixed(3) : '',
        ex?.execution_parameters != null ? ex.execution_parameters.toFixed(3) : '',
        ex?.mfe_capture != null ? ex.mfe_capture.toFixed(3) : '',
        ex?.prep_adherence != null ? ex.prep_adherence.toFixed(3) : '',
        ex?.mae_heat != null ? ex.mae_heat.toFixed(3) : '',
        ex?.profit_factor != null ? ex.profit_factor.toFixed(3) : '',
        eod?.process?.headline ?? '',
        ex?.headline ?? '',
        ctx?.rvol ?? '', ctx?.ib_size ?? '', ctx?.adr ?? '', ctx?.atr_1m ?? '',
      ].map(csvCell).join(',')
      lines.push(row)
    }
    const csv = lines.join('\r\n') + '\r\n'
    const today = new Date().toISOString().slice(0, 10)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="day-summary-${today}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // ── PER-TRADE EXPORT (default) ───────────────────────────────────────────
  const [{ data: tradesRaw }, { data: daysRaw }, { data: ctxRaw }] = await Promise.all([
    supabase
      .from('trades')
      .select('*')
      .order('entry_time', { ascending: true }) as Promise<{ data: Trade[] | null }>,
    supabase
      .from('trading_days')
      .select('id, date, day_type, eod_ai_analysis_json') as Promise<{ data: Array<Pick<TradingDay, 'id' | 'date' | 'day_type'> & { eod_ai_analysis_json: EodAiAnalysis | null }> | null }>,
    supabase
      .from('market_context')
      .select('trading_day_id, symbol, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m') as Promise<{ data: Pick<MarketContext, 'trading_day_id' | 'symbol' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>[] | null }>,
  ])

  const trades = tradesRaw ?? []
  const dayById = new Map((daysRaw ?? []).map(d => [d.id, d]))
  const ctxByDay = new Map((ctxRaw ?? []).map(c => [c.trading_day_id, c]))

  const lines: string[] = [TRADE_HEADERS.join(',')]

  for (const t of trades) {
    const day = dayById.get(t.trading_day_id)
    if (!day) continue
    if (fromParam && day.date < fromParam) continue
    if (toParam && day.date > toParam) continue

    const ctx = ctxByDay.get(t.trading_day_id)
    const tags = (t.tags_json ?? {}) as TradeTags
    const joinTags = (arr: string[] | undefined) => (arr ?? []).join('; ')
    const { mfe, mae } = mfeMaePts(t)
    const eod = day.eod_ai_analysis_json
    const tx = t as Trade & { mfe_dollars_per_leg?: number | null; entry_atr_1m?: number | null; entry_rvol?: number | null; structure_5m_alignment?: string | null }

    const row = [
      day.date,
      t.entry_time ?? '',
      t.exit_time ?? '',
      ctx?.symbol ?? t.symbol ?? '',
      t.direction ?? '',
      t.quantity ?? '',
      t.entry_price ?? '',
      t.stop_price ?? '',
      t.tp1_price ?? '',
      t.exit_price ?? '',
      t.pnl ?? '',
      rMultiple(t),
      mfe,
      mae,
      tx.mfe_dollars_per_leg ?? '',
      tx.entry_atr_1m ?? '',
      tx.entry_rvol ?? '',
      tx.structure_5m_alignment ?? '',
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
      eod?.process?.verdict ?? '',
      passCount(eod),
      eod?.execution?.composite != null ? eod.execution.composite.toFixed(3) : '',
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
