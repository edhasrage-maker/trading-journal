import type Anthropic from '@anthropic-ai/sdk'
import { symbolRoot, chartSeriesRoot, symbolToMultiplier } from '@/lib/futures-symbols'
import { fetchByDayIds } from '@/lib/coach-context'

/**
 * A query tool for the chat coach.
 *
 * Until now the coach was handed a pre-baked text summary: aggregate blocks
 * plus the newest 150 trades. That works right up until the trader asks
 * something the summary did not anticipate — "how often do my ES trades reach
 * 3xATR", "when did I start trading MES", "win rate on range days in July" —
 * at which point the honest answer is "I do not have that granularity" and the
 * fix is another hand-written block. That is whack-a-mole: every new question
 * costs a code change.
 *
 * This lets the model ask its own question instead. It is deliberately NOT SQL:
 * a fixed set of filters and group-bys over the trader's own rows, run through
 * their RLS-scoped client, so it cannot reach another account, cannot mutate
 * anything, and cannot be talked into an unbounded scan.
 *
 * Metric availability differs by source and the result says so per group:
 * imported (Tradezella) history carries P&L and tags but no stop and no
 * in-trade extremes, so R, MFE and capture come from natively logged trades
 * only. A blended average would quietly understate both.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const GROUP_BYS = [
  'none', 'month', 'weekday', 'instrument', 'setup', 'mistake', 'emotion', 'day_type', 'direction',
] as const
type GroupBy = (typeof GROUP_BYS)[number]

export interface CoachQueryInput {
  start_date?: string
  end_date?: string
  instrument?: string
  direction?: 'long' | 'short'
  setups?: string[]
  mistakes?: string[]
  emotions?: string[]
  day_types?: string[]
  group_by?: GroupBy
  /** Groups smaller than this fold into an "(other)" row, so a one-trade
   *  bucket can never be quoted back as a pattern. */
  min_group_n?: number
}

export const COACH_QUERY_TOOL: Anthropic.Tool = {
  name: 'query_trades',
  description:
    "Run an aggregation over THIS trader's own trade history and get exact numbers back. " +
    'Use it whenever the summary already in your context does not contain the specific cut ' +
    'being asked about — one instrument, a date range, a tag, a day type, or any combination — ' +
    'instead of replying that you lack the granularity. Filters combine with AND; a list ' +
    'inside a single filter matches ANY of its values. Returns per group: trade count, win ' +
    'rate, net P&L, average R, mean MFE in ATR units, the share of trades reaching 2x and 3x ' +
    'ATR, average profit captured, and first/last trade date. R, MFE and capture come from ' +
    'natively logged trades only (imported history has no stop or in-trade extremes); each ' +
    'group reports how many rows backed them, so cite the n when quoting those.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Inclusive PT session date, YYYY-MM-DD. Defaults to all history.' },
      end_date: { type: 'string', description: 'Inclusive PT session date, YYYY-MM-DD. Defaults to today.' },
      instrument: { type: 'string', description: 'Instrument, e.g. ES or NQ. Micros count as their mini, so ES includes MES fills.' },
      direction: { type: 'string', enum: ['long', 'short'] },
      setups: { type: 'array', items: { type: 'string' }, description: 'Trades carrying ANY of these setup tags.' },
      mistakes: { type: 'array', items: { type: 'string' }, description: 'Trades carrying ANY of these mistake tags.' },
      emotions: { type: 'array', items: { type: 'string' }, description: 'Trades carrying ANY of these emotion tags.' },
      day_types: { type: 'array', items: { type: 'string' }, description: 'Trades on days carrying ANY of these day types.' },
      group_by: { type: 'string', enum: GROUP_BYS as unknown as string[], description: 'How to break the result down. Default none (one total row).' },
      min_group_n: { type: 'number', description: 'Fold groups under this size into (other). Default 3.' },
    },
    required: [],
  },
}

interface Row {
  date: string
  pnl: number
  won: boolean
  symbol: string | null
  direction: string | null
  setups: string[]
  mistakes: string[]
  emotions: string[]
  dayTypes: string[]
  /** Native-only metrics; null on imported rows. */
  r: number | null
  mfeAtr: number | null
  capture: number | null
}

