import { createClient } from '@/lib/supabase/server'
import { format, subDays } from 'date-fns'
import { todayPT } from '@/lib/pt-time'
import EmptyStateImport from '@/components/dashboard/EmptyStateImport'
import FirstReadCards from '@/components/dashboard/FirstReadCards'
import DashboardFilterScope from '@/components/dashboard/DashboardFilterScope'
import { type DayStat } from '@/components/dashboard/DashboardStats'
import DashboardCharts from '@/components/dashboard/DashboardCharts'
import DashboardModeSwitch from '@/components/dashboard/DashboardModeSwitch'
import BeginnerDashboard from '@/components/dashboard/BeginnerDashboard'
import AchievementCollection from '@/components/dashboard/AchievementCollection'
import { achievementCounts } from '@/lib/achievements'
import { mergeMgmtTotals } from '@/lib/trade-management'
// Dashboard previously imported liveAtr + fetchAllBars to recompute per-trade
// ATR from `ohlcv_bars` on every request. That path was retired in favor of
// reading the pre-backfilled `trades.entry_atr_1m` column. Imports kept off
// the file so the bundle doesn't carry unused code.
import type { TradingDay, Trade } from '@/lib/supabase/types'
import { aggregateTapeScore } from '@/lib/tapescore'
import {
  fromStoredStats, scoreDayRollups, isFreshStats,
  type DayStatsStored,
} from '@/lib/day-stats'
import { loadTapeScoreSettings, loadRiskHistory } from '@/lib/day-stats-server'
import { computeCarryover } from '@/lib/prep-carryover'
import { liftDragByScope, type LiftDragTrade } from '@/lib/lift-drag'
import type { TradeWithExcursion } from '@/lib/analytics'
import { DashboardHero, type HeroPeriods } from '@/components/review/ReviewMonthHero'
import { SHOW_FINDING_CALLOUT } from '@/lib/finding-callout'
import { resolveReviewScope } from '@/lib/review-scope'
import Link from 'next/link'
import { after } from 'next/server'
import { computeDayRollups, writeDayRollups, dayStatsRequest } from '@/lib/day-stats-batch'

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
  // This page rebuilds its own stale days (it renders them), so the layout's
  // background warm stands down for this request.
  dayStatsRequest().rebuiltByPage = true
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
  // Plus the trader's TapeScore settings: Risk's "Stop size" is graded against
  // the ATR stop setting, so it decides both how a dirty day is recomputed and
  // whether a cached one is still current; the order-flow Score setting is
  // applied when the days are read, so it never dirties the cache.
  const [recentResult, statsResult, achResult, { atrStopTarget, includeFlow }] = await Promise.all([
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
    loadTapeScoreSettings(supabase),
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
  // Lifetime trophy-case counts — the full collection (all badges, ×N) that the
  // dashboard owns. The EOD recap shows only the day's earns, not this strip.
  const collectionCounts = achievementCounts(Array.from(achievementsByDayId.values()))

  // Fresh cache map: dayId → stored rollup, ONLY for rows at the current version
  // AND computed with the trader's current ATR stop setting (isFreshStats).
  // A missing/errored stats query (pre-migration) leaves this empty → all dirty.
  const cacheAvailable = !statsResult.error
  const statsByDayId = new Map<string, DayStatsStored>()
  if (cacheAvailable && statsResult.data) {
    for (const r of statsResult.data) {
      if (isFreshStats(r, atrStopTarget)) {
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

  // Dirty days are recomputed here (the page has to render them) by the shared
  // batch engine — the same one the layout's background warm uses, reading a
  // few chunks at a time in parallel — and stored AFTER the response is sent
  // (below), so the click never waits on the writes.
  const dirtyRollups = await computeDayRollups(
    supabase,
    dirtyDays.map(d => ({ ...d, achievements: achievementsByDayId.get(d.id) ?? [] })),
    atrStopTarget,
  )
  tick('dirty days computed', dirtyRollups.length)
  const dirtyById = new Map(dirtyRollups.map(r => [r.id, r]))

  // Per-day rollup: fresh days rehydrate from the cache (column-owned fields
  // re-merged from the row); dirty days come from the SAME shared pure
  // function, so a cached row and a freshly-computed one are identical.
  const rolledUp = recentDaysBase.map(d => {
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
    // computeDayRollups returns one rollup per day it was given.
    return dirtyById.get(d.id)!
  })
  tick('per-day rollup', rolledUp.length)

  // Finish each day's TapeScore: Risk's loss size is measured against the
  // trader's average dollar risk over the days BEFORE it, so the days are read in
  // sequence here (src/lib/exit-rollup.ts) — the same rule the recaps and the
  // Recap day page use. The window is the whole journal, so the days are each
  // other's history; only an account that fills the PAGE_SIZE window needs the
  // days before its oldest row fetched separately.
  const oldestDate = recentDaysBase.length > 0 ? recentDaysBase[recentDaysBase.length - 1].date : null
  const riskHistory = recentDaysBase.length >= PAGE_SIZE && oldestDate
    ? await loadRiskHistory(supabase, oldestDate)
    : []
  const recentDaysMapped = scoreDayRollups(rolledUp, riskHistory, { includeFlow })
  tick('trade parts + tapescore', recentDaysMapped.length)

  // Store the days just recomputed so the next load reads them from cache —
  // after the response is sent, a bounded number of writes at a time
  // (src/lib/day-stats-batch.ts). Best-effort: a pre-migration DB or the
  // read-only demo user fails the write and simply recomputes next load, which
  // is correct.
  if (cacheAvailable && dirtyRollups.length > 0) {
    after(async () => {
      const t = Date.now()
      const written = await writeDayRollups(supabase, dirtyRollups)
      console.log(`[dashboard perf] stored ${written}/${dirtyRollups.length} recomputed days after the response in ${Date.now() - t}ms`)
    })
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

  // Fetch the whole trade book ONCE, RLS-scoped to the user, paginated. Was a
  // nested serial chunk loop (one query per 50 day-ids); at ~1k trades this is a
  // single query. Trades on days beyond the 1000-day window aren't in
  // dayDateById, so the in-memory window filter below drops them — same result.
  const allTrades: Trade[] = []
  for (let p = 0; p < 50; p++) {
    const { data } = await supabase
      .from('trades')
      .select('id, trading_day_id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, symbol, high_during_position, low_during_position, exit_time, tp1_price, entry_atr_1m, structure_5m_alignment, structure_5m_regime')
      .order('id', { ascending: true })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
    const batch = (data ?? []) as Trade[]
    allTrades.push(...batch)
    if (batch.length < PAGE_SIZE) break
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
      scorePeriod: aggregateTapeScore(days),
      carryover: computeCarryover(trades as unknown as TradeWithExcursion[], w.findingLabel),
      tradeCount: trades.length,
      findingLabel: w.findingLabel,
      scoreLabel: w.scoreLabel,
    }]
  })) as HeroPeriods
  tick('hero periods')

  // What lifts and drags the profit factor, for every Period option and Filter
  // range the Trade management card can be showing (src/lib/lift-drag.ts).
  // Same all-history read as the hero; periods under 60 sessions share one
  // widened window, so this is two or three reads, not twelve.
  const liftDragTrades: LiftDragTrade[] = []
  for (const t of allTrades) {
    const date = dayDateById.get(t.trading_day_id)
    if (date && date <= today) liftDragTrades.push({ ...(t as unknown as Omit<LiftDragTrade, 'date'>), date })
  }
  // A read that fails must never take the dashboard down: the card simply
  // goes without the section.
  let liftDrag: ReturnType<typeof liftDragByScope> = {}
  try {
    liftDrag = liftDragByScope(liftDragTrades, today)
  } catch (err) {
    console.error('[dashboard] lift/drag failed', err)
  }
  tick('lift/drag', liftDragTrades.length)

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
    // Realized-R sums behind the payoff ratio on the win-rate tile. This map is
    // an explicit field list, so anything added to the rollup and not named here
    // is computed and then silently dropped.
    sum_win_r: d.sum_win_r,
    win_r_count: d.win_r_count,
    sum_loss_r: d.sum_loss_r,
    loss_r_count: d.loss_r_count,
    r_sample: d.r_sample,
    avg_mfe_pts: d.avg_mfe_pts,
    avg_mae_pts: d.avg_mae_pts,
    avg_mfe_dollars: d.avg_mfe_dollars,
    avg_mae_dollars: d.avg_mae_dollars,
    avg_capture: d.avg_capture,
    // Trade-management sums — the dashboard card pools these over the period.
    mgmt: d.mgmt,
    atr_1m: d.atr_1m,
    avg_live_atr_1m: d.avg_live_atr_1m,
    process_score: d.process_score,
    process_v13_score: d.process_v13_score,
    // Execution composite (0-10) + Process verdict piped through for the
    // charts; the hero itself reads the derived TapeScore.
    overall_grade: d.overall_grade,
    process_verdict: d.process_verdict,
    tapescore: d.tapescore,
    // The day's per-trade sums — a period's axes pool these over its trades.
    trade_sums: d.trade_sums,
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
  // Trade management over the same 30 days, pooled over the TRADES (each day's
  // sums added) — the Highlights "Kept" chip reads the same definition the
  // Detailed card does.
  const beginnerMgmt = mergeMgmtTotals(recentDays.filter(d => d.date >= past30Start).map(d => d.mgmt))
  // Trade win rate + capture % over the 30-day window — plain "how am I doing"
  // signals for the Beginner summary (same numbers Pro shows, plainly labeled).
  const beginnerWinWindow = recentDays.filter(d => d.date >= past30Start)
  const beginnerWins = beginnerWinWindow.reduce((a, d) => a + d.trade_wins, 0)
  const beginnerTradesWithPnl = beginnerWinWindow.reduce((a, d) => a + d.trades_with_pnl_count, 0)
  const beginnerWinRate = beginnerTradesWithPnl > 0 ? (beginnerWins / beginnerTradesWithPnl) * 100 : null
  // Highlights hero (score + leak) now comes from heroPeriods.month — the SAME
  // this-month TapeScore + finding-engine leak the Detailed view renders — so
  // the two modes never disagree. The old 30-day aggregate + hand-written
  // capture focus were removed for exactly that drift.
  // Lean Recent Days table for Highlights (Tape / Trades / Win % / P&L).
  const beginnerDays = recentDaysForTable.slice(0, 8)

  // "Does trading well actually pay?" — the claim the whole product rests on,
  // stated as a measured fact rather than left for the trader to eyeball.
  //
  // Computed over ALL history, deliberately NOT the 30-day window: a dozen
  // sessions is noise, and a line that flips sign week to week would be worse
  // than no line. Suppressed entirely until BOTH buckets clear MIN_N, so it
  // never draws a conclusion off three sessions.
  // How many sessions carry a TapeScore at all. Zero — the state a journal is
  // in right after its first import, since the score comes from the per-session
  // EOD read — makes Highlights swap its verdict for the step that produces one.
  const gradedDaysAllTime = recentDays.filter(d => d.tapescore?.score != null).length

  const MIN_BUCKET = 5
  const scoredDaysWithPnl = recentDays.filter(d => d.tapescore?.score != null && d.eod_pnl != null)
  const wellTradedDays = scoredDaysWithPnl.filter(d => (d.tapescore?.score ?? 0) >= 70)
  const poorlyTradedDays = scoredDaysWithPnl.filter(d => (d.tapescore?.score ?? 0) < 50)
  const meanPnl = (rows: typeof scoredDaysWithPnl) =>
    rows.length > 0 ? rows.reduce((a, d) => a + (d.eod_pnl ?? 0), 0) / rows.length : 0
  const processPayoff =
    wellTradedDays.length >= MIN_BUCKET && poorlyTradedDays.length >= MIN_BUCKET
      ? {
          highAvg: meanPnl(wellTradedDays),
          lowAvg: meanPnl(poorlyTradedDays),
          highN: wellTradedDays.length,
          lowN: poorlyTradedDays.length,
        }
      : null

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
            mgmt={beginnerMgmt}
            greenDays={beginnerGreenDays}
            tradedDays={beginnerTradedDays}
            bestDay={beginnerBestDay}
            hero={heroPeriods.month}
            processPayoff={processPayoff}
            days={beginnerDays}
            gradedDaysAllTime={gradedDaysAllTime}
            charts={<DashboardCharts days={statsDays} />}
          />
        }
      >
        {/* Hero: the TapeScore + the finding, together, each adjustable across
            this month / this year / all time. The ring owns the score, so the
            period stats below drop their own ring.
            While the finding is hidden (SHOW_FINDING_CALLOUT) the band goes
            with it and the score moves into the stat row as its first card,
            on the same Period as the rest — alone, the band was mostly empty. */}
        {SHOW_FINDING_CALLOUT && <DashboardHero periods={heroPeriods} />}

        {/* The all-trades overview — period stats, equity/P&L charts, the
            trophy case and every session — under one Filter (setups × time).
            The filter scopes everything below its bar and nothing above: the
            TapeScore hero grades whole sessions, which can't be split by setup.
            Unfiltered, each section keeps its own saved period exactly as
            before. The trophy case is a lifetime collection and never filters. */}
        <DashboardFilterScope
          statsDays={statsDays}
          tableDays={recentDaysForTable}
          allSetups={allSetups}
          today={today}
          windowStart={windowStart}
          windowEnd={windowEnd}
          defaultFilterStart={defaultFilterStart}
          achievements={<AchievementCollection counts={collectionCounts} />}
          scoreInRow={!SHOW_FINDING_CALLOUT}
          liftDrag={liftDrag}
        />
      </DashboardModeSwitch>
    </div>
  )
}

