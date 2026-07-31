// Server-side write path for the materialized per-day dashboard rollup (Pt 10).
// Fetches one day's inputs, runs the SHARED pure computeDayStats, and persists
// the projected rollup to trading_days.stats_json (+ stats_version). Because it
// uses the same computeDayStats the dashboard reads with, a cached row and a
// freshly-computed row are byte-identical by construction.
//
// Runs under the CALLER's Supabase client, so RLS scopes reads + the write to
// that user's own rows. Wired into the mutation points (import, analyze-eod,
// analyze-prep, trade edit/delete, market-context write) as a best-effort warm;
// the DB triggers (migration 20260718) + the dashboard read-through keep results
// correct even if a recompute here is skipped.
//
// IMPORTANT: the write is a SEPARATE update touching only stats_json/
// stats_version, so the BEFORE UPDATE invalidation trigger (which only fires on
// input-column changes) preserves the value we just wrote. Never fold this into
// the same update as an ai_analysis_json / eod_pnl / day_types mutation.

import {
  computeDayStats, toStoredStats, STATS_VERSION,
  type DayForStats, type TradeForStats,
} from './day-stats'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

// The exact trade columns computeDayStats reads (superset-safe).
const TRADE_COLS =
  'id, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, exits_json, mfe_dollars_per_leg'

const DAY_COLS =
  'id, date, eod_pnl, day_type, day_types, ai_analysis_json, eod_ai_analysis_json'

/**
 * Recompute + persist one day's stats_json. Best-effort: never throws — logs and
 * returns false on any failure (a missing column on a pre-migration DB, an RLS
 * denial for a read-only demo user, etc.) so it can't break the mutation it
 * hangs off of. Returns true when the cache was written.
 */
export async function recomputeDayStats(supabase: AnyClient, dayId: string): Promise<boolean> {
  try {
    if (!dayId) return false
    const dayRes = await supabase.from('trading_days').select(DAY_COLS).eq('id', dayId).maybeSingle()
    const day = dayRes?.data as DayForStats | null | undefined
    if (!day) return false

    const [tradesRes, ctxRes] = await Promise.all([
      supabase.from('trades').select(TRADE_COLS).eq('trading_day_id', dayId),
      // One context row per instrument now — maybeSingle() throws on two.
      supabase.from('market_context').select('atr_1m').eq('trading_day_id', dayId).order('symbol', { ascending: true }).limit(1),
    ])
    const trades = (tradesRes?.data ?? []) as TradeForStats[]
    const prepAtr = ((ctxRes?.data as { atr_1m: number | null }[] | null)?.[0]?.atr_1m) ?? null

    const rollup = computeDayStats(day, trades, prepAtr)
    const { error } = await supabase
      .from('trading_days')
      .update({ stats_json: toStoredStats(rollup), stats_version: STATS_VERSION })
      .eq('id', dayId)
    if (error) {
      // Missing column (pre-migration) or any write error → leave the cache
      // null; the read-through recomputes it. Don't surface it.
      console.warn('[day-stats] recompute write skipped:', error.message ?? error)
      return false
    }
    return true
  } catch (e) {
    console.error('[day-stats] recomputeDayStats failed:', e)
    return false
  }
}

/**
 * Recompute + persist for a day resolved by DATE (the common route case — most
 * mutation handlers hold the date, not the trading_days id). No-ops cleanly when
 * the day row doesn't exist yet.
 */
export async function recomputeDayStatsByDate(supabase: AnyClient, date: string): Promise<boolean> {
  try {
    if (!date) return false
    const res = await supabase.from('trading_days').select('id').eq('date', date).maybeSingle()
    const id = res?.data?.id as string | undefined
    if (!id) return false
    return await recomputeDayStats(supabase, id)
  } catch (e) {
    console.error('[day-stats] recomputeDayStatsByDate failed:', e)
    return false
  }
}