function tagList(tags: unknown, key: string): string[] {
  const t = tags as Record<string, unknown> | null
  const v = t ? t[key] : undefined
  if (Array.isArray(v)) return v.map(String).map(x => x.trim()).filter(Boolean)
  return typeof v === 'string' && v.trim() ? [v.trim()] : []
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Load the window once, in the shape the aggregation needs. */
async function loadRows(sb: AnyClient, start: string, end: string): Promise<Row[]> {
  const rows: Row[] = []

  const { data: days } = await sb
    .from('trading_days')
    .select('id, date, day_types')
    .gte('date', start)
    .lte('date', end)
  const dayById = new Map<string, { date: string; dayTypes: string[] }>(
    ((days ?? []) as Array<{ id: string; date: string; day_types: string[] | null }>).map(d => [
      d.id,
      { date: d.date, dayTypes: Array.isArray(d.day_types) ? d.day_types : [] },
    ]),
  )

  // Chunked — a bare .in() with the whole id list dies on a wide window.
  // See fetchByDayIds for the full story.
  const { rows: native } = await fetchByDayIds(
    sb,
    'trades',
    'id, trading_day_id, pnl, entry_price, stop_price, quantity, direction, symbol, tags_json, high_during_position, low_during_position, entry_atr_1m',
    Array.from(dayById.keys()),
    { paginate: true },
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of native as any[]) {
    const day = dayById.get(t.trading_day_id)
    if (!day || t.pnl == null) continue
    const riskPts = t.entry_price != null && t.stop_price != null ? Math.abs(t.entry_price - t.stop_price) : null
    const mult = symbolToMultiplier(t.symbol ?? '')
    const riskUsd = riskPts != null && t.quantity ? riskPts * t.quantity * mult : null

    let mfe: number | null = null
    if (t.entry_price != null && t.direction && t.high_during_position != null && t.low_during_position != null) {
      mfe = t.direction === 'long'
        ? Math.max(0, t.high_during_position - t.entry_price)
        : Math.max(0, t.entry_price - t.low_during_position)
    }
    const mfeUsd = mfe != null && t.quantity ? mfe * t.quantity * mult : null

    rows.push({
      date: day.date,
      pnl: t.pnl,
      won: t.pnl > 0,
      symbol: t.symbol ?? null,
      direction: t.direction ?? null,
      setups: tagList(t.tags_json, 'setups'),
      mistakes: tagList(t.tags_json, 'mistakes'),
      emotions: tagList(t.tags_json, 'emotions'),
      dayTypes: day.dayTypes,
      r: riskUsd && riskUsd > 0 ? t.pnl / riskUsd : null,
      mfeAtr: mfe != null && t.entry_atr_1m ? mfe / t.entry_atr_1m : null,
      // Floor at 0 and cap at 1: a give-back reads as 0% kept, never negative.
      capture: mfeUsd && mfeUsd > 0 ? Math.max(0, Math.min(1, t.pnl / mfeUsd)) : null,
    })
  }

  // Imported history — counts, P&L and tags only.
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb
      .from('historical_trades')
      .select('net_pnl, symbol, side, tags_json, trade_date')
      .gte('trade_date', start)
      .lte('trade_date', end)
      .order('id', { ascending: true })
      .range(p * 1000, p * 1000 + 999)
    if (error || !data || data.length === 0) break
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const h of data as any[]) {
      if (h.net_pnl == null) continue
      rows.push({
        date: h.trade_date,
        pnl: h.net_pnl,
        won: h.net_pnl > 0,
        symbol: h.symbol ?? null,
        direction: typeof h.side === 'string' ? h.side.toLowerCase() : null,
        setups: tagList(h.tags_json, 'setups'),
        mistakes: tagList(h.tags_json, 'mistakes'),
        emotions: tagList(h.tags_json, 'emotions'),
        dayTypes: [],
        r: null, mfeAtr: null, capture: null,
      })
    }
    if (data.length < 1000) break
  }

  return rows
}

/** Which group(s) a row belongs to. Tag group-bys can return several — a trade
 *  with two setups counts under both, matching how the rest of the app reports
 *  tag performance. */
function groupsFor(r: Row, by: GroupBy): string[] {
  switch (by) {
    case 'none': return ['all']
    case 'month': return [r.date.slice(0, 7)]
    case 'weekday': return [WEEKDAYS[new Date(r.date + 'T12:00:00Z').getUTCDay()]]
    case 'instrument': return r.symbol ? [symbolRoot(r.symbol)] : ['(no symbol)']
    case 'direction': return [r.direction ?? '(unknown)']
    case 'setup': return r.setups.length ? r.setups : ['(untagged)']
    case 'mistake': return r.mistakes.length ? r.mistakes : ['(no mistake tagged)']
    case 'emotion': return r.emotions.length ? r.emotions : ['(untagged)']
    case 'day_type': return r.dayTypes.length ? r.dayTypes : ['(untagged)']
  }
}

