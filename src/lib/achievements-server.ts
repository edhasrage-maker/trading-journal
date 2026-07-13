// Server-side orchestration for persisting per-day achievements (gamification
// Phase 2). Pulls the same inputs the EOD page assembles — the day's trades,
// the user's realized-P&L history, and the session's high-low range — and runs
// the PURE dayAchievementIds() engine so the persisted result can never drift
// from what the EOD recap shows live.
//
// Everything here runs under the CALLER's Supabase client, so RLS scopes both
// reads and writes to that user's own rows. Shared by:
//   - /api/trading-days/[date]/eod  (recompute when the day is saved)
//   - /api/achievements/backfill    (one-shot history sweep)

import { dayAchievementIds, type AchievementId, type AchievementTrade } from './achievements'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Minimal day shape the recompute needs. */
export interface AchievementDayRow {
  id: string
  date: string
  eod_pnl: number | null
}

/** The user's realized session P&L history ({date, pnl}) — for Career Day
 *  (percentile) and Heat Check (streak). Same source as the EOD page + dashboard:
 *  trading_days rows with a non-null eod_pnl, ordered by date. */
export async function fetchPnlHistory(supabase: AnyClient): Promise<{ date: string; pnl: number }[]> {
  const { data } = await supabase
    .from('trading_days')
    .select('date, eod_pnl')
    .not('eod_pnl', 'is', null)
    .order('date', { ascending: true })
  return (data ?? []).map((d: { date: string; eod_pnl: number }) => ({ date: d.date, pnl: d.eod_pnl }))
}

/** Compute the earned achievement ids for a single day. `pnlHistory` and
 *  `dayRangePts` are passed in so a batch caller (backfill) fetches them once
 *  instead of per-day. */
export function computeDayIds(
  day: AchievementDayRow,
  trades: AchievementTrade[],
  pnlHistory: { date: string; pnl: number }[],
  dayRangePts: number | null,
): AchievementId[] {
  return dayAchievementIds({
    date: day.date,
    dayPnl: day.eod_pnl,
    trades,
    pnlHistory,
    dayRangePts,
  })
}

/** Recompute + PERSIST one day's achievements. Fetches the day's trades, its
 *  market_context day range, and the P&L history itself, so it's self-contained
 *  for the single-day (route) case. Returns the earned ids (also written to
 *  trading_days.achievements_json). Best-effort: never throws — logs and returns
 *  [] on failure so it can't break the save it hangs off of. */
export async function recomputeAndPersistDay(
  supabase: AnyClient,
  day: AchievementDayRow | null | undefined,
): Promise<AchievementId[]> {
  try {
    if (!day) return []
    const [tradesRes, ctxRes] = await Promise.all([
      supabase.from('trades').select('*').eq('trading_day_id', day.id),
      supabase.from('market_context').select('day_range').eq('trading_day_id', day.id).maybeSingle(),
    ])
    const pnlHistory = await fetchPnlHistory(supabase)
    const dayRangePts = (ctxRes?.data?.day_range as number | null | undefined) ?? null
    const ids = computeDayIds(day, (tradesRes?.data ?? []) as AchievementTrade[], pnlHistory, dayRangePts)
    await supabase.from('trading_days').update({ achievements_json: ids }).eq('id', day.id)
    return ids
  } catch (e) {
    console.error('[achievements] recomputeAndPersistDay failed:', e)
    return []
  }
}
