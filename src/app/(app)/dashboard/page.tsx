import { createClient } from '@/lib/supabase/server'
import { format, subDays } from 'date-fns'
import { todayPT } from '@/lib/pt-time'
import EmptyStateImport from '@/components/dashboard/EmptyStateImport'
import FirstReadCards from '@/components/dashboard/FirstReadCards'
import RecentDaysSection from '@/components/dashboard/RecentDaysSection'
import DashboardStats, { type DayStat } from '@/components/dashboard/DashboardStats'
import DashboardCharts from '@/components/dashboard/DashboardCharts'
import DashboardModeSwitch from '@/components/dashboard/DashboardModeSwitch'
import BeginnerDashboard from '@/components/dashboard/BeginnerDashboard'
import { formatCapturePct } from '@/lib/analytics'
// Dashboard previously imported liveAtr + fetchAllBars to recompute per-trade
// ATR from `ohlcv_bars` on every request. That path was retired in favor of
// reading the pre-backfilled `trades.entry_atr_1m` column. Imports kept off
// the file so the bundle doesn't carry unused code.
import type { TradingDay, Trade } from '@/lib/supabase/types'
import { aggregateTapeScore } from '@/lib/tapescore'
import { computeDayStats, fromStoredStats, toStoredStats, STATS_VERSION, type DayStatsStored } from '@/lib/day-stats'
import { computeCarryover } from '@/lib/prep-carryover'
import type { TradeWithExcursion } from '@/lib/analytics'
import { DashboardHero, type HeroPeriods } from '@/components/review/ReviewMonthHero'
import { resolveReviewScope } from '@/lib/review-scope'
import Link from 'next/link'

const PAGE_SIZE = 1000

