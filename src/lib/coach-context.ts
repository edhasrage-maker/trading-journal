/**
 * Shared trader-data context builder used by BOTH:
 *   - /api/coach (the chatbox) — full 180-day window with week-over-week
 *   - /api/analyze-week (the weekly recap synthesis) — single-week window
 *
 * Sharing this code is what guarantees the chatbox and the weekly recap
 * agree on patterns. They read the same trades, apply the same
 * aggregations, and produce numerically identical conclusions for any
 * overlapping window.
 *
 * Returns a compact, structured text block suitable for prompt injection.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export interface CoachContextOptions {
  /** ISO date YYYY-MM-DD. Window start (inclusive). */
  startDate: string
  /** ISO date YYYY-MM-DD. Window end (inclusive). */
  endDate: string
  /** Human-readable label for the window — printed in the context header.
   *  e.g. "last 180 days", "week of Jun 16", "this week". */
  windowLabel: string
  /** Include this-week vs prior-week comparison. Defaults to false. Only
   *  meaningful when the window spans at least 2 weeks. */
  includeWeekOverWeek?: boolean
  /** Max recent trades to include in the terse-format list. Defaults to 50. */
  recentTradesLimit?: number
}

const SYM_MULT: Record<string, number> = { NQ: 20, MNQ: 2, ES: 50, MES: 5 }
const mult = (s: string | null) => {
  if (!s) return 1
  const root = s.replace(/\.[A-Z]+$/, '').replace(/[HMUZ]\d+$/, '')
  return SYM_MULT[root] ?? 1
}
const fmt = (n: number) => (n >= 0 ? '+' : '') + '$' + Math.round(n).toLocaleString()
const sortByCount = <T extends { count: number }>(map: Map<string, T>, n = 10) =>
  Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, n)
const sortByPnl = <T extends { pnl: number }>(map: Map<string, T>, n = 10) =>
  Array.from(map.entries()).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, n)

interface TradeContextRow {
  id: string
  trading_day_id: string
  entry_time: string | null
  direction: 'long' | 'short' | null
  pnl: number | null
  entry_price: number | null
  stop_price: number | null
  quantity: number | null
  symbol: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
  structure_5m_alignment: string | null
}

export async function buildCoachContext(supabase: AnyClient, opts: CoachContextOptions): Promise<string> {
  const { startDate, endDate, windowLabel, includeWeekOverWeek = false, recentTradesLimit = 50 } = opts

  // Pull trading_days first so we have the day-type map for cross-tabulation.
  const { data: days } = await supabase
    .from('trading_days')
    .select('id, date, day_types, eod_pnl')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: false })
  const dayDateById = new Map<string, string>()
  const dayTypesById = new Map<string, string[]>()
  for (const d of (days ?? []) as Array<{ id: string; date: string; day_types: string[] | null }>) {
    dayDateById.set(d.id, d.date)
    dayTypesById.set(d.id, Array.isArray(d.day_types) ? d.day_types : [])
  }

  // Paginate trades within the window.
  const PAGE = 1000
  const trades: TradeContextRow[] = []
  const dayIds = Array.from(dayDateById.keys())
  if (dayIds.length === 0) {
    return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}).
