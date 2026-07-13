import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { computeDayIds, type AchievementDayRow } from '@/lib/achievements-server'
import { achievementCounts, type AchievementId, type AchievementTrade } from '@/lib/achievements'
import { clientError } from '@/lib/api-error'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE = 1000

/** Page through a table under the caller's RLS, ordering by id for a
 *  deterministic tiebreak (Supabase caps a single response at 1000 rows). */
async function fetchAll<T>(supabase: AnyClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < 50; p++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...(data as T[]))
    if (data.length < PAGE) break
  }
  return out
}

/**
 * One-shot backfill: recompute every day's earned achievements from history and
 * write them to trading_days.achievements_json, so lifetime counts + dashboard
 * markers are populated for days that predate the persist-on-analyze hook.
 *
 * Runs entirely under the caller's RLS — it only ever reads and writes that
 * user's own rows. Idempotent: safe to re-run (it just overwrites with the
 * freshly computed ids). POST with no body.
 */
export async function POST() {
  try {
    const supabase: AnyClient = await createClient()

    // Pull everything once, compute in memory — far fewer round-trips than a
    // per-day fetch (three page-sets vs ~3× the day count in queries).
    const days = await fetchAll<AchievementDayRow>(supabase, 'trading_days', 'id, date, eod_pnl')
    const trades = await fetchAll<AchievementTrade & { trading_day_id: string }>(
      supabase, 'trades', '*',
    )
    const contexts = await fetchAll<{ trading_day_id: string; day_range: number | null }>(
      supabase, 'market_context', 'trading_day_id, day_range',
    )

    // Group trades by day, index the day-range, and build the shared P&L history.
    const tradesByDay = new Map<string, AchievementTrade[]>()
    for (const t of trades) {
      const arr = tradesByDay.get(t.trading_day_id)
      if (arr) arr.push(t)
      else tradesByDay.set(t.trading_day_id, [t])
    }
    const rangeByDay = new Map<string, number | null>()
    for (const ctx of contexts) rangeByDay.set(ctx.trading_day_id, ctx.day_range)
    const pnlHistory = days
      .filter(d => d.eod_pnl != null)
      .map(d => ({ date: d.date, pnl: d.eod_pnl as number }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Compute ids per day.
    const computed = days.map(day => ({
      id: day.id,
      ids: computeDayIds(day, tradesByDay.get(day.id) ?? [], pnlHistory, rangeByDay.get(day.id) ?? null),
    }))

    // Persist in small parallel chunks (keeps the connection pool sane).
    let updated = 0
    const CHUNK = 20
    for (let i = 0; i < computed.length; i += CHUNK) {
      const slice = computed.slice(i, i + CHUNK)
      await Promise.all(slice.map(async c => {
        const { error } = await supabase
          .from('trading_days')
          .update({ achievements_json: c.ids })
          .eq('id', c.id)
        if (!error) updated++
      }))
    }

    const counts = achievementCounts(computed.map(c => c.ids))
    const totalEarned = computed.reduce((n, c) => n + c.ids.length, 0)
    const daysWithAny = computed.filter(c => c.ids.length > 0).length

    return NextResponse.json({
      ok: true,
      days: days.length,
      updated,
      daysWithAny,
      totalEarned,
      counts: counts as Record<AchievementId, number>,
    })
  } catch (e) {
    console.error('[achievements/backfill] failed:', e)
    return NextResponse.json({ error: clientError(e) }, { status: 500 })
  }
}
