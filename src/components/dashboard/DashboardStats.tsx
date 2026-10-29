'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { aggregateTapeScore, tapeScorePeriodSentence, type TapeScoreResult } from '@/lib/tapescore'
import { TapeScoreRing, HeroChip, TapeScoreFormulaInfo } from './TapeScoreHeroParts'
import TradeManagementCard from '@/components/TradeManagementCard'
import { mergeMgmtTotals, type MgmtTotals } from '@/lib/trade-management'
import { ScoreCluster, ScoreBreakdownInfo } from '@/components/review/ReviewMonthHero'
import type { LiftDragView } from '@/lib/lift-drag'
import { AXIS_DESC, axisTooltip, type TradeSums } from '@/lib/tapescore-axes'

/**
 * Period-selectable dashboard header: the TapeScore hero (one 0-100 score,
 * verdict sentence, component chips — Ruleset amendment 5) followed by the
 * stat cards, P&L demoted to the card row.
 *
 * Receives the full server-fetched day stats (start-of-last-year → today) and
 * filters client-side on the chosen period. Period is persisted to
 * localStorage so refreshes don't reset to "30d".
 *
 * Stat cards:
 *   1. P&L                — sum of eod_pnl over period
 *   2. Day Win Rate       — % of days with eod_pnl > 0 (only counts days that
 *                            traded; zero-trade days are excluded)
 *   3. Trade Win Rate     — sum(trade_wins) / sum(trades_with_pnl_count)
 *   4. Trade management   — the period's trades sorted into went-your-way /
 *                            never-got-going, pooled from per-day SUMS
 */

/** Minimal day-stat shape needed for the cards. Avoids depending on the full
 *  DayRowData (which carries the unused setups list / bars-derived stuff). */
export interface DayStat {
  date: string                       // YYYY-MM-DD
  eod_pnl: number | null
  trade_wins: number
  trades_with_pnl_count: number
  /** Realized-R sums for the payoff ratio. Optional so a day whose stats_json
   *  predates STATS_VERSION 5 still types — those recompute on read, but the
   *  page must not fall over while they do. */
  sum_win_r?: number
  win_r_count?: number
  sum_loss_r?: number
  loss_r_count?: number
  r_sample?: number
  avg_mfe_pts: number | null
  avg_mae_pts: number | null
  avg_mfe_dollars: number | null
  avg_mae_dollars: number | null
  /** Mean MFE capture (0..1) — realized PnL / peak favorable. Positions the
   *  exit marker on the excursion bar; null hides it. */
  avg_capture: number | null
  /** Trade-management sums for the day (src/lib/trade-management.ts). Optional
   *  so a row cached before STATS_VERSION 9 still types while it recomputes. */
  mgmt?: MgmtTotals | null
  /** Prep-time ATR (market_context.atr_1m) — fallback ATR ref when live bars
   *  are missing for the day. */
  atr_1m: number | null
  /** Per-trade live ATR-10 averaged across the day's trades. Preferred ATR
   *  ref over prep_atr when present. */
  avg_live_atr_1m: number | null
  /** Prep AI's 1-10 quality score (column is `process_score` for legacy
   *  storage-layer reasons; the user-facing label is "Prep"). */
  process_score: number | null
  /** v1.4 Process verdict-derived 0-10 score = Math.round(passCount/5*10).
   *  Null on days where the EOD AI hasn't run, or on legacy pre-v1.4 rows
   *  where the dashboard reader couldn't compute it. */
  process_v13_score: number | null
  /** Execution composite scaled to 0-10. Same value rendered in the
   *  Recent Days table's "Execution" column. */
  overall_grade: number | null
  /** Process verdict — kept for the charts' trend series. */
  process_verdict: 'Compliant' | 'Breach' | null
  /** One TapeScore — derived server-side (src/lib/tapescore.ts). Null when
   *  the day has no EOD analysis (any rubric). */
  tapescore: TapeScoreResult | null
  /** The day's per-trade sums + counts (src/lib/exit-rollup.ts). A period's
   *  axes pool these over its trades — never a mean of daily values. */
  trade_sums?: TradeSums | null
}