// Disable static generation so the date is recomputed on every request
// (otherwise this page caches and shows stale "today" across midnight).
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DashboardPage() {
  // PT-anchored, not machine-local — see todayPT(). Prevents a mis-set OS
  // timezone on either synced machine from filing today's prep/intraday/EOD
  // under the wrong calendar day.
  const today = todayPT()
  const supabase = await createClient()
  const perf = { phases: [] as Array<{ name: string; ms: number; rows?: number }>, t0: Date.now() }
  const tick = (name: string, rows?: number) => {
    const ms = Date.now() - perf.t0
    perf.phases.push({ name, ms, rows })
    perf.t0 = Date.now()
  }

  // Windows:
  //   - past180Start: drives the Recent Days table's default filter + the
  //     expensive per-trade ATR/bars loop. Keeps the table snappy.
  //   - statsWindowStart: drives the period-selectable stat cards AND the
  //     all-time overview. The overview needs a true all-trades total, so this
  //     reaches ALL history (not just start-of-last-year as the old dashboard
  //     did). The day-rollup cache (stats_json) makes each day a tiny row, so a
  //     multi-year account is cheap in steady state; capped at PAGE_SIZE days.
  const todayDateForWindows = new Date()
  const past30StartParallel = format(subDays(todayDateForWindows, 30), 'yyyy-MM-dd')
  const past180StartParallel = format(subDays(todayDateForWindows, 180), 'yyyy-MM-dd')
  const statsWindowStartParallel = '2000-01-01'

  // Single top-level trading_days query: the period stats + Recent Days table
  // + the new top-of-page charts all derive from this one window (start-of-
  // last-year → today). The separate per-date "today" fetch was dropped along
  // with the Today quick-action tiles it fed.
  // The main trading_days select and the achievements select scan the SAME
  // window and are fully independent, so fire them CONCURRENTLY (one round-trip
  // instead of two). Achievements stays a SEPARATE guarded query — folding
  // achievements_json into the main select would null the entire dashboard
  // dataset on a pre-migration DB; a separate query just yields no coins there.
  // Read-through cache (Pt 10): the per-day rollup is materialized in
  // trading_days.stats_json. Steady state, the dashboard reads those tiny rows
  // and fetches ZERO trades / analysis blobs; only days whose cache is missing
  // or stale (the DB triggers null it on any input change) are recomputed on the
  // fly and written back. The dirty path below is byte-identical to the old
  // full-compute — a pre-migration / pre-backfill DB just makes EVERY day dirty,
  // so the dashboard behaves exactly as before, only uncached.
  //
  // Three concurrent, mutually-independent queries over the same window:
  //   - lightweight day columns (NEVER the big ai/eod blobs — those are fetched
  //     ONLY for dirty days below, which is where the win comes from),
  //   - the materialized stats cache (SEPARATE + guarded: on a pre-migration DB
  //     the stats_json/stats_version columns don't exist and this query errors,
  //     which we read as "all days dirty"; folding it into the main select would
  //     null the WHOLE dataset there — same reason achievements stays separate),
  //   - achievements (separate + guarded, unchanged).
  const [recentResult, statsResult, achResult] = await Promise.all([
    supabase
      .from('trading_days')
      .select('id, date, eod_pnl, day_type, day_types')
      .gte('date', statsWindowStartParallel)
      .order('date', { ascending: false })
      .limit(PAGE_SIZE),
    supabase
      .from('trading_days')
      .select('id, stats_json, stats_version')
      .gte('date', statsWindowStartParallel)
      .order('date', { ascending: false })
      .limit(PAGE_SIZE) as unknown as Promise<{ data: { id: string; stats_json: DayStatsStored | null; stats_version: number | null }[] | null; error: unknown }>,
    supabase
      .from('trading_days')
      .select('id, achievements_json')
      .gte('date', statsWindowStartParallel)
      .order('date', { ascending: false })
      .limit(PAGE_SIZE) as unknown as Promise<{ data: { id: string; achievements_json: string[] | null }[] | null; error: unknown }>,
  ])
  tick('recentDays + stats + achievements')

  const achievementsByDayId = new Map<string, string[]>()
  if (!achResult.error && achResult.data) {
    for (const r of achResult.data) {
      if (Array.isArray(r.achievements_json) && r.achievements_json.length > 0) {
        achievementsByDayId.set(r.id, r.achievements_json)
      }
    }
  }

  // Fresh cache map: dayId → stored rollup, ONLY for rows at the current version.
  // A missing/errored stats query (pre-migration) leaves this empty → all dirty.
  const cacheAvailable = !statsResult.error
  const statsByDayId = new Map<string, DayStatsStored>()
  if (cacheAvailable && statsResult.data) {
    for (const r of statsResult.data) {
      if (r.stats_json != null && r.stats_version === STATS_VERSION) {
        statsByDayId.set(r.id, r.stats_json)
      }
    }
  }

  // Reuse the window constants computed for the parallel fetch above so we
  // don't recompute Date math (and so the labels in the perf log stay correct).
  const past30Start = past30StartParallel
  const past180Start = past180StartParallel

  // We list columns explicitly, so coerce day_types to a typed array (it's a
  // Postgres text[] but the supabase-js type only surfaces it when the column
  // exists in the generated types).
  const recentDaysBase = (recentResult.data ?? []).map(d => {
    const row = d as Record<string, unknown> & Pick<TradingDay, 'id' | 'date' | 'eod_pnl' | 'day_type'>
    return {
      ...row,
      day_types: Array.isArray(row.day_types) ? (row.day_types as string[]) : null,
    }
  })

  // Dirty days: no fresh cache entry. Only these pay for trades + blobs + ATR.
  const dirtyDays = recentDaysBase.filter(d => !statsByDayId.has(d.id))
  const dirtyIds = dirtyDays.map(d => d.id)
  tick('partition (dirty)', dirtyIds.length)

  // Trade stats per day (count + setup tags + summed pnl + MFE/MAE inputs) —
  // one batched query, grouped in code. PnL is needed so the dashboard can
  // fall back to sum(trades.pnl) when the user hasn't saved an explicit
  // eod_pnl override yet. high_during_position / low_during_position +
  // direction + entry_price + symbol + quantity feed the per-day avg MFE / MAE.
  type TradeSlim = {
    id: string
    trading_day_id: string
    entry_time: string | null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tags_json: any
    pnl: number | null
    direction: 'long' | 'short' | null
    entry_price: number | null
    stop_price: number | null
    high_during_position: number | null
    low_during_position: number | null
    quantity: number | null
    symbol: string | null
    // Per-trade Wilder ATR-10 at entry minute, populated by
    // scripts/backfill-entry-metrics.ts. When null (e.g. pre-2025 trades),
    // falls back to day-level market_context.atr_1m.
    entry_atr_1m: number | null
    // Needed by the scaling-aware MFE-capture calc: the per-leg exits + any
    // backfilled per-leg $. Without exits_json a scaled-out trade reads LOWER
    // here than on the EOD recap (which has the full trade data).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exits_json: any
    mfe_dollars_per_leg: number | null
  }
  // Chunk trading_day_ids for the .in() — 50 UUIDs per chunk to stay under
  // PostgREST URL-length limits. Trades pagination per chunk: range() up to
  // PAGE_SIZE because a busy 6-month chunk could exceed the 1000-row cap. All
  // three fetches are scoped to dirtyIds — steady state that's empty → no-ops.
  async function fetchDirtyBlobs(): Promise<Map<string, Pick<TradingDay, 'ai_analysis_json' | 'eod_ai_analysis_json'>>> {
    const out = new Map<string, Pick<TradingDay, 'ai_analysis_json' | 'eod_ai_analysis_json'>>()
    if (dirtyIds.length === 0) return out
    const CHUNK = 50
    for (let i = 0; i < dirtyIds.length; i += CHUNK) {
      const slice = dirtyIds.slice(i, i + CHUNK)
      const { data, error } = await supabase
        .from('trading_days')
        .select('id, ai_analysis_json, eod_ai_analysis_json')
        .in('id', slice)
      if (error) throw new Error(`trading_days blobs: ${error.message}`)
      for (const r of (data ?? []) as (Pick<TradingDay, 'id' | 'ai_analysis_json' | 'eod_ai_analysis_json'>)[]) {
        out.set(r.id, { ai_analysis_json: r.ai_analysis_json, eod_ai_analysis_json: r.eod_ai_analysis_json })
      }
    }
    return out
  }
  async function fetchTradesAll(): Promise<TradeSlim[]> {
    if (dirtyIds.length === 0) return []
    const CHUNK = 50
    const out: TradeSlim[] = []
    for (let i = 0; i < dirtyIds.length; i += CHUNK) {
      const slice = dirtyIds.slice(i, i + CHUNK)
      for (let p = 0; p < 50; p++) {
        const { data, error } = await supabase
          .from('trades')
          .select('id, trading_day_id, entry_time, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, exits_json, mfe_dollars_per_leg')
          .in('trading_day_id', slice)
          .order('id', { ascending: true })
          .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
        if (error) throw new Error(`trades: ${error.message}`)
        const batch = (data ?? []) as TradeSlim[]
        out.push(...batch)
        if (batch.length < PAGE_SIZE) break
      }
    }
    return out
  }
  async function fetchContexts(): Promise<{ trading_day_id: string; atr_1m: number | null }[]> {
    if (dirtyIds.length === 0) return []
    const CHUNK = 50
    const out: { trading_day_id: string; atr_1m: number | null }[] = []
    for (let i = 0; i < dirtyIds.length; i += CHUNK) {
      const slice = dirtyIds.slice(i, i + CHUNK)
      const { data } = await supabase
        .from('market_context')
        .select('trading_day_id, atr_1m')
        .in('trading_day_id', slice)
      if (data) out.push(...(data as { trading_day_id: string; atr_1m: number | null }[]))
    }
    return out
  }
  const [blobsByDayId, tradesAll, contextsRaw] = await Promise.all([fetchDirtyBlobs(), fetchTradesAll(), fetchContexts()])
  tick('dirty trades + blobs + contexts', tradesAll.length)
  const tradesByDay = new Map<string, TradeSlim[]>()
  for (const t of tradesAll) {
    const arr = tradesByDay.get(t.trading_day_id) ?? []
    arr.push(t)
    tradesByDay.set(t.trading_day_id, arr)
  }
  const prepAtrByDay = new Map<string, number | null>()
  for (const c of contextsRaw) {
    prepAtrByDay.set(c.trading_day_id, c.atr_1m)
  }

  // Per-day rollup: fresh days rehydrate from the cache (column-owned fields
  // re-merged from the row); dirty days recompute via the SAME shared pure
  // function so a cached row and a freshly-computed one are identical.
  const recentDaysMapped = recentDaysBase.map(d => {
    const cached = statsByDayId.get(d.id)
    if (cached) {
      return fromStoredStats(cached, {
        id: d.id,
        date: d.date,
        day_type: d.day_type,
        day_types: d.day_types,
        achievements: achievementsByDayId.get(d.id) ?? [],
      })
    }
    const blob = blobsByDayId.get(d.id)
    return computeDayStats(
      {
        id: d.id,
        date: d.date,
        eod_pnl: d.eod_pnl,
        day_type: d.day_type,
        day_types: d.day_types,
        ai_analysis_json: blob?.ai_analysis_json ?? null,
        eod_ai_analysis_json: blob?.eod_ai_analysis_json ?? null,
        achievements: achievementsByDayId.get(d.id) ?? [],
      },
      tradesByDay.get(d.id) ?? [],
      prepAtrByDay.get(d.id) ?? null,
    )
  })
  tick('per-day rollup', recentDaysMapped.length)

  // Read-through write-back: warm the cache for the days we just recomputed so
  // the next load serves them from cache. Best-effort — a stats-only UPDATE
  // leaves the input columns untouched, so the BEFORE UPDATE invalidation
  // trigger preserves what we write. Skipped when the columns are absent
  // (pre-migration) or for read-only demo users (the write errors → swallowed;
  // they simply recompute each load, which is correct). Never blocks the render
  // on failure; errors are swallowed so a warm-cache miss can't break the page.
  if (cacheAvailable && dirtyDays.length > 0) {
    const byId = new Map(recentDaysMapped.map(r => [r.id, r]))
    await Promise.all(dirtyDays.map(d => {
      const rollup = byId.get(d.id)
      if (!rollup) return Promise.resolve()
      return supabase
        .from('trading_days')
        .update({ stats_json: toStoredStats(rollup), stats_version: STATS_VERSION } as never)
        .eq('id', d.id)
        .then(() => {}, () => {})
    }))
    tick('read-through write-back', dirtyDays.length)
  }

  // ── Hero: TapeScore + finding, adjustable by window ────────────────────
  // The trader can switch both the score and the finding across three windows
  // (this month / this year / all time), so precompute each. The score is cheap
  // (aggregate the per-day rollups). The finding needs per-trade data, so fetch
  // the book once (lean fields) and slice it — one all-history read, then all
  // three findings compute in memory.
  const monthStart = `${today.slice(0, 7)}-01`
  const yearStart = `${today.slice(0, 4)}-01-01`
  const dayDateById = new Map(recentDaysBase.map(d => [d.id, d.date]))

  const allDayIds = recentDaysBase.map(d => d.id)
  const allTrades: Trade[] = []
  for (let i = 0; i < allDayIds.length; i += 50) {
    const slice = allDayIds.slice(i, i + 50)
    for (let p = 0; p < 50; p++) {
      const { data } = await supabase
        .from('trades')
        .select('id, trading_day_id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, symbol, high_during_position, low_during_position')
        .in('trading_day_id', slice)
        .order('id', { ascending: true })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
      const batch = (data ?? []) as Trade[]
      allTrades.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
  }
  tick('hero trades (all history)', allTrades.length)

  const monthLabel = new Date(`${today}T12:00:00`).toLocaleDateString('en-US', { month: 'long' })
  const HERO_WINDOWS = [
    { key: 'month' as const, start: monthStart, findingLabel: monthLabel, scoreLabel: 'this month' },
    { key: 'ytd' as const, start: yearStart, findingLabel: 'This year', scoreLabel: 'this year' },
    { key: 'all' as const, start: '0000-01-01', findingLabel: 'All time', scoreLabel: 'all time' },
  ]
  const heroPeriods = Object.fromEntries(HERO_WINDOWS.map(w => {
    const days = recentDaysMapped.filter(d => d.date >= w.start)
    const trades = allTrades.filter(t => (dayDateById.get(t.trading_day_id) ?? '') >= w.start)
    return [w.key, {
      scorePeriod: aggregateTapeScore(days.map(d => d.tapescore)),
      carryover: computeCarryover(trades as unknown as TradeWithExcursion[], w.findingLabel),
      tradeCount: trades.length,
      findingLabel: w.findingLabel,
      scoreLabel: w.scoreLabel,
    }]
  })) as HeroPeriods
  tick('hero periods')

  // Pending session → a banner (not a forced redirect to Today). Cheap query;
  // the layout also resolves scope for the nav dot.
  const scope = await resolveReviewScope(supabase)

  // Drop BLANK days: an empty `trading_days` row (e.g. prep opened for a date
  // but no trades logged and no eod_pnl override saved) carries no result and
  // renders as a meaningless empty row in the Recent Days table / calendar and
  // an empty beginner session. The equity/bars charts already skip null-pnl
  // days, so this only affects those list surfaces. A day is kept if it has at
  // least one trade OR an explicit eod_pnl (including a logged $0 flat day,
  // whose displayed eod_pnl is 0, not null).
  const recentDays = recentDaysMapped.filter(d => d.trade_count > 0 || d.eod_pnl != null)

  // Global filter dropdown values — distinct setups across the whole window.
  // Empty strings filtered out. (Day-type filtering moved to analytics, Pt 13.)
  const allSetups = Array.from(new Set(recentDays.flatMap(d => d.setups))).sort()
  // The overview's sessions list/calendar spans ALL history so the trader can
  // browse every trade; the filter still DEFAULTS to the last 30 days so the
  // first paint isn't a wall of rows.
  const windowStart = statsWindowStartParallel
  const windowEnd = today
  const defaultFilterStart = past30Start // list view defaults to "last 30 days"; calendar view defaults to current month

  // Stats dataset: lightweight projection of recentDays for the
  // period-selectable DashboardStats component. Includes all days fetched
  // (start-of-last-year → today) so the client can switch among Week / Month /
  // 30d / YTD / Last Year without another round trip.
  const statsDays: DayStat[] = recentDays.map(d => ({
    date: d.date,
    eod_pnl: d.eod_pnl,
    trade_wins: d.trade_wins,
    trades_with_pnl_count: d.trades_with_pnl_count,
    avg_mfe_pts: d.avg_mfe_pts,
    avg_mae_pts: d.avg_mae_pts,
    avg_mfe_dollars: d.avg_mfe_dollars,
    avg_mae_dollars: d.avg_mae_dollars,
    atr_1m: d.atr_1m,
    avg_live_atr_1m: d.avg_live_atr_1m,
    process_score: d.process_score,
    process_v13_score: d.process_v13_score,
    // Execution composite (0-10) + Process verdict piped through for the
    // charts; the hero itself reads the derived TapeScore.
    overall_grade: d.overall_grade,
    process_verdict: d.process_verdict,
    tapescore: d.tapescore,
  }))

  // The overview's sessions table gets ALL scored days (the filter defaults to
  // 30d on load, but the trader can widen it to their whole history).
  const recentDaysForTable = recentDays

  // Beginner-mode data (docs/BEGINNER_PRO_MODES.md): plain-English 30-day
  // summary + one "focus" derived from the same capture math Pro shows raw +
  // a simple recent-session list. All computed here so the client view is dumb.
  const beginner30 = recentDays.filter(d => d.date >= past30Start && d.eod_pnl != null)
  const beginnerPnl = beginner30.reduce((a, d) => a + (d.eod_pnl ?? 0), 0)
  const beginnerGreenDays = beginner30.filter(d => (d.eod_pnl ?? 0) > 0).length
  const beginnerTradedDays = beginner30.length
  const beginnerBestDay = beginner30.length ? Math.max(...beginner30.map(d => d.eod_pnl ?? 0)) : null
  const capVals = recentDays
    .filter(d => d.date >= past30Start && d.avg_capture != null)
    .map(d => d.avg_capture as number)
  // Invariant guard: a capture fraction outside [0, 1+ε] is a data mismatch
  // (realized PnL above the peak-favorable-$ ceiling) — never surface it as a
  // number or in coaching prose. Fall through to win-rate-based coaching.
  const avgCapRaw = capVals.length ? capVals.reduce((a, b) => a + b, 0) / capVals.length : null
  const avgCap = avgCapRaw != null && formatCapturePct(avgCapRaw) != null ? avgCapRaw : null
  // Trade win rate + capture % over the 30-day window — plain "how am I doing"
  // signals for the Beginner summary (same numbers Pro shows, plainly labeled).
  const beginnerWinWindow = recentDays.filter(d => d.date >= past30Start)
  const beginnerWins = beginnerWinWindow.reduce((a, d) => a + d.trade_wins, 0)
  const beginnerTradesWithPnl = beginnerWinWindow.reduce((a, d) => a + d.trades_with_pnl_count, 0)
  const beginnerWinRate = beginnerTradesWithPnl > 0 ? (beginnerWins / beginnerTradesWithPnl) * 100 : null
  const beginnerCapturePct = avgCap != null ? Math.round(avgCap * 100) : null
  // Highlights hero (score + leak) now comes from heroPeriods.month — the SAME
  // this-month TapeScore + finding-engine leak the Detailed view renders — so
  // the two modes never disagree. The old 30-day aggregate + hand-written
  // capture focus were removed for exactly that drift.
  // Lean Recent Days table for Highlights (Tape / Trades / Win % / P&L).
  const beginnerDays = recentDaysForTable.slice(0, 8)

  tick('per-day computation loop')
  console.log('[dashboard perf]', perf.phases.map(p => `${p.name}=${p.ms}ms${p.rows != null ? ` (${p.rows})` : ''}`).join(' | '))

  // First-run empty state: no logged days in the whole stats window. (Trades
  // only exist under a trading_days row, so zero days ⇒ zero in-window trades;
  // the old check also ANDed tradesAll, which is now only the dirty subset.)
  const isEmptyAccount = recentDaysBase.length === 0

  if (isEmptyAccount) {
    return <EmptyStateImport today={today} />
  }

  return (
    <div>
      {/* Pending session → an invitation to finish it, NOT a forced redirect.
          The overview is what greets you; today's unfinished review is one
          click away. */}
      {scope.pending && (
        <Link
          href={`/review/today/${scope.today}`}
          className="flex items-center justify-between gap-3 mb-6 px-4 py-3 rounded-lg border border-gray-800 border-l-[3px] border-l-yellow-600 bg-gray-900 hover:bg-gray-800/60 transition-colors group"
        >
          <span className="text-sm text-gray-200">
            <span className="font-semibold text-yellow-400">Today&apos;s session isn&apos;t reviewed yet.</span>
            {' '}Close the loop while it&apos;s fresh.
          </span>
          <span className="text-[13px] text-blue-400 group-hover:text-blue-300 whitespace-nowrap">Finish today&apos;s review →</span>
        </Link>
      )}

      {/* Post-import retroactive recap (item 22): self-gates on the write-once
          first_read flag, so it only shows for a tester right after their first
          import and stays until dismissed. */}
      <FirstReadCards variant="dashboard" />

      {/* Highlights (default) = plain summary + one focus + simple session list.
          Detailed Tape = the full overview: the all-time score cluster, period
          stats, charts, the list/calendar sessions, then this month's read. */}
      <DashboardModeSwitch
        beginner={
          <BeginnerDashboard
            pnl={beginnerPnl}
            winRate={beginnerWinRate}
            capturePct={beginnerCapturePct}
            greenDays={beginnerGreenDays}
            tradedDays={beginnerTradedDays}
            bestDay={beginnerBestDay}
            hero={heroPeriods.month}
            days={beginnerDays}
            charts={<DashboardCharts days={statsDays} />}
          />
        }
      >
        {/* Hero: the TapeScore + the finding, together, each adjustable across
            this month / this year / all time. The ring owns the score, so the
            period stats below drop their own ring. */}
        <DashboardHero periods={heroPeriods} />

        {/* The all-trades overview: period-selectable stats + equity/P&L charts.
            The period is the trader's saved preference (defaults to Last 30
            Days / YtD); the all-time total is a dropdown away, and the score
            ring above is always all-time regardless. */}
        <div className="mt-8 pt-5 border-t border-gray-700">
          <DashboardStats days={statsDays} hideScoreHero />
        </div>
        <DashboardCharts days={statsDays} />

        {/* Every session — toggle between the list and the calendar. */}
        <div className="mt-8 pt-5 border-t border-gray-700">
          <RecentDaysSection
            initialDays={recentDaysForTable}
            allSetups={allSetups}
            windowStart={windowStart}
            windowEnd={windowEnd}
            defaultFilterStart={defaultFilterStart}
          />
        </div>
      </DashboardModeSwitch>
    </div>
  )
}