NO TRADE DATA — no trading days in this window.
═══ END TRADER DATA ═══`
  }
  for (let p = 0; p < 10; p++) {
    const { data } = await supabase
      .from('trades')
      .select('id, trading_day_id, entry_time, direction, pnl, entry_price, stop_price, quantity, symbol, tags_json, structure_5m_alignment')
      .in('trading_day_id', dayIds)
      .order('entry_time', { ascending: false })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (!data || data.length === 0) break
    trades.push(...data)
    if (data.length < PAGE) break
  }

  // ── Aggregates ──
  const total = trades.length
  if (total === 0) {
    return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}).
NO TRADE DATA — the trader logged no trades in this window.
═══ END TRADER DATA ═══`
  }

  const winners = trades.filter(t => (t.pnl ?? 0) > 0).length
  const losers = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = (winners + losers) > 0 ? (winners / (winners + losers)) * 100 : 0
  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const sumW = trades.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0)
  const sumL = trades.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
  const profitFactor = sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0)

  const setupBuckets = new Map<string, { count: number; wins: number; losers: number; pnl: number; rs: number[] }>()
  const mistakeCounts = new Map<string, { count: number; pnl: number }>()
  const dayTypeBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const ofBuckets = new Map<string, { count: number; wins: number; pnl: number }>()
  const structureBuckets = new Map<string, { count: number; wins: number; pnl: number }>()

  for (const t of trades) {
    const pnl = t.pnl ?? 0
    const isWin = pnl > 0
    const stopDist = (t.entry_price != null && t.stop_price != null) ? Math.abs(t.entry_price - t.stop_price) : null
    const r = (stopDist && t.quantity) ? pnl / (stopDist * t.quantity * mult(t.symbol)) : null

    const setups = (t.tags_json?.setups as string[]) ?? []
    if (setups.length === 0) {
      const b = setupBuckets.get('Discretionary/No Setup') ?? { count: 0, wins: 0, losers: 0, pnl: 0, rs: [] }
      b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl; if (r != null) b.rs.push(r)
      setupBuckets.set('Discretionary/No Setup', b)
    } else for (const s of setups) {
      const b = setupBuckets.get(s) ?? { count: 0, wins: 0, losers: 0, pnl: 0, rs: [] }
      b.count++; if (isWin) b.wins++; if (pnl < 0) b.losers++; b.pnl += pnl; if (r != null) b.rs.push(r)
      setupBuckets.set(s, b)
    }

    const mistakes = (t.tags_json?.mistakes as string[]) ?? []
    for (const m of mistakes) {
      const b = mistakeCounts.get(m) ?? { count: 0, pnl: 0 }
      b.count++; b.pnl += pnl
      mistakeCounts.set(m, b)
    }

    const dayTypes = dayTypesById.get(t.trading_day_id) ?? []
    for (const dt of dayTypes) {
      const b = dayTypeBuckets.get(dt) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      dayTypeBuckets.set(dt, b)
    }

    const ofs = (t.tags_json?.order_flow as string[]) ?? []
    for (const o of ofs) {
      const b = ofBuckets.get(o) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      ofBuckets.set(o, b)
    }

    if (t.structure_5m_alignment) {
      const b = structureBuckets.get(t.structure_5m_alignment) ?? { count: 0, wins: 0, pnl: 0 }
      b.count++; if (isWin) b.wins++; b.pnl += pnl
      structureBuckets.set(t.structure_5m_alignment, b)
    }
  }

  // Recent trades (newest first, capped at recentTradesLimit)
  const recent = trades.slice(0, recentTradesLimit).map(t => {
    const date = dayDateById.get(t.trading_day_id) ?? '?'
    const dir = t.direction?.[0]?.toUpperCase() ?? '?'
    const setups = ((t.tags_json?.setups as string[]) ?? []).join(',') || '—'
    const mistakes = ((t.tags_json?.mistakes as string[]) ?? []).join(',') || '—'
    const stopDist = (t.entry_price != null && t.stop_price != null) ? Math.abs(t.entry_price - t.stop_price) : null
    const r = (stopDist && t.quantity && t.pnl != null) ? t.pnl / (stopDist * t.quantity * mult(t.symbol)) : null
    return `${date} ${dir}${t.quantity ?? '?'} pnl=${t.pnl?.toFixed(0) ?? '?'}${r != null ? ` R=${r.toFixed(2)}` : ''} setup=[${setups}]${mistakes !== '—' ? ' mistake=['+mistakes+']' : ''}${t.structure_5m_alignment ? ' 5m='+t.structure_5m_alignment : ''}`
  }).join('\n')

  // Optional week-over-week comparison — only meaningful for the chatbox's
  // 180-day window, not the weekly recap (which IS one week).
  let weekOverWeekBlock = ''
  if (includeWeekOverWeek) {
    const endMs = Date.parse(endDate + 'T23:59:59Z')
    const past7 = new Date(endMs - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const past14 = new Date(endMs - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const tradesThisWeek = trades.filter(t => (t.entry_time ?? '').slice(0, 10) >= past7)
    const tradesPriorWeek = trades.filter(t => {
      const d = (t.entry_time ?? '').slice(0, 10)
      return d >= past14 && d < past7
    })
    const wkPnl = (arr: TradeContextRow[]) => arr.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const wkWR = (arr: TradeContextRow[]) => {
      const w = arr.filter(t => (t.pnl ?? 0) > 0).length
      const l = arr.filter(t => (t.pnl ?? 0) < 0).length
      return (w + l) > 0 ? Math.round((w / (w + l)) * 100) : null
    }
    weekOverWeekBlock = `

THIS WEEK vs PRIOR WEEK:
  This week  (${past7} → ${endDate}): ${tradesThisWeek.length} trades · ${fmt(wkPnl(tradesThisWeek))} · WR ${wkWR(tradesThisWeek) ?? '—'}%
  Prior week (${past14} → ${past7}): ${tradesPriorWeek.length} trades · ${fmt(wkPnl(tradesPriorWeek))} · WR ${wkWR(tradesPriorWeek) ?? '—'}%`
  }

  return `═══ TRADER DATA SUMMARY ═══
Window: ${windowLabel} (${startDate} → ${endDate}). Total trades: ${total}.

OVERALL:
  Win rate: ${winRate.toFixed(0)}% (${winners}W / ${losers}L)
  Total PnL: ${fmt(totalPnl)}
  Profit factor: ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞'}${weekOverWeekBlock}

SETUP PERFORMANCE (by total PnL, top 10):
${sortByPnl(setupBuckets).map(([s, b]) => `  ${s}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / (b.wins + b.losers || 1)) * 100)}% · avgR ${b.rs.length > 0 ? (b.rs.reduce((s, r) => s + r, 0) / b.rs.length).toFixed(2) : '—'}`).join('\n')}

DAY TYPE PERFORMANCE (by total PnL, top 10):
${sortByPnl(dayTypeBuckets).map(([d, b]) => `  ${d}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no day_types tagged in window)'}

TOP MISTAKES (by frequency, top 10):
${sortByCount(mistakeCounts).map(([m, b]) => `  ${m}: ${b.count} occurrences · ${fmt(b.pnl)} total PnL impact`).join('\n') || '  (no mistakes tagged in window)'}

ORDER FLOW SIGNAL PERFORMANCE (by total PnL, top 10):
${sortByPnl(ofBuckets).map(([o, b]) => `  ${o}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no orderflow tags logged in window)'}

5M STRUCTURE ALIGNMENT:
${Array.from(structureBuckets.entries()).map(([k, b]) => `  ${k}: ${b.count} trades · ${fmt(b.pnl)} · WR ${Math.round((b.wins / b.count) * 100)}%`).join('\n') || '  (no structure_5m_alignment values yet — backfill pending)'}

RECENT TRADES (newest first, terse format, capped at ${recentTradesLimit}):
${recent}

═══ END TRADER DATA ═══`
}