export type Period = 'all' | 'week' | 'month' | '30d' | 'ytd' | 'last_year'
// The trader's saved period sticks across visits — a preference, respected on
// load. (An earlier v2 bump force-reset everyone to all-time; reverted, because
// keeping your chosen period is the point of persisting it.)
const PERIOD_KEY = 'dashboard-stat-period-v1'

export const PERIOD_LABELS: Record<Period, string> = {
  all: 'All time',
  week: 'This Week',
  month: 'This Month',
  '30d': 'Last 30 Days',
  ytd: 'Year to Date',
  last_year: 'Last Year',
}

/** Inclusive date bounds (YYYY-MM-DD strings) for each period, computed
 *  relative to "today" on the client (cheap; no need for server input). */
export function periodBounds(period: Period): { start: string; end: string } {
  const now = new Date()
  const today = ymd(now)
  switch (period) {
    case 'all': {
      // Everything the page shipped. The overview widens its server window to
      // all history, so this bound just has to reach past the earliest day.
      return { start: '2000-01-01', end: today }
    }
    case 'week': {
      // Monday → today (matches ISO week start; most traders think Mon-Fri).
      const day = now.getDay() // 0=Sun .. 6=Sat
      const daysSinceMon = (day + 6) % 7
      const start = new Date(now)
      start.setDate(now.getDate() - daysSinceMon)
      return { start: ymd(start), end: today }
    }
    case 'month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { start: ymd(start), end: today }
    }
    case '30d': {
      const start = new Date(now)
      start.setDate(now.getDate() - 30)
      return { start: ymd(start), end: today }
    }
    case 'ytd': {
      const start = new Date(now.getFullYear(), 0, 1)
      return { start: ymd(start), end: today }
    }
    case 'last_year': {
      const year = now.getFullYear() - 1
      return { start: `${year}-01-01`, end: `${year}-12-31` }
    }
  }
}

/** "Jun 22 – Oct 13", with years only when the span crosses one. */
function dateSpan(from: string, to: string): string {
  const fmt = (iso: string, year: boolean) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
  const cross = from.slice(0, 4) !== to.slice(0, 4)
  return `${fmt(from, cross)} – ${fmt(to, cross)}`
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]
}

interface Props {
  /** Server-fetched DayStat list spanning start-of-last-year → today. */
  days: DayStat[]
  /** Drop the internal TapeScore ring hero. Set on the Review overview, where
   *  the composition-ring score cluster already owns the score — two rings
   *  would be redundant. The period stat cards still render. */
  hideScoreHero?: boolean
  /** Starting period before the user's saved preference loads. The overview
   *  passes 'all' so a first visit shows the full-history total, then the
   *  saved choice (if any) takes over. */
  defaultPeriod?: Period
  /** Set while a dashboard filter is active. The filter already bounded `days`
   *  to its own range, so the period picker is replaced by this label and every
   *  passed day counts. Without it a saved "Last 30 Days" preference would
   *  silently clip a 3-month filter to 30 days — wrong numbers under a banner
   *  that promised three months. The saved preference itself is left alone. */
  rangeLabel?: string
  /** Put the TapeScore in the stat row as the first of three cards, on the
   *  same Period as everything else. Set while the dashboard's top band (the
   *  score + the finding) is hidden — see SHOW_FINDING_CALLOUT. */
  scoreInRow?: boolean
  /** What lifts and drags the profit factor, per scope ("p:30d", "r:3m") —
   *  src/lib/lift-drag.ts. Shown under Net per trade in Trade management. */
  liftDrag?: Record<string, LiftDragView | null>
  /** Which scope to show. Undefined → the Period menu's; null → hide it (a
   *  setup filter is on, and the read is about the whole book). */
  liftDragScope?: string | null
  /** Set by a parent that owns the period for the whole page (Highlights' one
   *  time switch drives these cards, the chart and the session list). The
   *  Period menu is hidden and the saved Detailed preference is left alone. */
  period?: Period
}

