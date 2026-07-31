import { createClient } from '@/lib/supabase/server'
import EodClient from '@/components/eod/EodClient'
import CommitmentResolution from '@/components/review/CommitmentResolution'
import { fetchAllBars, postExitExtension, type AtrBar, type PostExitData } from '@/lib/atr'
import { configuredAtr } from '@/lib/atr-config'
import { getAtrConfig, getGiveBackAtr } from '@/lib/atr-config-server'
import { signTradeScreenshots, signDayScreenshots } from '@/lib/storage-url'
import { achievementCounts } from '@/lib/achievements'
import type { TradingDay, Trade, TradeTag, MarketContext } from '@/lib/supabase/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

export default async function EodPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const supabase: AnyClient = await createClient()
  // ── Stage A: config + the day row + all-days aggregates, in parallel ──
  // atrCfg = the trader's chosen ATR measurement (drives the ATR@ column);
  // giveBackAtr = their "was up" multiple; tags = the tag library; pnlHistory +
  // achievements are all-days rollups. All independent → one round-trip stage.
  const [atrCfg, giveBackAtr, dayRes, tagsRes, dayPnlRes, achRes] = await Promise.all([
    getAtrConfig(supabase),
    getGiveBackAtr(supabase),
    supabase.from('trading_days').select('*').eq('date', date).maybeSingle(),
    supabase.from('trade_tags').select('*').order('sort_order'),
    supabase.from('trading_days').select('date, eod_pnl').not('eod_pnl', 'is', null).order('date', { ascending: true }),
    supabase.from('trading_days').select('achievements_json'),
  ])
  const day = dayRes.data as TradingDay | null
  const tags = tagsRes.data as TradeTag[] | null
  const pnlHistory = ((dayPnlRes.data ?? []) as { date: string; eod_pnl: number }[]).map(d => ({ date: d.date, pnl: d.eod_pnl }))
  // achievements_json select errors before its migration/backfill exists — guard
  // so counts stay undefined (showcase falls back to "First time!").
  const achRows = achRes.error ? null : (achRes.data as { achievements_json: string[] | null }[] | null)
  const counts = achRows ? achievementCounts(achRows.map(r => r.achievements_json)) : undefined

  // ── Stage B: day-dependent trades + market context, in parallel ──
  let trades: Trade[] = []
  let marketContext: MarketContext | null = null
  if (day) {
    const [tradesRes, ctxRes] = await Promise.all([
      supabase.from('trades').select('*').eq('trading_day_id', day.id).order('entry_time', { ascending: true }),
      // See prep/[date]: one row per instrument, so never single/maybeSingle.
      supabase.from('market_context').select('*').eq('trading_day_id', day.id).order('symbol', { ascending: true }).limit(1),
    ])
    trades = (tradesRes.data ?? []) as Trade[]
    marketContext = ((ctxRes.data as MarketContext[] | null) ?? [])[0] ?? null
  }

  // Per-trade LIVE ATR: compute ATR-10 Wilder from 1-min bars at each trade's
  // entry_time and pass to EodClient as a map { tradeId → atrPts }. The trade
  // list surfaces this as an "ATR @ entry" chip so the trader can see how
  // volatile the market actually was when each trade fired (the prep ATR is
  // a single morning snapshot, often stale by trade time).
  const liveAtrByTradeId: Record<string, number> = {}
  const postExitByTradeId: Record<string, PostExitData> = {}
  if (trades.length > 0) {
    const symbolDatePairs = new Set<string>()
    for (const t of trades) {
      if (t.symbol && t.entry_time) symbolDatePairs.add(`${t.symbol}|${date}`)
    }
    const barsBySymbolDate = new Map<string, AtrBar[]>()
    await Promise.all(
      Array.from(symbolDatePairs).map(async key => {
        const [symbol] = key.split('|')
        const bars = await fetchAllBars(supabase, symbol, date)
        barsBySymbolDate.set(key, bars)
      }),
    )
    for (const t of trades) {
      if (!t.symbol || !t.entry_time) continue
      const bars = barsBySymbolDate.get(`${t.symbol}|${date}`)
      if (!bars || bars.length === 0) continue
      const value = configuredAtr(bars, new Date(t.entry_time), atrCfg)
      if (value != null) liveAtrByTradeId[t.id] = value
    }

    // Post-Exit Continuation (POST_EXIT_WINDOW_MIN after exit) — uses the same
    // bar set we fetched for live ATR. For each trade with an exit, record max
    // continuation in trade direction and max reversal against it. Trade list
    // displays "compared to what you took".
    for (const t of trades) {
      if (!t.symbol) continue
      const bars = barsBySymbolDate.get(`${t.symbol}|${date}`)
      if (!bars || bars.length === 0) continue
      const ext = postExitExtension(bars, {
        direction: t.direction,
        exit_price: t.exit_price,
        exit_time: t.exit_time,
      })
      if (ext != null) postExitByTradeId[t.id] = ext
    }
  }

  // Private-bucket screenshots are stored as storage paths; mint signed URLs at
  // this server boundary so the client renders them. Legacy/public URLs pass
  // through unchanged (local owner build). Runs after the ATR/post-exit loops
  // above, which only read numeric/time fields.
  await Promise.all([
    signDayScreenshots(supabase, day),
    signTradeScreenshots(supabase, trades),
  ])

  // The Prep commitment for this session, if one was tracked. Review · Today is
  // its one obvious resolution home — that is the whole reason EOD folded in
  // here rather than staying a separate destination.
  const commitment = day?.prep_notes_json?.commitment ?? null

  return (
    <>
      {commitment && <CommitmentResolution date={date} commitment={commitment} />}
      <EodClient
        date={date}
        initialDay={day}
        initialTrades={trades}
        initialMarketContext={marketContext}
        allTags={tags ?? []}
        liveAtrByTradeId={liveAtrByTradeId}
        postExitByTradeId={postExitByTradeId}
        pnlHistory={pnlHistory}
        achievementCounts={counts}
        giveBackAtr={giveBackAtr}
      />
    </>
  )
}
