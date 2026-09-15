import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { clientError } from '@/lib/api-error'
import { computeDayStats, type DayForStats, type TradeForStats } from '@/lib/day-stats'
import { tagKey } from '@/lib/tradezella-import'
import type { TradingDay } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000
const CHUNK = 50

/**
 * GET /api/dashboard/filter?setup=Supply%20And%20Demand&setup=…&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Per-day rollups computed over ONLY the trades carrying one of the given
 * setups, inside [from, to]. Powers the dashboard Filter.
 *
 * Why this exists instead of filtering on the client: the dashboard reads each
 * day from its cached `stats_json` rollup and never loads trades in steady
 * state. That rollup is a whole-session number, so it cannot answer "how did my
 * Supply & Demand trades do" — a day with one S&D winner and five other losers
 * is a losing day. The old Recent Days setup dropdown made exactly that mistake:
 * it kept any day CONTAINING the setup and then showed the whole day's result.
 *
 * Rollups come from the same `computeDayStats` that fills the cache, so a
 * filtered number and an unfiltered one can't be computed two different ways.
 * Two inputs are deliberately withheld from it, because both are whole-session
 * facts that would leak into a per-setup answer:
 *   - `eod_pnl` (the manual day P&L override) is nulled, so P&L is the sum of the
 *     matching trades only;
 *   - achievements are dropped, since a day-level coin like "Career Day" says
 *     nothing about one setup's trades.
 * TapeScore is kept — it is labelled per-session wherever it appears.
 *
 * Session-scoped client, so RLS confines the read to the signed-in trader.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!isDate(from) || !isDate(to) || from > to) {
      return NextResponse.json({ error: 'from and to must be YYYY-MM-DD with from ≤ to.' }, { status: 400 })
    }
    const wanted = new Set(url.searchParams.getAll('setup').map(s => s.trim()).filter(Boolean).map(tagKey))
    if (wanted.size === 0) {
      return NextResponse.json({ error: 'Pick at least one setup to filter by.' }, { status: 400 })
    }

    const supabase: AnyClient = await createClient()

    // 1. Sessions in range.
    type DayRow = Pick<TradingDay, 'id' | 'date' | 'day_type' | 'ai_analysis_json' | 'eod_ai_analysis_json'> & { day_types: string[] | null }
    const days: DayRow[] = []
    for (let p = 0; p < 20; p++) {
      const { data, error } = await supabase
        .from('trading_days')
        .select('id, date, day_type, day_types, ai_analysis_json, eod_ai_analysis_json')
        .gte('date', from).lte('date', to)
        .order('date', { ascending: false }).order('id', { ascending: true })
        .range(p * PAGE, p * PAGE + PAGE - 1)
      if (error) throw new Error(`trading_days: ${error.message}`)
      days.push(...((data ?? []) as DayRow[]))
      if (!data || data.length < PAGE) break
    }
    if (days.length === 0) return NextResponse.json({ days: [], tradeCount: 0 })
    const dayIds = days.map(d => d.id)

    // 2. Their trades + prep ATR, chunked by day id.
    type TradeRow = TradeForStats & { trading_day_id: string }
    const trades: TradeRow[] = []
    const prepAtr = new Map<string, number | null>()
    for (let i = 0; i < dayIds.length; i += CHUNK) {
      const slice = dayIds.slice(i, i + CHUNK)
      for (let p = 0; p < 50; p++) {
        const { data, error } = await supabase
          .from('trades')
          .select('id, trading_day_id, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, exits_json, mfe_dollars_per_leg')
          .in('trading_day_id', slice)
          .order('id', { ascending: true })
          .range(p * PAGE, p * PAGE + PAGE - 1)
        if (error) throw new Error(`trades: ${error.message}`)
        trades.push(...((data ?? []) as TradeRow[]))
        if (!data || data.length < PAGE) break
      }
      // market_context is one row per (day, symbol) — take the first ATR seen.
      const { data: ctx } = await supabase
        .from('market_context').select('trading_day_id, atr_1m').in('trading_day_id', slice)
      for (const c of (ctx ?? []) as { trading_day_id: string; atr_1m: number | null }[]) {
        if (prepAtr.get(c.trading_day_id) == null) prepAtr.set(c.trading_day_id, c.atr_1m)
      }
    }

    // 3. Keep trades carrying ANY selected setup. tagKey folds case, spacing and
    //    "&" → "and", so "Supply & Demand" and "Supply And Demand" match.
    const matchedByDay = new Map<string, TradeRow[]>()
    let tradeCount = 0
    for (const t of trades) {
      const setups = (t.tags_json?.setups ?? []) as string[]
      if (!setups.some(s => wanted.has(tagKey(s)))) continue
      const arr = matchedByDay.get(t.trading_day_id) ?? []
      arr.push(t)
      matchedByDay.set(t.trading_day_id, arr)
      tradeCount++
    }

    // 4. Roll up each day that had a match.
    const rollups = days
      .filter(d => matchedByDay.has(d.id))
      .map(d => {
        const day: DayForStats = {
          id: d.id,
          date: d.date,
          eod_pnl: null,
          day_type: d.day_type,
          day_types: Array.isArray(d.day_types) ? d.day_types : null,
          ai_analysis_json: d.ai_analysis_json ?? null,
          eod_ai_analysis_json: d.eod_ai_analysis_json ?? null,
          achievements: [],
        }
        return computeDayStats(day, matchedByDay.get(d.id)!, prepAtr.get(d.id) ?? null)
      })

    return NextResponse.json({ days: rollups, tradeCount })
  } catch (e) {
    return NextResponse.json({ error: clientError(e as Error, 'Could not apply the filter.') }, { status: 500 })
  }
}
