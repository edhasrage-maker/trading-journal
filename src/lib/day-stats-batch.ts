// Batch twin of recomputeDayStats (day-stats-server.ts): computes and stores the
// per-day dashboard rollup for MANY days in one pass. Two callers:
//   - the dashboard, for the days whose cached rollup is missing or stale, and
//   - warmDayStats, run AFTER a page has been sent (see the app layout).
//
// WHY IT EXISTS: a STATS_VERSION bump (or a new ATR stop setting) dirties every
// day at once. The dashboard used to rebuild them inside the click: 14 chunked
// reads one after another per table, then one UPDATE per day fired all at once
// (699 for the founder account), and the page waited for every write. After a
// deploy that changed the rollup, Recap → Dashboard took 30+ seconds.
// Now: the reads run a few chunks at a time in parallel, the writes happen after
// the response, a bounded number at a time, and the first page load after a
// deploy rebuilds the cache in the background before the dashboard is opened.
//
// Same inputs as recomputeDayStats — the shared computeDayStats, with the
// market-context row picked by the day's instrument (pickMarketContext) — so a
// day computed here, there or on the dashboard is the same day.

import { cache } from 'react'
import {
  computeDayStats, isFreshStats, toStoredStats, STATS_VERSION, ROLLUP_TRADE_COLS,
  type DayForStats, type DayStatsRollup, type DayStatsStored, type TradeForStats,
} from './day-stats'
import { loadAtrStopTarget } from './day-stats-server'
import { pickMarketContext } from './market-context-select'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

/** Day ids per `.in()` — keeps PostgREST URLs under their length limit. */
const CHUNK = 50
/** Chunks in flight per table while reading. */
const READ_PARALLEL = 4
/** UPDATEs in flight while writing. */
const WRITE_PARALLEL = 16
const PAGE = 1000
/** The dashboard's window: the newest 1000 days. */
const DAY_WINDOW = 1000

/** Run `fn` over `items`, at most `parallel` at a time. */
async function pooled<T>(items: T[], parallel: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

function chunks(ids: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK))
  return out
}

/** The day columns the rollup reads, minus the analysis blobs (fetched here). */
export type DayRowForStats = Pick<DayForStats, 'id' | 'date' | 'eod_pnl' | 'day_type' | 'day_types' | 'achievements'>

type Blobs = Pick<DayForStats, 'id' | 'ai_analysis_json' | 'eod_ai_analysis_json'>
type TradeRow = TradeForStats & { trading_day_id: string }
type ContextRow = { trading_day_id: string; symbol: string | null; atr_1m: number | null }

/**
 * Compute the rollup for each of `days` from its trades, analysis blobs and
 * market context, in the order given. Throws if the blobs or the trades can't
 * be read: a day computed from missing trades would be quietly wrong.
 */
export async function computeDayRollups(
  supabase: AnyClient, days: DayRowForStats[], atrStopTarget: number,
): Promise<DayStatsRollup[]> {
  if (days.length === 0) return []
  const slices = chunks(days.map(d => d.id))
  const blobs: Blobs[] = []
  const trades: TradeRow[] = []
  const contexts: ContextRow[] = []
  await Promise.all([
    pooled(slices, READ_PARALLEL, async slice => {
      const { data, error } = await supabase
        .from('trading_days').select('id, ai_analysis_json, eod_ai_analysis_json').in('id', slice)
      if (error) throw new Error(`trading_days blobs: ${error.message}`)
      blobs.push(...((data ?? []) as Blobs[]))
    }),
    pooled(slices, READ_PARALLEL, async slice => {
      // A busy chunk can pass the 1000-row cap, so page within it.
      for (let p = 0; p < 50; p++) {
        const { data, error } = await supabase
          .from('trades')
          // Exactly the shared rollup columns plus the grouping key, like every
          // other query that feeds the rollup.
          .select(`trading_day_id, ${ROLLUP_TRADE_COLS}`)
          .in('trading_day_id', slice)
          .order('id', { ascending: true })
          .range(p * PAGE, p * PAGE + PAGE - 1)
        if (error) throw new Error(`trades: ${error.message}`)
        const batch = (data ?? []) as TradeRow[]
        trades.push(...batch)
        if (batch.length < PAGE) break
      }
    }),
    pooled(slices, READ_PARALLEL, async slice => {
      // Optional input (the ×ATR fallback): a failed read just means no context.
      const { data } = await supabase
        .from('market_context').select('trading_day_id, symbol, atr_1m').in('trading_day_id', slice)
      contexts.push(...((data ?? []) as ContextRow[]))
    }),
  ])

  const blobById = new Map(blobs.map(b => [b.id, b]))
  const group = <T extends { trading_day_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>()
    for (const r of rows) {
      const arr = m.get(r.trading_day_id)
      if (arr) arr.push(r)
      else m.set(r.trading_day_id, [r])
    }
    return m
  }
  const tradesByDay = group(trades)
  const contextsByDay = group(contexts)

  return days.map(d => {
    const dayTrades = tradesByDay.get(d.id) ?? []
    const blob = blobById.get(d.id)
    // One context row per instrument — pick the day's traded one (an ES row's
    // atr_1m ~2 against NQ's ~10 would skew the ×ATR fallback badly).
    const ctx = pickMarketContext(contextsByDay.get(d.id) ?? [], dayTrades)
    return computeDayStats(
      {
        ...d,
        ai_analysis_json: blob?.ai_analysis_json ?? null,
        eod_ai_analysis_json: blob?.eod_ai_analysis_json ?? null,
      },
      dayTrades,
      ctx?.atr_1m ?? null,
      { atrStopTarget },
    )
  })
}