export default function DashboardStats({ days, hideScoreHero = false, defaultPeriod = '30d', rangeLabel, scoreInRow = false, liftDrag, liftDragScope, period: controlledPeriod }: Props) {
  const [periodState, setPeriod] = useState<Period>(controlledPeriod ?? defaultPeriod)
  const period: Period = controlledPeriod ?? periodState
  const effectivePeriod: Period = rangeLabel ? 'all' : period
  // Hydrate from localStorage after mount so SSR matches initial render.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (controlledPeriod) return
    try {
      const rawPeriod = localStorage.getItem(PERIOD_KEY) as Period | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (rawPeriod && rawPeriod in PERIOD_LABELS) setPeriod(rawPeriod)
    } catch { /* ignore */ }
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only hydration
  }, [])
  useEffect(() => {
    if (!hydrated || controlledPeriod) return
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* ignore */ }
  }, [period, hydrated, controlledPeriod])

  const stats = useMemo(() => {
    const { start, end } = periodBounds(effectivePeriod)
    const inPeriod = days.filter(d => d.date >= start && d.date <= end)

    // P&L sum (skip null PnL days = no trades + no override)
    const pnl = inPeriod.reduce((s, d) => s + (d.eod_pnl ?? 0), 0)

    // Day win rate: % of TRADED days where pnl > 0. Days with no trades and no
    // explicit eod_pnl override are excluded so the denominator reflects
    // actual sessions.
    const tradedDays = inPeriod.filter(d => d.eod_pnl != null)
    const winDays = tradedDays.filter(d => (d.eod_pnl ?? 0) > 0).length
    const dayWinRate = tradedDays.length > 0 ? winDays / tradedDays.length : null

    // Trade win rate: pooled across the period.
    const totalTradeWins = inPeriod.reduce((s, d) => s + d.trade_wins, 0)
    const totalTradesWithPnl = inPeriod.reduce((s, d) => s + d.trades_with_pnl_count, 0)
    const tradeWinRate = totalTradesWithPnl > 0 ? totalTradeWins / totalTradesWithPnl : null

    // Payoff ratio = average winner / average loser, both in R, pooled over the
    // period from per-day SUMS so a one-trade day doesn't count as much as a
    // ten-trade one.
    //
    // R rather than dollars, deliberately. Avg win $ / avg loss $ largely
    // measures how big the position was, not how well it was traded — size one
    // loser up and the ratio follows the sizing. Measured on this book over 30
    // days the two disagree by a wide margin (3.18 in R against 2.58 in $), and
    // the R figure is the one describing the trading.
    const sumWinR = inPeriod.reduce((s, d) => s + (d.sum_win_r ?? 0), 0)
    const winRCount = inPeriod.reduce((s, d) => s + (d.win_r_count ?? 0), 0)
    const sumLossR = inPeriod.reduce((s, d) => s + (d.sum_loss_r ?? 0), 0)
    const lossRCount = inPeriod.reduce((s, d) => s + (d.loss_r_count ?? 0), 0)
    const rSample = inPeriod.reduce((s, d) => s + (d.r_sample ?? 0), 0)
    const avgWinR = winRCount > 0 ? sumWinR / winRCount : null
    const avgLossR = lossRCount > 0 ? sumLossR / lossRCount : null
    const payoffR = avgWinR != null && avgLossR != null && avgLossR > 0 ? avgWinR / avgLossR : null
    // What the payoff has to clear at this win rate just to break even:
    // (1 - w) / w. Computed from the number printed beside it, so it can never
    // go stale the way a configured target would — and it answers the only
    // question a payoff figure raises on its own, which is "is that enough?".
    const breakEvenPayoff =
      tradeWinRate != null && tradeWinRate > 0 && tradeWinRate < 1
        ? (1 - tradeWinRate) / tradeWinRate
        : null

    // Trade management: pooled over the period's TRADES by adding each day's
    // sums — never an average of daily averages, which weighted a one-trade
    // day the same as a seven-trade one.
    const mgmt = mergeMgmtTotals(inPeriod.map(d => d.mgmt))

    // Median Prep (prep AI 1-10) and Median Process (v1.4 verdict-derived
    // 0-10). Two separate medians on the same stat card — see render block.
    // Median preferred over mean to suppress outliers.
    const prepScores = inPeriod.map(d => d.process_score).filter((v): v is number => v != null)
    const medianPrep = median(prepScores)
    const v13Scores = inPeriod.map(d => d.process_v13_score).filter((v): v is number => v != null)
    const medianProcessV13 = median(v13Scores)

    // One TapeScore hero aggregate (amendment 5): mean day score over scored
    // days + component means + rules-kept ratio. Replaces the old Execution /
    // Compliance stat card — those two dimensions now read as hero chips.
    const tapePeriod = aggregateTapeScore(inPeriod)

    return {
      pnl,
      dayWinRate,
      tradeWinRate,
      payoffR,
      breakEvenPayoff,
      rSample,
      mgmt,
      medianProcess: medianPrep,    // legacy field name preserved for callers
      medianProcessV13,
      tapePeriod,
      tradedDaysCount: tradedDays.length,
      totalTradesWithPnl,
      procCount: prepScores.length,
      v13Count: v13Scores.length,
    }
  }, [days, effectivePeriod])

  // Profit factor, lifter and drag for the scope on screen. A period shorter
  // than 60 sessions is read over the last 60, and the label says so.
  const liftDragView = liftDragScope === null ? null : liftDrag?.[liftDragScope ?? `p:${period}`] ?? null
  const profitFactor = liftDragView
    ? {
        view: liftDragView,
        window: liftDragView.extended
          ? `last ${liftDragView.sessions} sessions, ${dateSpan(liftDragView.from, liftDragView.to)}`
          : `${(rangeLabel ?? PERIOD_LABELS[period]).toLowerCase()}, ${liftDragView.sessions} sessions`,
      }
    : null

  // The three stat tiles, built once and placed by whichever layout renders
  // below. `bare` drops a tile's own border when it sits inside a shared card.
  const pnlCard = ({ className, bare }: { className?: string; bare?: boolean } = {}) => (
    <StatCard
      className={className}
      bare={bare}
      label={`${PERIOD_LABELS[period]} P&L`}
      value={(() => {
        // Sign before the dollar: "+$1,395" / "-$1,395" / "$0".
        // Previously was "$+1,395" — the sign-after-currency reads as
        // a typo on first scan.
        const abs = Math.abs(stats.pnl).toLocaleString('en-US', { maximumFractionDigits: 0 })
        if (stats.pnl > 0) return `+$${abs}`
        if (stats.pnl < 0) return `-$${abs}`
        return '$0'
      })()}
      tone={stats.pnl > 0 ? 'positive' : stats.pnl < 0 ? 'negative' : 'neutral'}
      sub={`${stats.tradedDaysCount} trading day${stats.tradedDaysCount === 1 ? '' : 's'}`}
    />
  )
  const dayWinCard = ({ className, bare }: { className?: string; bare?: boolean } = {}) => (
    <StatCard
      className={className}
      bare={bare}
      label="Day Win %"
      value={stats.dayWinRate == null ? '—' : `${(stats.dayWinRate * 100).toFixed(0)}%`}
      // Win rate is colored by meaning, not <50%: gentle green only when
      // genuinely strong, otherwise neutral. Never red — P&L carries the
      // honest good/bad signal, so a low win rate on a green stretch (a
      // valid high-R style) shouldn't read as alarm. (docs/DESIGN_SYSTEM.md)
      tone={stats.dayWinRate == null ? 'neutral' : stats.dayWinRate >= 0.6 ? 'positive' : 'neutral'}
      sub="% of days green"
    />
  )
  // Win rate is half a metric on its own. At a 31% win rate you need better
  // than 2.2:1 just to break even, so a bare "31%" next to a green P&L is a
  // contradiction the reader has to resolve unaided — the number that resolves
  // it is the payoff, and it belongs in the same tile rather than in another.
  const tradeWinCard = ({ className, bare }: { className?: string; bare?: boolean } = {}) => (
    <StatCard
      className={className}
      bare={bare}
      label={stats.payoffR == null ? 'Trade Win %' : 'Trade Win % · Payoff'}
      title={`Win rate, and how much bigger the average winner is than the average loser (in R, so position sizing doesn't distort it). At a 31% win rate you lose roughly two trades for every one you win, so each winner has to be worth about 2.2 losers just to come out flat — that break-even figure is computed from the win rate beside it and moves as the win rate does. Win rate counts ${stats.totalTradesWithPnl} trade${stats.totalTradesWithPnl === 1 ? '' : 's'}; payoff counts the ${stats.rSample} with a stop logged.`}
      value={stats.tradeWinRate == null ? '—' : `${(stats.tradeWinRate * 100).toFixed(0)}%`}
      // Never red (see Day Win %): 38% trade win on a profitable stretch is
      // fine for a high-R approach. Neutral by default, green only when strong.
      tone={stats.tradeWinRate == null ? 'neutral' : stats.tradeWinRate >= 0.6 ? 'positive' : 'neutral'}
      valueNode={stats.payoffR == null ? undefined : (
        <span className="flex items-baseline justify-center gap-2 flex-wrap">
          <span>{stats.tradeWinRate == null ? '—' : `${(stats.tradeWinRate * 100).toFixed(0)}%`}</span>
          <span className="text-gray-600 text-lg font-normal">·</span>
          <span className={stats.breakEvenPayoff != null && stats.payoffR > stats.breakEvenPayoff ? 'text-green-400' : 'text-gray-200'}>
            {stats.payoffR.toFixed(1)}<span className="text-sm font-semibold text-gray-400">R : 1R</span>
          </span>
        </span>
      )}
      sub={`${stats.totalTradesWithPnl} trade${stats.totalTradesWithPnl === 1 ? '' : 's'}`}
      subNode={stats.payoffR != null && stats.breakEvenPayoff != null ? (
        <div className="text-[11px] text-gray-500">
          {/* The trade counts moved to the tooltip — the tile reads as one
              sentence without them. They stay visible only when the payoff
              rests on a minority of the trades (few stops logged), where a
              bare ratio would pass a thin sample off as the whole book. */}
          {stats.rSample * 2 < stats.totalTradesWithPnl && (
            <div className="mb-1">payoff from {stats.rSample} of {stats.totalTradesWithPnl} trades</div>
          )}
          {/* Say what the number IS, not where it sits. "break-even: 2.24"
              asks the reader to work out whose break-even, measured in what.
              This states the requirement in the same unit as the payoff
              directly above it, so the pair reads as one sentence: you win
              31% of the time, that demands 2.24R, you are making 3.2R.

              Kept short enough to sit on ONE line in a five-across tile on
              a 1280px laptop (179px of the 195 available) — the longer
              "needs 2.24R to break even — you're above" wrapped there, and
              two lines under the number read as clutter. */}
          <div className="xl:whitespace-nowrap">
            break even at <span className="text-gray-300">{stats.breakEvenPayoff.toFixed(2)}R</span>
            {stats.payoffR > stats.breakEvenPayoff
              ? <span className="text-green-500"> — you&rsquo;re above</span>
              : <span className="text-amber-400"> — you&rsquo;re below</span>}
          </div>
        </div>
      ) : undefined}
    />
  )

  return (
    <div className="mb-6">
      {/* Period selector — absent when a parent owns the period. */}
      {!controlledPeriod && (
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-gray-500">Period:</label>
        {rangeLabel ? (
          <span className="text-xs text-gray-300">{rangeLabel}</span>
        ) : (
        <div className="relative">
          <select
            value={period}
            onChange={e => setPeriod(e.target.value as Period)}
            className="appearance-none bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-md pl-2 pr-7 py-1 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            {Object.entries(PERIOD_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
        </div>
        )}
      </div>
      )}

      {/* One TapeScore hero (Ruleset amendment 6): the report card before the
          ledger. Score ring + verdict sentence + axis chips; P&L lives in the
          card row below. Suppressed on Review · Month, where the composition
          ring already owns the score. */}
      {!hideScoreHero && <TapeScoreHero period={stats.tapePeriod} periodLabel={PERIOD_LABELS[period]} />}

      {scoreInRow ? (
        /* Three cards (founder's pick, 2026-10-13), everything on the Period
           menu above: decision quality (the TapeScore, with the trade win rate
           and payoff under it), results (P&L, with the day win rate under it),
           and trade management. Replaces the separate score band, which left
           most of its width empty once the finding beside it was hidden. The
           bottom halves share a height so their dividers line up. */
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,2fr)]">
          <div className="min-w-0 border border-gray-800 rounded-[3px] flex flex-col">
            <div className="flex-1 p-[18px] flex flex-col justify-center gap-2.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[15px] font-bold tracking-tight text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
                  TapeScore
                </span>
                <span className="text-[11px] text-gray-500">· {(rangeLabel ?? PERIOD_LABELS[period]).toLowerCase()}</span>
                <ScoreBreakdownInfo period={stats.tapePeriod} />
              </div>
              <div className="flex justify-center">
                <ScoreCluster period={stats.tapePeriod} size={128} />
              </div>
            </div>
            {tradeWinCard({ bare: true, className: 'border-t border-gray-800 min-h-[104px]' })}
          </div>
          <div className="min-w-0 border border-gray-800 rounded-[3px] flex flex-col">
            {pnlCard({ bare: true, className: 'flex-1' })}
            {dayWinCard({ bare: true, className: 'border-t border-gray-800 min-h-[104px]' })}
          </div>
          <TradeManagementCard
            totals={stats.mgmt}
            profitFactor={profitFactor}
            className="min-w-0 sm:col-span-2 xl:col-span-1 border border-gray-800 rounded-[3px] p-[18px]"
          />
        </div>
      ) : (
      /* Stat cards. Order: P&L → Day Win % → Trade Win % → Trade management
         (double width: it carries two rows of bars).
         The old Execution / Compliance card folded into the hero chips. */
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        {pnlCard()}
        {dayWinCard()}
        {tradeWinCard({ className: 'col-span-2 lg:col-span-1' })}
        <TradeManagementCard
          totals={stats.mgmt}
          profitFactor={profitFactor}
          className="col-span-2 border border-gray-800 rounded-[3px] p-[18px]"
        />
      </div>
      )}
    </div>
  )
}

