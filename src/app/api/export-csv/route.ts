import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { normalizeTagArray, type Trade, type TradingDay, type MarketContext, type TradeTags, type EodAiAnalysis } from '@/lib/supabase/types'
import { rMultiple as rMultipleNum } from '@/lib/analytics'
import { anchorExcursionToFills } from '@/lib/excursion-guard'
import { resolveTagCategories } from '@/lib/tag-categories'
import { todayPT } from '@/lib/pt-time'
import { categoryKeysInUse, readCategoryPrefs } from '@/lib/tag-categories-server'

/**
 * Drop a copy of every export into the project's exports/ folder. The dev
 * server runs locally (see CLAUDE.md), so this writes straight to D: alongside
 * the streamed download. The filename carries the date range so different
 * ranges don't clobber each other. Best-effort — a disk error must never break
 * the download the user actually clicked for.
 */
function saveLocalCopy(kind: 'trades' | 'day-summary', from: string | null, to: string | null, csv: string): void {
  try {
    const range = `${from ?? 'all'}_to_${to ?? 'all'}`
    const dir = join(process.cwd(), 'exports')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${kind}_${range}.csv`), csv, 'utf8')
  } catch { /* non-fatal: the HTTP download still streams */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Escape a value for CSV: wrap in quotes if it contains comma/quote/newline; escape internal quotes. */
function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

// Delegate to the canonical rMultiple so the CSV R column is unit-correct
// (includes the contract multiplier). The previous local copy omitted it,
// inflating R by the multiplier — same bug that showed 8.15R for a 4.1R MNQ
// trade in the analytics drilldown.
function rMultiple(t: Trade): string {
  const r = rMultipleNum(t)
  return r == null ? '' : r.toFixed(3)
}

/** MFE / MAE in points, direction-aware. Long: MFE = high-entry, MAE = entry-low.
 *  Anchored to the trade's own fills first, exactly as the app measures them,
 *  so a CSV row and the screen never disagree about the same trade. */
function mfeMaePts(
  t: Pick<Trade, 'entry_price' | 'direction' | 'high_during_position' | 'low_during_position'> & { exit_price?: number | null },
): { mfe: string; mae: string } {
  if (t.entry_price == null || t.direction == null || t.high_during_position == null || t.low_during_position == null) {
    return { mfe: '', mae: '' }
  }
  const { high, low } = anchorExcursionToFills(
    t.high_during_position, t.low_during_position, t.entry_price, t.exit_price,
  )
  const isLong = t.direction === 'long'
  const mfe = Math.max(0, isLong ? high - t.entry_price : t.entry_price - low)
  const mae = Math.max(0, isLong ? t.entry_price - low : high - t.entry_price)
  return { mfe: mfe.toFixed(2), mae: mae.toFixed(2) }
}

/**
 * One imported (Tradezella) trade, as stored. A different table with a
 * different shape: `trade_date`/`open_at` rather than entry_time, `side` rather
 * than direction, `net_pnl` rather than pnl — and no stop, target, notes or
 * screenshot, because the broker export it came from never carried them.
 */
interface HistoricalTradeRow {
  id: string
  trade_date: string | null
  open_at: string | null
  close_at: string | null
  symbol: string | null
  side: string | null
  quantity: number | null
  entry_price: number | null
  exit_price: number | null
  net_pnl: number | null
  realized_rr: number | null
  price_mfe: number | null
  price_mae: number | null
  high_during_position: number | null
  low_during_position: number | null
  mfe_dollars_per_leg: number | null
  entry_atr_1m: number | null
  entry_rvol: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
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
  // 'native' (logged here) or 'imported' (came from a broker/Tradezella
  // export). Imported rows have no stop, target, notes or screenshot — the
  // source never carried them — so blanks in those columns are absence of
  // data, not absence of a stop.
  'source',
]

const DAY_HEADERS = [
  'date', 'day_types', 'eod_pnl',
  'process_verdict', 'process_pass_count',
  'P1', 'P2', 'P3', 'P4', 'P5',
  'execution_composite', 'exec_parameters', 'mfe_capture', 'prep_adherence', 'mae_heat', 'profit_factor',
  'process_headline', 'execution_headline',
  'rvol', 'ib_size', 'adr', 'atr_1m',
]

/**
 * Fetch every row from a table, paging past Supabase's 1000-row cap.
 * Without this an export of `trades` (5k+ rows) silently returned only the
 * oldest 1000 — so any recent date range came back empty.
 */
async function fetchAll(
  supabase: AnyClient,
  table: string,
  select: string,
  orderCols: string[],
): Promise<any[]> {  // eslint-disable-line @typescript-eslint/no-explicit-any
  const PAGE = 1000
  const all: unknown[] = []
  for (let p = 0; ; p++) {
    let q = supabase.from(table).select(select)
    for (const c of orderCols) q = q.order(c, { ascending: true })
    const { data, error } = await q.range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw error
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

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
    const [daysRaw, ctxRaw] = await Promise.all([
      fetchAll(supabase, 'trading_days', 'id, date, day_types, day_type, eod_pnl, eod_ai_analysis_json', ['date', 'id']) as Promise<Array<Pick<TradingDay, 'id' | 'date' | 'day_types' | 'day_type' | 'eod_pnl'> & { eod_ai_analysis_json: EodAiAnalysis | null }>>,
      fetchAll(supabase, 'market_context', 'trading_day_id, rvol, ib_size, adr, atr_1m', ['trading_day_id']) as Promise<Pick<MarketContext, 'trading_day_id' | 'rvol' | 'ib_size' | 'adr' | 'atr_1m'>[]>,
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
    // PT, not UTC. The host runs UTC, so toISOString() stamped tomorrow's date
    // on every export taken after 17:00 PT — a file named for a session the
    // trader hasn't traded yet.
    const today = todayPT()
    saveLocalCopy('day-summary', fromParam, toParam, csv)
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
  // `trades` is only what was logged HERE. Everything before the trader started
  // using the app lives in `historical_trades` (broker/Tradezella imports) — for
  // this book that is 915 rows against 229, so exporting `trades` alone silently
  // handed back a fifth of the history and called it the trade log.
  const [tradesRaw, histRaw, daysRaw, ctxRaw] = await Promise.all([
    fetchAll(supabase, 'trades', '*', ['entry_time', 'id']) as Promise<Trade[]>,
    fetchAll(
      supabase,
      'historical_trades',
      'id, trade_date, open_at, close_at, symbol, side, quantity, entry_price, exit_price, net_pnl, realized_rr, price_mfe, price_mae, high_during_position, low_during_position, mfe_dollars_per_leg, entry_atr_1m, entry_rvol, tags_json',
      ['trade_date', 'id'],
    ).catch(() => [] as HistoricalTradeRow[]) as Promise<HistoricalTradeRow[]>,
    fetchAll(supabase, 'trading_days', 'id, date, day_type, eod_ai_analysis_json', ['id']) as Promise<Array<Pick<TradingDay, 'id' | 'date' | 'day_type'> & { eod_ai_analysis_json: EodAiAnalysis | null }>>,
    fetchAll(supabase, 'market_context', 'trading_day_id, symbol, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m', ['trading_day_id']) as Promise<Pick<MarketContext, 'trading_day_id' | 'symbol' | 'rvol' | 'ib_size' | 'ib_vs_10d_avg' | 'adr' | 'atr_1m'>[]>,
  ])

  const trades = tradesRaw
  const dayById = new Map(daysRaw.map(d => [d.id, d]))
  const ctxByDay = new Map(ctxRaw.map(c => [c.trading_day_id, c]))
  // Imported trades carry a date but no trading_day_id, so the same day-level
  // context reaches them by date when the trader also prepped that session.
  const dayByDate = new Map(daysRaw.map(d => [d.date, d]))
  const ctxByDate = new Map(
    daysRaw.map(d => [d.date, ctxByDay.get(d.id)]).filter((e): e is [string, typeof ctxRaw[number]] => e[1] != null),
  )

  // Custom tag categories (Pt 16) become EXTRA COLUMNS AT THE END. Appending
  // rather than interleaving keeps the shipped column order byte-stable, so a
  // spreadsheet or script built against an older export still lines up.
  const extraCategories = resolveTagCategories(
    await readCategoryPrefs(supabase),
    await categoryKeysInUse(supabase),
  ).map(c => c.key).filter(k => !TRADE_HEADERS.includes(k))

  const lines: string[] = [[...TRADE_HEADERS, ...extraCategories].join(',')]
  // Native and imported rows are built separately and merged, so collect them
  // with a sort key rather than appending straight to `lines` — otherwise the
  // file would run through the recent history and then start again in 2025.
  const rows: Array<{ key: string; row: string }> = []

  for (const t of trades) {
    const day = dayById.get(t.trading_day_id)
    if (!day) continue
    if (fromParam && day.date < fromParam) continue
    if (toParam && day.date > toParam) continue

    const ctx = ctxByDay.get(t.trading_day_id)
    const tags = (t.tags_json ?? {}) as TradeTags
    // Normalise every tag field through normalizeTagArray: tags_json is loosely
    // typed JSON, and some categories (notably day_type) are stored as a single
    // string on legacy/auto-tagged rows. A raw `.join` on a string throws and
    // 500s the whole export — which is exactly how the GBX day_type tag broke it.
    const joinTags = (value: unknown) => normalizeTagArray(value).join('; ')
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
      'native',
      // Custom categories, in the same order as the appended headers.
      ...extraCategories.map(c => joinTags((tags as Record<string, unknown>)[c])),
    ].map(csvCell).join(',')

    rows.push({ key: `${day.date}T${t.entry_time ?? ''}`, row })
  }

  // ── Imported history ─────────────────────────────────────────────────────
  // Mapped onto the same columns, with genuinely-absent fields left blank
  // rather than reconstructed. Stop price is the notable one: analytics
  // back-solves it from realized_rr to keep Avg R comparable, but an export is
  // read as a record of what happened, and a synthesised stop in a column
  // labelled stop_price would be indistinguishable from one the trader set.
  // realized_rr itself IS recorded, so it goes straight to r_multiple.
  for (const h of histRaw) {
    const date = h.trade_date ?? (h.open_at ? h.open_at.slice(0, 10) : null)
    if (!date) continue
    if (fromParam && date < fromParam) continue
    if (toParam && date > toParam) continue

    const day = dayByDate.get(date)
    const ctx = ctxByDate.get(date)
    const tags = (h.tags_json ?? {}) as TradeTags
    const joinTags = (value: unknown) => normalizeTagArray(value).join('; ')
    const direction = h.side === 'long' || h.side === 'short' ? h.side : ''
    // Same excursion basis as a native row wherever the high/low were
    // backfilled; otherwise the importer's own point figures.
    const excursion = mfeMaePts({
      entry_price: h.entry_price,
      direction: direction === '' ? null : direction,
      high_during_position: h.high_during_position,
      low_during_position: h.low_during_position,
      exit_price: h.exit_price,
    })
    const mfe = excursion.mfe !== '' ? excursion.mfe : (h.price_mfe != null ? h.price_mfe.toFixed(2) : '')
    const mae = excursion.mae !== '' ? excursion.mae : (h.price_mae != null ? h.price_mae.toFixed(2) : '')
    const eod = day?.eod_ai_analysis_json

    const row = [
      date,
      h.open_at ?? '',
      h.close_at ?? '',
      h.symbol ?? '',
      direction,
      h.quantity ?? '',
      h.entry_price ?? '',
      '',                       // stop_price — never exported by the source
      '',                       // tp1_price — likewise
      h.exit_price ?? '',
      h.net_pnl ?? '',
      h.realized_rr != null ? h.realized_rr.toFixed(3) : '',
      mfe,
      mae,
      h.mfe_dollars_per_leg ?? '',
      h.entry_atr_1m ?? '',
      h.entry_rvol ?? '',
      '',                       // structure_5m_alignment — not computed for imports
      joinTags(tags.setups),
      joinTags(tags.confluences),
      joinTags(tags.order_flow),
      joinTags(tags.trade_management),
      joinTags(tags.mistakes),
      joinTags(tags.emotions),
      joinTags(tags.day_type),
      day?.day_type ?? '',
      ctx?.rvol ?? '',
      ctx?.ib_size ?? '',
      ctx?.ib_vs_10d_avg ?? '',
      ctx?.adr ?? '',
      ctx?.atr_1m ?? '',
      eod?.process?.verdict ?? '',
      passCount(eod),
      eod?.execution?.composite != null ? eod.execution.composite.toFixed(3) : '',
      '',                       // sierra_trade_id
      '',                       // screenshot_url
      '',                       // notes
      'imported',
      ...extraCategories.map(c => joinTags((tags as Record<string, unknown>)[c])),
    ].map(csvCell).join(',')

    rows.push({ key: `${date}T${h.open_at ?? ''}`, row })
  }

  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  for (const r of rows) lines.push(r.row)

  const csv = lines.join('\r\n') + '\r\n'
  // PT, not UTC — see the day-summary stamp above.
  const today = todayPT()
  const filename = `trades-${today}.csv`
  saveLocalCopy('trades', fromParam, toParam, csv)

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
