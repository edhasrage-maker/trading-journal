/**
 * GET /api/studies/break-retest
 *
 * Classifies every "break and retest"-tagged trade as a TRUE break-and-retest,
 * a REJECTION off the level (never broke), or one of several look-alikes — by
 * replaying actual 1-min market data (ohlcv_bars) against the trade's entry.
 *
 * Query params (all optional):
 *   startDate     YYYY-MM-DD (default: earliest tagged trade)
 *   endDate       YYYY-MM-DD (default: today)
 *   symbol        e.g. NQM6.CME (default: each trade's own symbol)
 *   proximity     points; default 5
 *   breakBuffer   points; default 2
 *   retestProx    points; default 3
 *   emaTf         minutes; default 5 (for VWAP/EMA series — only VWAP is actually used)
 *
 * Response:
 *   { matchedTags: string[],
 *     missingBarDays: string[],
 *     classified: ClassifiedTrade[],
 *     summary: { [verdict]: { count, winRate, totalPnl, avgPnl } },
 *     config: BreakRetestConfig }
 */

import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { computeSessionLevels, DEFAULT_LEVELS_CONFIG, type RawBar } from '@/lib/session-levels'
import {
  classifyBreakRetest,
  DEFAULT_BR_CONFIG,
  type BreakRetestConfig,
  type ClassifierResult,
  type BreakRetestVerdict,
} from '@/lib/studies/break-retest-classifier'
import { tagKey } from '@/lib/tradezella-import'
import { normalizeTagArray, type Trade, type TradeTags } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

// Cast a wide net — any tag whose normalized key contains any of these substrings
// is considered "break/retest related". Surface the matched list in the response
// so the user can verify what's caught.
const TAG_MATCH_SUBSTRINGS = ['break', 'retest', 'bnr', 'breakout']

function isBreakRetestTag(label: string): boolean {
  const k = tagKey(label)
  return TAG_MATCH_SUBSTRINGS.some(s => k.includes(s))
}

function collectTradeTags(tags: TradeTags | null | undefined): string[] {
  if (!tags) return []
  const out: string[] = []
  const cats = ['setups', 'confluences', 'order_flow', 'entry_model', 'trade_management', 'day_type', 'mistakes', 'emotions'] as const
  for (const c of cats) {
    for (const v of normalizeTagArray((tags as Record<string, unknown>)[c])) out.push(v)
  }
  return out
}

const LOOKBACK_DAYS = 8  // matches /api/bars/levels; covers weekly anchor + prior day + ETH
const PAGE = 1000

export interface ClassifiedTrade {
  id: string
  date: string                    // YYYY-MM-DD (trade's day)
  entry_time: string | null
  entry_price: number | null
  direction: 'long' | 'short' | null
  symbol: string | null
  pnl: number | null
  matched_tag: string             // The first break/retest-ish tag found on this trade
  all_matched_tags: string[]
  result: ClassifierResult | null
  skip_reason?: string            // Set when we couldn't classify (no bars, missing price, etc.)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const startDateParam = searchParams.get('startDate')
  const endDateParam = searchParams.get('endDate')
  const symbolFilter = searchParams.get('symbol')

  const config: BreakRetestConfig = {
    proximityPoints: numParam(searchParams, 'proximity', DEFAULT_BR_CONFIG.proximityPoints),
    breakBufferPoints: numParam(searchParams, 'breakBuffer', DEFAULT_BR_CONFIG.breakBufferPoints),
    retestProximityPoints: numParam(searchParams, 'retestProx', DEFAULT_BR_CONFIG.retestProximityPoints),
  }
  const emaTf = numParam(searchParams, 'emaTf', 5)

  const supabase: AnyClient = await createClient()

  // 1. Discover all tag labels whose key includes break/retest/bnr/breakout.
  const { data: allTagsRaw, error: tagsErr } = await supabase
    .from('trade_tags')
    .select('label, category')
  if (tagsErr) {
    return NextResponse.json({ error: `Tag fetch failed: ${tagsErr.message}` }, { status: 500 })
  }
  const matchedTags = Array.from(new Set(
    (allTagsRaw ?? [])
      .map((r: { label: string }) => r.label)
      .filter((l: string) => isBreakRetestTag(l)),
  )).sort()

