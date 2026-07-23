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
  // Admin = local owner build, OR the hosted user whose email matches
  // ADMIN_EMAIL. The Morning Conditions panel is admin-only (mirrors the
  // admin-only Condition Lookup settings page). Same check as (app)/layout.tsx.
  const { data: { user } } = await supabase.auth.getUser()
  const isAdmin = LOCAL_FEATURES_ENABLED || (!!user?.email && user.email === process.env.ADMIN_EMAIL)
  // Red-folder economic news for the day (server-fetched, cached, never throws).
  const highImpactNews = await fetchHighImpactNews(date)

  const { data: dayRaw } = await supabase
    .from('trading_days').select('*').eq('date', date).single()
  // Normalize day_types: SELECT '*' returns the column when present, missing
  // otherwise. Coerce to a typed shape so the client always sees an array
  // (possibly empty) rather than undefined.
  const dayObj = dayRaw as (Record<string, unknown> & TradingDay) | null
  const day = dayObj ? {
    ...dayObj,
    day_types: Array.isArray(dayObj.day_types) ? dayObj.day_types as string[] : null,
  } as TradingDay : null

  const { data: contextRaw } = day
    ? await supabase.from('market_context').select('*').eq('trading_day_id', day.id).single()
    : { data: null }
  const context = contextRaw as MarketContext | null

  // Day-type options are now sourced from trade_tags so prep + intraday share
  // a single canonical list. The old hardcoded set in PrepClient.tsx was
  // misaligned with the intraday TagSelector — picking "Range Day" in prep
  // matched no chip on the intraday form because that label didn't exist in
  // trade_tags. Sourcing both from one table fixes the drift.
  const { data: dayTypeTags } = await supabase
    .from('trade_tags')
    .select('label')
    .eq('category', 'day_type')
    .order('sort_order')
  const dayTypeOptions = ((dayTypeTags ?? []) as { label: string }[]).map(t => t.label)

  // DR_ADR auto-detect. Priority:
  //   1. market_context.day_range / market_context.adr — extract-context AI
  //      reads "Day's Range" directly from Sierra's stats overlay. This is
  //      the user-canonical value and works even before bars are imported.
  //   2. Bar-based fallback (computeDrAdr) — high-low of 1-min bars in the
  //      6:30-7:30 PT window. Useful for historical days or when the user
  //      hasn't extracted today's screenshot yet.
  const FALLBACK_SYMBOL = 'MNQM6.CME'
  const symbolForBars = context?.symbol && /^[A-Z]+\d+\.[A-Z]+$/.test(context.symbol)
    ? context.symbol
    : FALLBACK_SYMBOL
  let drAdrAuto: number | null = null
  if (context?.day_range != null && context.adr != null && context.adr > 0) {
    drAdrAuto = Math.round((context.day_range / context.adr) * 100) / 100
  } else {
    const drAdrResult = await computeDrAdr(supabase, date, symbolForBars, context?.adr ?? null)
    drAdrAuto = drAdrResult.dr_adr != null
      ? Math.round(drAdrResult.dr_adr * 100) / 100
      : null
  }

  // Trades already taken on this date — feeds the LiveChart so prep shows
  // any trades that have happened so far today (overlap with the EOD chart).
  // Most prep is done before any trades fire, but mid-session re-prep should
  // see what's been done.
  const { data: tradesRaw } = day
    ? await supabase
        .from('trades')
        .select('*')
        .eq('trading_day_id', day.id)
        .order('entry_time', { ascending: true })
    : { data: [] as Trade[] }
  const trades = (tradesRaw ?? []) as Trade[]

  // Pick the chart symbol the same way EodClient does: most-common symbol on
  // the day's trades. Fallback to the symbolForBars derived above (MNQM6.CME)
  // so the chart can render even on days with no trades yet — the user can
  // still see today's price action.
  const symbolCounts = new Map<string, number>()
  for (const t of trades) {
    if (t.symbol) symbolCounts.set(t.symbol, (symbolCounts.get(t.symbol) ?? 0) + 1)
  }
  let chartSymbol: string | null = null
  let best = 0
  for (const [sym, c] of symbolCounts) if (c > best) { chartSymbol = sym; best = c }
  if (!chartSymbol) chartSymbol = symbolForBars

  // Sign private-bucket screenshot paths for the client (no-op on public URLs).
  await signDayScreenshots(supabase, day)
  await signTradeScreenshots(supabase, trades)

  // ── Review → Prep carryover ────────────────────────────────────────────
  // The bridge's finding, computed from the trader's OWN recent sessions.
  // Window = the calendar month up to (but excluding) this prep's date, so the
  // read is "your July review" on a July morning. If that's too thin to say
  // anything defensible, widen to the trailing 60 days and relabel honestly.
  // computeCarryover returns null when nothing separates itself, and the
  // bridge renders its "no read yet" state rather than inventing a lesson.
  const monthStart = `${date.slice(0, 7)}-01`
  const sixtyDaysBefore = new Date(`${date}T12:00:00Z`)
  sixtyDaysBefore.setUTCDate(sixtyDaysBefore.getUTCDate() - 60)
  const wideStart = sixtyDaysBefore.toISOString().slice(0, 10)

  const { data: windowDays } = await supabase
    .from('trading_days')
    .select('id, date, day_type, day_types')
    .gte('date', wideStart)
    .lt('date', date)
  const reviewDays = (windowDays ?? []) as { id: string; date: string; day_type: string | null; day_types: string[] | null }[]

  const { data: windowTradesRaw } = reviewDays.length > 0
    ? await supabase
        .from('trades')
        .select('*')
        .in('trading_day_id', reviewDays.map(d => d.id))
    : { data: [] as Trade[] }
  const windowTrades = (windowTradesRaw ?? []) as Trade[]

  const dayDateById = new Map(reviewDays.map(d => [d.id, d.date]))
  const inMonth = windowTrades.filter(t => (dayDateById.get(t.trading_day_id) ?? '') >= monthStart)

  const monthLabel = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'long' })
  let carryover = computeCarryover(inMonth, `${monthLabel} review`)
  if (!carryover) carryover = computeCarryover(windowTrades, 'last 60 sessions')

  // Per-day-type consequence for the Detailed Tape day-type section, over the
  // same wide window (day types are sparse — the month alone rarely has n≥10).
  const { data: windowCtxRaw } = reviewDays.length > 0
    ? await supabase
        .from('market_context')
        .select('trading_day_id, rvol, ib_size, ib_vs_10d_avg, adr, atr_1m')
        .in('trading_day_id', reviewDays.map(d => d.id))
    : { data: [] }
  const windowTradesWithContext = joinTradesWithContext(
    windowTrades,
    reviewDays.map(d => ({ id: d.id, date: d.date, day_type: d.day_type, day_types: d.day_types })),
    (windowCtxRaw ?? []) as Parameters<typeof joinTradesWithContext>[2],
  )

  return (
    <PrepClient
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
