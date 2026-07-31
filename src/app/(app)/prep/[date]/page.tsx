import { createClient } from '@/lib/supabase/server'
import PrepClient from '@/components/prep/PrepClient'
import { computeDrAdr } from '@/lib/dr-adr'
import { fetchHighImpactNews } from '@/lib/economic-calendar'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { signTradeScreenshots, signDayScreenshots } from '@/lib/storage-url'
import { computeCarryover } from '@/lib/prep-carryover'
import { joinTradesWithContext } from '@/lib/analytics'
import type { TradingDay, MarketContext, Trade } from '@/lib/supabase/types'

export default async function PrepPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase = await createClient()

  // Carryover window bounds (used by Stage A's windowDays query).
  const monthStart = `${date.slice(0, 7)}-01`
  const sixtyDaysBefore = new Date(`${date}T12:00:00Z`)
  sixtyDaysBefore.setUTCDate(sixtyDaysBefore.getUTCDate() - 60)
  const wideStart = sixtyDaysBefore.toISOString().slice(0, 10)

  // ── Stage A: everything independent of the day row, in parallel ──
  // (Was a sequential waterfall — user, news, day, tags, and the 60-day window
  //  are all independent, so they run concurrently instead of one-at-a-time.)
  const [userRes, highImpactNews, dayRes, dayTypeTagsRes, windowDaysRes] = await Promise.all([
    supabase.auth.getUser(),
    fetchHighImpactNews(date),               // cached + Next data-cache; never throws
    supabase.from('trading_days').select('*').eq('date', date).single(),
    supabase.from('trade_tags').select('label').eq('category', 'day_type').order('sort_order'),
    supabase.from('trading_days').select('id, date, day_type, day_types').gte('date', wideStart).lt('date', date),
  ])

  // Admin = local owner build, OR the hosted user whose email matches ADMIN_EMAIL.
  const user = userRes.data.user
  const isAdmin = LOCAL_FEATURES_ENABLED || (!!user?.email && user.email === process.env.ADMIN_EMAIL)

  // Normalize day_types: SELECT '*' returns the column when present, missing
  // otherwise. Coerce to a typed shape so the client always sees an array.
  const dayObj = dayRes.data as (Record<string, unknown> & TradingDay) | null
  const day = dayObj ? {
    ...dayObj,
    day_types: Array.isArray(dayObj.day_types) ? dayObj.day_types as string[] : null,
  } as TradingDay : null

  // Day-type options sourced from trade_tags so prep + intraday share one list.
  const dayTypeOptions = ((dayTypeTagsRes.data ?? []) as { label: string }[]).map(t => t.label)
  const reviewDays = (windowDaysRes.data ?? []) as { id: string; date: string; day_type: string | null; day_types: string[] | null }[]
  const reviewDayIds = reviewDays.map(d => d.id)

  // ── Stage B: day-dependent + window-dependent queries, in parallel ──
  const [contextRes, tradesRes, windowTradesRes, windowCtxRes] = await Promise.all([
    // limit(1) not single(): a day can now hold one context row per
    // instrument, and single()/maybeSingle() both throw on a second row.
    day ? supabase.from('market_context').select('*').eq('trading_day_id', day.id).order('symbol', { ascending: true }).limit(1) : Promise.resolve({ data: null }),
    day ? supabase.from('trades').select('*').eq('trading_day_id', day.id).order('entry_time', { ascending: true }) : Promise.resolve({ data: [] as Trade[] }),
    reviewDayIds.length > 0 ? supabase.from('trades').select('*').in('trading_day_id', reviewDayIds) : Promise.resolve({ data: [] as Trade[] }),
    reviewDayIds.length > 0 ? supabase.from('market_context').select('trading_day_id, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m').in('trading_day_id', reviewDayIds) : Promise.resolve({ data: [] }),
  ])
  const context = ((contextRes.data as MarketContext[] | null) ?? [])[0] ?? null
  const trades = (tradesRes.data ?? []) as Trade[]
  const windowTrades = (windowTradesRes.data ?? []) as Trade[]
  const windowCtxRaw = windowCtxRes.data

  const FALLBACK_SYMBOL = 'MNQM6.CME'
  const symbolForBars = context?.symbol && /^[A-Z]+\d+\.[A-Z]+$/.test(context.symbol)
    ? context.symbol
    : FALLBACK_SYMBOL

  // Chart symbol = most-common symbol on the day's trades, else the bar symbol.
  const symbolCounts = new Map<string, number>()
  for (const t of trades) {
    if (t.symbol) symbolCounts.set(t.symbol, (symbolCounts.get(t.symbol) ?? 0) + 1)
  }
  let chartSymbol: string | null = null
  let best = 0
  for (const [sym, c] of symbolCounts) if (c > best) { chartSymbol = sym; best = c }
  if (!chartSymbol) chartSymbol = symbolForBars

  // ── Stage C: bar-derived DR/ADR + screenshot signing, in parallel ──
  // DR_ADR priority: (1) market_context.day_range/adr (canonical, no query);
  // (2) bar fallback (computeDrAdr) only when those are missing. Signing mutates
  // day/trades in place (no-op on public URLs).
  let drAdrAuto: number | null = null
  if (context?.day_range != null && context.adr != null && context.adr > 0) {
    drAdrAuto = Math.round((context.day_range / context.adr) * 100) / 100
  }
  const [drAdrResult] = await Promise.all([
    drAdrAuto == null ? computeDrAdr(supabase, date, symbolForBars, context?.adr ?? null) : Promise.resolve(null),
    signDayScreenshots(supabase, day),
    signTradeScreenshots(supabase, trades),
  ])
  if (drAdrAuto == null && drAdrResult) {
    drAdrAuto = drAdrResult.dr_adr != null ? Math.round(drAdrResult.dr_adr * 100) / 100 : null
  }

  // ── Review → Prep carryover (pure compute over the window data above) ──
  const dayDateById = new Map(reviewDays.map(d => [d.id, d.date]))
  const inMonth = windowTrades.filter(t => (dayDateById.get(t.trading_day_id) ?? '') >= monthStart)
  const monthLabel = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'long' })
  let carryover = computeCarryover(inMonth, `${monthLabel} review`)
  if (!carryover) carryover = computeCarryover(windowTrades, 'last 60 sessions')

  const windowTradesWithContext = joinTradesWithContext(
    windowTrades,
    reviewDays.map(d => ({ id: d.id, date: d.date, day_type: d.day_type, day_types: d.day_types })),
    (windowCtxRaw ?? []) as Parameters<typeof joinTradesWithContext>[2],
  )

  return (
    <PrepClient
      // Remount on date change so all useState-initialized form data (context,
      // notes, day_types, …) resets to the new day's props. Without this, a
      // soft-navigation between /prep/[date] params reuses the instance and the
      // form keeps the PREVIOUS day's data (looks like the switch "didn't work").
      key={date}
      date={date}
      initialDay={day}
      initialContext={context}
      dayTypeOptions={dayTypeOptions}
      drAdrAuto={drAdrAuto}
      chartSymbol={chartSymbol}
      initialTrades={trades}
      highImpactNews={highImpactNews}
      isAdmin={isAdmin}
      carryover={carryover}
      historyTrades={windowTradesWithContext}
    />
  )
}