  // 2. Pull trading_days in the window so we can map trade.trading_day_id → date
  //    (matches the codebase's "fetch days separately + join in code" pattern).
  let daysQ = supabase.from('trading_days').select('id, date')
  if (startDateParam) daysQ = daysQ.gte('date', startDateParam)
  if (endDateParam) daysQ = daysQ.lte('date', endDateParam)
  const { data: daysRaw, error: daysErr } = await daysQ
  if (daysErr) {
    return NextResponse.json({ error: `Trading-days fetch failed: ${daysErr.message}` }, { status: 500 })
  }
  const days = (daysRaw ?? []) as { id: string; date: string }[]
  const dayIdToDate = new Map(days.map(d => [d.id, d.date]))
  const dayIds = days.map(d => d.id)
  if (dayIds.length === 0) {
    return NextResponse.json({ matchedTags, missingBarDays: [], classified: [], summary: emptySummary(), config })
  }

  // 3. Pull trades scoped to those days, paginated past Supabase's 1000-row cap.
  //    We can't filter tags server-side (jsonb across multiple categories), so
  //    fetch then filter in code.
  const trades: Trade[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from('trades')
      .select('id, entry_time, entry_price, direction, symbol, pnl, tags_json, trading_day_id')
      .in('trading_day_id', dayIds)
      .order('entry_time', { ascending: true })
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) {
      console.error('[studies/break-retest] trades page', p, 'failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const rows = (data ?? []) as Trade[]
    trades.push(...rows)
    if (rows.length < PAGE) break
  }

  // 4. Filter to break/retest-tagged trades only, attaching the date.
  const brTrades = trades
    .map(t => {
      const tags = collectTradeTags(t.tags_json)
      const matched = tags.filter(isBreakRetestTag)
      const date = dayIdToDate.get(t.trading_day_id) ?? ''
      return { trade: t, matched, date }
    })
    .filter(x => x.matched.length > 0 && x.date)

  if (brTrades.length === 0) {
    return NextResponse.json({
      matchedTags, missingBarDays: [], classified: [], summary: emptySummary(), config,
    })
  }

  // 5. Determine bar fetch range: 8 days before the earliest trade date through end of latest.
  const tradeDates = brTrades.map(x => x.date).sort()
  const earliest = tradeDates[0]
  const latest = tradeDates[tradeDates.length - 1]
  const earliestMs = Date.parse(`${earliest}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000
  const earliestIso = new Date(earliestMs).toISOString()
  const latestIso = `${latest}T23:59:59.999Z`

  // 6. Determine symbol(s) to fetch bars for. If the caller pinned one, use that.
  //    Otherwise pull each trade's symbol and fetch the union (typically 1 symbol).
  const symbols = symbolFilter
    ? [symbolFilter]
    : Array.from(new Set(brTrades.map(x => x.trade.symbol).filter((s): s is string => !!s)))
  if (symbols.length === 0) {
    return NextResponse.json({
      matchedTags,
      missingBarDays: [],
      classified: brTrades.map(x => ({
        id: x.trade.id,
        date: x.date,
        entry_time: x.trade.entry_time,
        entry_price: x.trade.entry_price,
        direction: x.trade.direction,
        symbol: x.trade.symbol,
        pnl: x.trade.pnl,
        matched_tag: x.matched[0],
        all_matched_tags: x.matched,
        result: null,
        skip_reason: 'Trade has no symbol set; cannot fetch bars.',
      })),
      summary: emptySummary(),
      config,
    })
  }

  // 6. Fetch bars in one paginated query per symbol (covers the full range).
  const barsBySymbol = new Map<string, RawBar[]>()
  for (const sym of symbols) {
    const acc: RawBar[] = []
    let from = 0
    // Big upper bound — 8 months of 1-min RTH bars is ~70k rows. 100 pages = 100k rows.
    for (let p = 0; p < 100; p++) {
      const { data, error } = await supabase
        .from('ohlcv_bars')
        .select('ts, open, high, low, close, volume')
        .eq('symbol', sym)
        .gte('ts', earliestIso)
        .lte('ts', latestIso)
        .order('ts', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        console.error('[studies/break-retest] bars page', p, 'failed:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      const rows = (data ?? []) as RawBar[]
      acc.push(...rows)
      if (rows.length < PAGE) break
      from += PAGE
    }
    barsBySymbol.set(sym, acc)
  }

  // 7. For each trade, derive bars/levels for its date and classify.
  //    Cache levels per (symbol, date) since multiple trades may share a day.
  const levelsCache = new Map<string, ReturnType<typeof computeSessionLevels>>()
  const missingBarDays = new Set<string>()
  const classified: ClassifiedTrade[] = []

  for (const { trade, matched, date } of brTrades) {
    const sym = trade.symbol ?? symbols[0]
    const base: ClassifiedTrade = {
      id: trade.id,
      date,
      entry_time: trade.entry_time,
      entry_price: trade.entry_price,
      direction: trade.direction,
      symbol: trade.symbol,
      pnl: trade.pnl,
      matched_tag: matched[0],
      all_matched_tags: matched,
      result: null,
    }

    if (!date || !trade.entry_time || trade.entry_price == null || !trade.direction) {
      classified.push({ ...base, skip_reason: 'Missing entry data (date/time/price/direction).' })
      continue
    }

    const allBars = barsBySymbol.get(sym) ?? []
    // Quick check: is there ANY bar from the trade's date in our pull?
    const dayHasBars = allBars.some(b => b.ts.startsWith(date))
    if (!dayHasBars) {
      missingBarDays.add(date)
      classified.push({ ...base, skip_reason: `No bars in ohlcv_bars for ${sym} on ${date}. Import via Settings → Bar Data.` })
      continue
    }

    const cacheKey = `${sym}|${date}`
    let lvl = levelsCache.get(cacheKey)
    if (!lvl) {
      lvl = computeSessionLevels(allBars, date, { ...DEFAULT_LEVELS_CONFIG, emaTimeframeMins: emaTf })
      levelsCache.set(cacheKey, lvl)
    }

    // Trim bars to just what the classifier needs: from prior day's ETH open through entry.
    // Cheaper than passing everything; the classifier filters by entryTime anyway.
    const entryMs = Date.parse(trade.entry_time)
    const minMs = entryMs - 2 * 86_400_000  // wide enough to include prior day's ETH (15:00 PT prior)
    const lookbackBars = allBars.filter(b => {
      const ms = Date.parse(b.ts)
      return ms >= minMs && ms <= entryMs
    })

    const result = classifyBreakRetest(
      { entryTime: trade.entry_time, entryPrice: trade.entry_price, direction: trade.direction },
      lookbackBars,
      lvl.levels,
      lvl.series,
      config,
    )
    classified.push({ ...base, result })
  }

  // 8. Per-verdict summary.
  const summary = emptySummary()
  for (const c of classified) {
    if (!c.result) continue
    const v = c.result.verdict
    summary[v].count += 1
    if (typeof c.pnl === 'number') {
      summary[v].totalPnl += c.pnl
      if (c.pnl > 0) summary[v].wins += 1
      else if (c.pnl < 0) summary[v].losses += 1
    }
  }
  for (const v of Object.keys(summary) as BreakRetestVerdict[]) {
    const s = summary[v]
    s.winRate = s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : 0
    s.avgPnl = s.count > 0 ? s.totalPnl / s.count : 0
  }

  return NextResponse.json({
    matchedTags,
    missingBarDays: Array.from(missingBarDays).sort(),
    classified,
    summary,
    config,
  })
}

function numParam(sp: URLSearchParams, key: string, fallback: number): number {
  const raw = sp.get(key)
  if (raw == null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

interface VerdictBucket { count: number; wins: number; losses: number; totalPnl: number; winRate: number; avgPnl: number }
function emptySummary(): Record<BreakRetestVerdict, VerdictBucket> {
  const make = (): VerdictBucket => ({ count: 0, wins: 0, losses: 0, totalPnl: 0, winRate: 0, avgPnl: 0 })
  return {
    TRUE_BREAK_RETEST: make(),
    REJECTION_OFF_LEVEL: make(),
    BREAK_NO_RETEST: make(),
    REVERSAL_AFTER_BREAK: make(),
    NO_NEARBY_LEVEL: make(),
    AMBIGUOUS: make(),
  }
}