/**
 * Store rollups in `trading_days.stats_json`, a bounded number of UPDATEs at a
 * time. Each is a stats-only update, so the invalidation trigger keeps what it
 * writes (see day-stats-server.ts). Never throws; stops at the first failed
 * write (a pre-migration DB or a read-only demo user fails every one alike).
 *
 * Deliberately NOT one bulk upsert: an upsert inserts when the id is gone, so a
 * day deleted while this ran in the background would come back as an empty row.
 */
export async function writeDayRollups(supabase: AnyClient, rollups: DayStatsRollup[]): Promise<number> {
  let written = 0
  let failed = false
  await pooled(rollups, WRITE_PARALLEL, async r => {
    if (failed) return
    try {
      const { error } = await supabase
        .from('trading_days')
        .update({ stats_json: toStoredStats(r), stats_version: STATS_VERSION })
        .eq('id', r.id)
      if (error) failed = true
      else written++
    } catch {
      failed = true
    }
  })
  return written
}

/** Per request: did the page itself rebuild the stale days? The dashboard has
 *  to (it renders them), so the layout's background warm stands down for that
 *  request instead of computing the same days twice. */
export const dayStatsRequest = cache(() => ({ rebuiltByPage: false }))

const warming = new Map<string, Promise<number>>()

/**
 * Rebuild the signed-in trader's stale day rollups — meant to run after a page
 * has been sent (`after()`), so a deploy that changes the rollup is absorbed by
 * the first page load instead of the next dashboard click. One run per trader
 * per server instance at a time. Never throws; returns how many days it wrote.
 */
export function warmDayStats(supabase: AnyClient, traderKey: string): Promise<number> {
  const running = warming.get(traderKey)
  if (running) return running
  // Started a tick later, so it is registered before anything inside can settle.
  const run = Promise.resolve().then(async () => {
    try {
      const [cacheRes, atrStopTarget] = await Promise.all([
        // Only what freshness needs, via JSON paths — not the rollups themselves.
        supabase
          .from('trading_days')
          .select('id, stats_version, atr_stop:stats_json->trade_parts->atr_stop')
          .order('date', { ascending: false })
          .limit(DAY_WINDOW),
        loadAtrStopTarget(supabase),
      ])
      // No stats columns (a DB before the materialization migration): nothing to warm.
      if (cacheRes.error) return 0
      type CacheRow = { id: string; stats_version: number | null; atr_stop: unknown }
      // The dashboard's own freshness rule (isFreshStats), fed the one field of
      // stats_json it reads. A null stats_json reads back as a null atr_stop,
      // which is never the current setting, so it counts as stale too.
      const stale = ((cacheRes.data ?? []) as CacheRow[]).filter(r => !isFreshStats({
        stats_version: r.stats_version,
        stats_json: r.atr_stop == null ? null : ({ trade_parts: { atr_stop: r.atr_stop } } as unknown as DayStatsStored),
      }, atrStopTarget))
      if (stale.length === 0) return 0

      const days: DayRowForStats[] = []
      await pooled(chunks(stale.map(r => r.id)), READ_PARALLEL, async slice => {
        const { data, error } = await supabase
          .from('trading_days').select('id, date, eod_pnl, day_type, day_types').in('id', slice)
        if (error) throw new Error(`trading_days: ${error.message}`)
        days.push(...((data ?? []) as DayRowForStats[]))
      })
      const rollups = await computeDayRollups(supabase, days, atrStopTarget)
      const written = await writeDayRollups(supabase, rollups)
      console.log(`[day-stats] warmed ${written}/${stale.length} stale days`)
      return written
    } catch (e) {
      console.error('[day-stats] warm failed:', e)
      return 0
    } finally {
      warming.delete(traderKey)
    }
  })
  warming.set(traderKey, run)
  return run
}