function summarize(label: string, rows: Row[]) {
  const rs = rows.map(r => r.r).filter((x): x is number => x != null)
  const atrs = rows.map(r => r.mfeAtr).filter((x): x is number => x != null)
  const caps = rows.map(r => r.capture).filter((x): x is number => x != null)
  const dates = rows.map(r => r.date).filter(Boolean).sort()
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  return {
    group: label,
    trades: rows.length,
    win_rate_pct: Math.round((rows.filter(r => r.won).length / rows.length) * 100),
    net_pnl: Math.round(rows.reduce((a, r) => a + r.pnl, 0)),
    avg_r: rs.length ? Number(avg(rs).toFixed(2)) : null,
    avg_r_from_n: rs.length,
    mean_mfe_atr: atrs.length ? Number(avg(atrs).toFixed(2)) : null,
    reached_2x_atr_pct: atrs.length ? Math.round((atrs.filter(x => x >= 2).length / atrs.length) * 100) : null,
    reached_3x_atr_pct: atrs.length ? Math.round((atrs.filter(x => x >= 3).length / atrs.length) * 100) : null,
    mfe_from_n: atrs.length,
    avg_captured_pct: caps.length ? Math.round(avg(caps) * 100) : null,
    first_trade: dates[0] ?? null,
    last_trade: dates[dates.length - 1] ?? null,
  }
}

export async function runCoachQuery(sb: AnyClient, input: CoachQueryInput): Promise<string> {
  const start = input.start_date || '2000-01-01'
  const end = input.end_date || new Date().toISOString().slice(0, 10)
  const by: GroupBy = GROUP_BYS.includes(input.group_by as GroupBy) ? (input.group_by as GroupBy) : 'none'
  const minN = Math.max(1, input.min_group_n ?? 3)

  const all = await loadRows(sb, start, end)

  const anyOf = (have: string[], want?: string[]) =>
    !want || want.length === 0 || want.some(w => have.some(h => h.toLowerCase() === w.toLowerCase()))

  // Match on the mini series, not the literal root: a trader asking about "ES"
  // means their MES fills too, and chartSeriesRoot already collapses the micro
  // onto its mini. Groups still LABEL by the real root, so MES stays MES.
  const family = input.instrument ? chartSeriesRoot(input.instrument).toUpperCase() : null
  const filtered = all.filter(r => {
    if (family && (!r.symbol || chartSeriesRoot(r.symbol).toUpperCase() !== family)) return false
    if (input.direction && r.direction !== input.direction) return false
    if (!anyOf(r.setups, input.setups)) return false
    if (!anyOf(r.mistakes, input.mistakes)) return false
    if (!anyOf(r.emotions, input.emotions)) return false
    if (!anyOf(r.dayTypes, input.day_types)) return false
    return true
  })

  if (filtered.length === 0) {
    return JSON.stringify({
      window: { start, end },
      filters_applied: input,
      trades_matched: 0,
      note: 'No trades matched. Say so plainly rather than answering from the summary context.',
    })
  }

  const groups = new Map<string, Row[]>()
  for (const r of filtered) {
    for (const g of groupsFor(r, by)) {
      const arr = groups.get(g) ?? []
      arr.push(r)
      groups.set(g, arr)
    }
  }

  const kept: Array<ReturnType<typeof summarize>> = []
  const folded: Row[] = []
  for (const [label, rows] of groups) {
    if (by !== 'none' && rows.length < minN) folded.push(...rows)
    else kept.push(summarize(label, rows))
  }
  kept.sort((a, b) => (by === 'month' ? b.group.localeCompare(a.group) : b.trades - a.trades))
  if (folded.length > 0) kept.push(summarize('(other, groups under ' + minN + ' trades)', folded))

  return JSON.stringify({
    window: { start, end },
    filters_applied: input,
    group_by: by,
    trades_matched: filtered.length,
    metric_notes:
      'avg_r, mean_mfe_atr, reached_2x/3x_atr_pct and avg_captured_pct come from natively logged trades only ' +
      '(imported history has no stop or in-trade extremes). The *_from_n fields say how many rows backed them, ' +
      'so cite the n when quoting those numbers.',
    groups: kept,
  })
}