/** The One-TapeScore dashboard hero: 0-100 ring, plain-language verdict, and
 *  the three axis chips (Risk kept / Entry / Exit). */
function TapeScoreHero({ period, periodLabel }: {
  period: ReturnType<typeof aggregateTapeScore>
  periodLabel: string
}) {
  const { score, band, scoredDays, verdictDays, compliantDays, risk, entry, exit, parts } = period
  const sentence = tapeScorePeriodSentence(period)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3 sm:mb-4 flex items-center gap-5 flex-wrap">
      <TapeScoreRing
        score={score}
        band={band}
        title="TapeScore — one 0-100 score per day: risk, entry and exit, weighted equally. Days that broke the rules or the daily loss limit cap at 49; 2 or more chase trades (quick re-entries after a loss with no fresh trigger) cap a day at 69."
      />
      <div className="flex-1 min-w-[240px]">
        {score != null ? (
          <>
            <div className="flex items-center gap-1.5">
              <p className="text-white font-semibold text-[15px]">{sentence}</p>
              <TapeScoreFormulaInfo />
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {periodLabel} · {scoredDays} scored session{scoredDays === 1 ? '' : 's'}
            </p>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {risk != null && (
                <HeroChip
                  label={`Risk ${risk}`}
                  tone={risk >= 70 ? 'good' : risk >= 50 ? 'mid' : 'bad'}
                  title={axisTooltip(`Risk (0-100), over the period: ${AXIS_DESC.risk}. ${compliantDays} of ${verdictDays} sessions kept the rules.`, parts, 'risk')}
                />
              )}
              {entry != null && (
                <HeroChip
                  label={`Entry ${entry}`}
                  tone={entry >= 70 ? 'good' : entry >= 50 ? 'mid' : 'bad'}
                  title={axisTooltip(`Entry (0-100), over the period: ${AXIS_DESC.entry}.`, parts, 'entry')}
                />
              )}
              {exit != null && (
                <HeroChip
                  label={`Exit ${exit}`}
                  tone={exit >= 70 ? 'good' : exit >= 50 ? 'mid' : 'bad'}
                  title={axisTooltip(`Exit (0-100), over the period's trades: ${AXIS_DESC.exit}.`, parts, 'exit')}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-gray-400 font-medium text-[15px]">No scored sessions in this period.</p>
            <p className="text-xs text-gray-600 mt-0.5">Run &ldquo;Analyze Session&rdquo; on a day&apos;s EOD recap to grade it.</p>
          </>
        )}
      </div>
    </div>
  )
}

function StatCard({
  label, value, valueNode, tone, sub, subNode, valueClass, chartNode, title, className, bare = false,
}: {
  /** Extra grid classes for the tile (e.g. a mobile column span). */
  className?: string
  /** No border of its own — the tile is one half of a shared card. */
  bare?: boolean
  label: string
  value: string
  /** Rich value line, for a tile whose headline is more than one figure (the
   *  win-rate tile pairs a percentage with a payoff ratio). Wins over `value`.
   *  The plain string stays the common path — most tiles are one number. */
  valueNode?: React.ReactNode
  tone: 'positive' | 'negative' | 'neutral'
  sub?: string
  /** Rich subline (e.g. an inline <select>). Wins over `sub` when both set. */
  subNode?: React.ReactNode
  valueClass?: string
  /** Optional visual under the value (e.g. the excursion bar). */
  chartNode?: React.ReactNode
  /** Native hover tooltip on the whole tile — used to explain a metric the
   *  compact label can't (e.g. that MFE is offered, not kept). */
  title?: string
}) {
  const valueColor =
    tone === 'positive' ? 'text-green-400'
    : tone === 'negative' ? 'text-red-400'
    : 'text-gray-300'
  // Blend-in container: no fill, hairline rule, squared corners. The filled
  // rounded card read as generic template chrome; dropping the fill lets the
  // tile sit ON the page instead of floating above it, and the near-square
  // corner reads instrument rather than app-card.
  // Centred both ways, because in the five-across row these tiles stretch to the
  // height of the Trade management card beside them: top-left, a small number
  // sat in the corner of an empty box. The value grows with the tile — today's 20px on a phone or a
  // narrow row, 26px once the row is wide — and stops there, so P&L never
  // out-shouts the score above it.
  const valueSize = valueClass ?? 'text-[length:clamp(1.25rem,2vw,1.625rem)] leading-tight'
  return (
    <div className={`${bare ? '' : 'border border-gray-800 rounded-[3px] '}p-[18px] flex flex-col justify-center items-center text-center ${className ?? ''}`} title={title}>
      <p className="text-xs text-gray-500 mb-1 whitespace-nowrap">{label}</p>
      {/* Blank value is intentional (e.g. the MFE tile, whose numbers live at the
          bar ends) — skip the line entirely so it doesn't leave an empty gap. */}
      {valueNode ? (
        <p className={`font-bold ${valueColor} ${valueSize}`}>{valueNode}</p>
      ) : value !== '' && (
        <p className={`font-bold ${valueColor} ${valueSize} whitespace-nowrap`}>{value}</p>
      )}
      {chartNode}
      {subNode ? <div className="mt-1">{subNode}</div> : sub ? <p className="text-[11px] text-gray-600 mt-1 whitespace-nowrap">{sub}</p> : null}
    </div>
  )
}


