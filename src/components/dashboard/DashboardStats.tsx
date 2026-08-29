'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { aggregateTapeScore, tapeScorePeriodSentence, type TapeScoreResult } from '@/lib/tapescore'
import { TapeScoreRing, HeroChip, TapeScoreFormulaInfo } from './TapeScoreHeroParts'

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
 *   4. Avg MFE/MAE        — averaged across days that have those stats
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
}

type MfeUnit = 'pts' | 'dollars' | 'atr'
const UNIT_KEY = 'dashboard-stat-mfe-unit-v1'

type Period = 'all' | 'week' | 'month' | '30d' | 'ytd' | 'last_year'
// The trader's saved period sticks across visits — a preference, respected on
// load. (An earlier v2 bump force-reset everyone to all-time; reverted, because
// keeping your chosen period is the point of persisting it.)
const PERIOD_KEY = 'dashboard-stat-period-v1'

const PERIOD_LABELS: Record<Period, string> = {
  all: 'All time',
  week: 'This Week',
  month: 'This Month',
  '30d': 'Last 30 Days',
  ytd: 'Year to Date',
  last_year: 'Last Year',
}

/** Inclusive date bounds (YYYY-MM-DD strings) for each period, computed
 *  relative to "today" on the client (cheap; no need for server input). */
function periodBounds(period: Period): { start: string; end: string } {
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
}

export default function DashboardStats({ days, hideScoreHero = false, defaultPeriod = '30d' }: Props) {
  const [period, setPeriod] = useState<Period>(defaultPeriod)
  // Default unit is ATR — it's the user's preferred ATR-normalized reading
  // for the MFE/MAE roll-up. localStorage hydration may overwrite below.
  const [mfeUnit, setMfeUnit] = useState<MfeUnit>('atr')
  // Hydrate from localStorage after mount so SSR matches initial render.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    try {
      const rawPeriod = localStorage.getItem(PERIOD_KEY) as Period | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (rawPeriod && rawPeriod in PERIOD_LABELS) setPeriod(rawPeriod)
      const rawUnit = localStorage.getItem(UNIT_KEY) as MfeUnit | null
      if (rawUnit === 'pts' || rawUnit === 'dollars' || rawUnit === 'atr') setMfeUnit(rawUnit)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* ignore */ }
  }, [period, hydrated])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(UNIT_KEY, mfeUnit) } catch { /* ignore */ }
  }, [mfeUnit, hydrated])

  const stats = useMemo(() => {
    const { start, end } = periodBounds(period)
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

    // Avg MFE/MAE: averaged across days that have stats. Each day's value is
    // already a per-day average across that day's trades — averaging across
    // days gives equal weight per day (matches "what's a typical day look
    // like for me" framing).
    //
    // Per-unit computation:
    //   - pts: average of avg_mfe_pts / avg_mae_pts directly
    //   - dollars: average of avg_mfe_dollars / avg_mae_dollars (computed
    //     server-side with the contract multiplier × qty applied per trade)
    //   - atr: divide each day's pts MFE/MAE by that day's ATR ref
    //     (avg_live_atr_1m ?? atr_1m) then average — matches the Recent Days
    //     table's MfeMaeCell behavior so the dashboard rollup is consistent.
    let avgMfe: number | null = null
    let avgMae: number | null = null
    if (mfeUnit === 'pts') {
      const mfeVals = inPeriod.map(d => d.avg_mfe_pts).filter((v): v is number => v != null)
      const maeVals = inPeriod.map(d => d.avg_mae_pts).filter((v): v is number => v != null)
      avgMfe = mfeVals.length > 0 ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : null
      avgMae = maeVals.length > 0 ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : null
    } else if (mfeUnit === 'dollars') {
      const mfeVals = inPeriod.map(d => d.avg_mfe_dollars).filter((v): v is number => v != null)
      const maeVals = inPeriod.map(d => d.avg_mae_dollars).filter((v): v is number => v != null)
      avgMfe = mfeVals.length > 0 ? mfeVals.reduce((a, b) => a + b, 0) / mfeVals.length : null
      avgMae = maeVals.length > 0 ? maeVals.reduce((a, b) => a + b, 0) / maeVals.length : null
    } else {
      // atr
      const mfeAtr: number[] = []
      const maeAtr: number[] = []
      for (const d of inPeriod) {
        const atrRef = d.avg_live_atr_1m ?? d.atr_1m
        if (!atrRef || atrRef <= 0) continue
        if (d.avg_mfe_pts != null) mfeAtr.push(d.avg_mfe_pts / atrRef)
        if (d.avg_mae_pts != null) maeAtr.push(d.avg_mae_pts / atrRef)
      }
      avgMfe = mfeAtr.length > 0 ? mfeAtr.reduce((a, b) => a + b, 0) / mfeAtr.length : null
      avgMae = maeAtr.length > 0 ? maeAtr.reduce((a, b) => a + b, 0) / maeAtr.length : null
    }

    // Mean MFE capture across days that have it — positions the exit marker on
    // the excursion bar. Same [0,1] guard formatCapturePct uses, so a day with
    // a unit-mismatched ratio can't drag the marker off the scale.
    const capVals = inPeriod
      .map(d => d.avg_capture)
      .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0 && v <= 1.0001)
    const avgCapture = capVals.length > 0 ? capVals.reduce((a, b) => a + b, 0) / capVals.length : null

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
    const tapePeriod = aggregateTapeScore(inPeriod.map(d => d.tapescore))

    return {
      pnl,
      dayWinRate,
      tradeWinRate,
      payoffR,
      breakEvenPayoff,
      rSample,
      avgMfe,
      avgMae,
      avgCapture,
      medianProcess: medianPrep,    // legacy field name preserved for callers
      medianProcessV13,
      tapePeriod,
      tradedDaysCount: tradedDays.length,
      totalTradesWithPnl,
      procCount: prepScores.length,
      v13Count: v13Scores.length,
    }
  }, [days, period, mfeUnit])

  return (
    <div className="mb-6">
      {/* Period selector */}
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-gray-500">Period:</label>
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
      </div>

      {/* One TapeScore hero (Ruleset amendment 6): the report card before the
          ledger. Score ring + verdict sentence + axis chips; P&L lives in the
          card row below. Suppressed on Review · Month, where the composition
          ring already owns the score. */}
      {!hideScoreHero && <TapeScoreHero period={stats.tapePeriod} periodLabel={PERIOD_LABELS[period]} />}

      {/* Stat cards. Order: P&L → Day Win % → Trade Win % → Avg MFE/MAE.
          The old Execution / Compliance card folded into the hero chips. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label={`${PERIOD_LABELS[period]} P&L`}
          value={(() => {
            // Sign before the dollar: "+$1,395" / "-$1,395" / "$0".
            // Previously was "$+1,395" — the sign-after-currency reads as
            // a typo on first scan.
            const abs = Math.abs(stats.pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })
            if (stats.pnl > 0) return `+$${abs}`
            if (stats.pnl < 0) return `-$${abs}`
            return '$0'
          })()}
          tone={stats.pnl > 0 ? 'positive' : stats.pnl < 0 ? 'negative' : 'neutral'}
          sub={`${stats.tradedDaysCount} trading day${stats.tradedDaysCount === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Day Win %"
          value={stats.dayWinRate == null ? '—' : `${(stats.dayWinRate * 100).toFixed(0)}%`}
          // Win rate is colored by meaning, not <50%: gentle green only when
          // genuinely strong, otherwise neutral. Never red — P&L carries the
          // honest good/bad signal, so a low win rate on a green stretch (a
          // valid high-R style) shouldn't read as alarm. (docs/DESIGN_SYSTEM.md)
          tone={stats.dayWinRate == null ? 'neutral' : stats.dayWinRate >= 0.6 ? 'positive' : 'neutral'}
          sub="% of days green"
        />
        {/* Win rate is half a metric on its own. At a 31% win rate you need
            better than 2.2:1 just to break even, so a bare "31%" next to a green
            P&L is a contradiction the reader has to resolve unaided — the number
            that resolves it is the payoff, and it belongs in the same card
            rather than in a fifth one. */}
        <StatCard
          label={stats.payoffR == null ? 'Trade Win %' : 'Trade Win % · Payoff'}
          title="Win rate, and how much bigger the average winner is than the average loser (in R, so position sizing doesn't distort it). Break-even is what the payoff must clear at this win rate to come out flat."
          value={stats.tradeWinRate == null ? '—' : `${(stats.tradeWinRate * 100).toFixed(0)}%`}
          // Never red (see Day Win %): 38% trade win on a profitable stretch is
          // fine for a high-R approach. Neutral by default, green only when strong.
          tone={stats.tradeWinRate == null ? 'neutral' : stats.tradeWinRate >= 0.6 ? 'positive' : 'neutral'}
          valueNode={stats.payoffR == null ? undefined : (
            <span className="flex items-baseline gap-2 flex-wrap">
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
              {stats.totalTradesWithPnl} trade{stats.totalTradesWithPnl === 1 ? '' : 's'}
              {stats.rSample < stats.totalTradesWithPnl ? ` · ${stats.rSample} with a stop` : ''}
              <div className="mt-1 pt-1 border-t border-gray-800">
                break-even here: <span className="text-gray-300">{stats.breakEvenPayoff.toFixed(2)}</span>
                {stats.payoffR > stats.breakEvenPayoff
                  ? <span className="text-green-500"> — above it</span>
                  : <span className="text-amber-400"> — below it</span>}
              </div>
            </div>
          ) : undefined}
        />
        <StatCard
          label="Avg MFE / MAE"
          title="Average trade: the +MFE (green) is how far it reached in your favor at its peak — what the move OFFERED, not what you kept. The −MAE (red) is the heat against you. 'Kept' is the share of that favorable move you actually banked, across all trades (favorable moves given back on losers count as 0)."
          // Value line is intentionally blank when there's data: the −MAE / +MFE
          // numbers sit at the ENDS of the excursion bar below (worst point ↔
          // best point), so +MFE reads as the range it describes, not a gain.
          // Falls back to "—" only when there's nothing to draw.
          value={stats.avgMfe == null || stats.avgMae == null ? '—' : ''}
          tone="neutral"
          chartNode={
            stats.avgMfe != null && stats.avgMae != null
              ? <ExcursionBar
                  mfe={stats.avgMfe} mae={stats.avgMae} capture={stats.avgCapture}
                  maeLabel={fmtEx(stats.avgMae, '-', mfeUnit)}
                  mfeLabel={fmtEx(stats.avgMfe, '+', mfeUnit)}
                  // kept amount in the ACTIVE unit = avg MFE × capture (the $/pt/×ATR
                  // the "kept %" actually represents), matching the end-cap units.
                  keptLabel={stats.avgCapture != null
                    ? fmtEx(stats.avgMfe * Math.max(0, Math.min(1, stats.avgCapture)), '', mfeUnit)
                    : null}
                />
              : null
          }
          // Sub becomes the unit selector itself. Compact inline dropdown
          // replaces the static "pts per trade" string so the card surfaces
          // the choice in the same visual slot.
          subNode={
            <select
              value={mfeUnit}
              onChange={e => setMfeUnit(e.target.value as MfeUnit)}
              className="bg-gray-800 border border-gray-700 text-gray-400 text-[10px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight"
              title="Display unit for Avg MFE / MAE"
            >
              <option value="pts">pts per trade</option>
              <option value="dollars">$ per trade</option>
              <option value="atr">× ATR per trade</option>
            </select>
          }
        />
      </div>
    </div>
  )
}

/** The One-TapeScore dashboard hero: 0-100 ring, plain-language verdict, and
 *  the three axis chips (Risk kept / Entry / Capture). */
function TapeScoreHero({ period, periodLabel }: {
  period: ReturnType<typeof aggregateTapeScore>
  periodLabel: string
}) {
  const { score, band, scoredDays, verdictDays, compliantDays, entry, capture } = period
  const sentence = tapeScorePeriodSentence(period)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3 sm:mb-4 flex items-center gap-5 flex-wrap">
      <TapeScoreRing
        score={score}
        band={band}
        title="TapeScore — one 0-100 score per day: risk, entry and exit, weighted equally. Days that broke 2+ risk rails cap at 49."
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
              {verdictDays > 0 && (
                <HeroChip
                  label={`Risk limits ${compliantDays}/${verdictDays}`}
                  tone={compliantDays / verdictDays >= 0.85 ? 'good' : compliantDays / verdictDays >= 0.6 ? 'mid' : 'bad'}
                  title="Sessions that kept at least 4 of the 5 account risk rails, out of sessions with a rails audit. These rails are guardrails, not a measure of trade quality."
                />
              )}
              {entry != null && (
                <HeroChip
                  label={`Entry ${entry}`}
                  tone={entry >= 70 ? 'good' : entry >= 50 ? 'mid' : 'bad'}
                  title="Average entry quality (0-100): entry/stop/target parameters, prep adherence, profit factor — capture is scored separately"
                />
              )}
              {capture != null && (
                <HeroChip
                  label={`Exit ${capture}`}
                  tone={capture >= 70 ? 'good' : capture >= 50 ? 'mid' : 'bad'}
                  title="Average exit / profit capture (0-100): how much of the favorable move you kept — MFE captured"
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

/**
 * The average trade's excursion on one axis — heat, run, and where you left.
 *
 * MFE and MAE are a RANGE around the entry, so they're drawn as one: the tick
 * is the entry, left of it is the heat you sat through (MAE), right of it is
 * how far the trade ran your way (MFE). The solid fill is what you actually
 * kept (mean capture); the faint remainder to its right is what you gave back.
 * Shared scale, so the tick sits at MAE/(MAE+MFE) — the shape itself reads as
 * "took a lot of heat" or "left most of it on the table" without a legend.
 *
 * Unit-agnostic: pts, dollars and ATR all produce the same proportions, so it
 * tracks whatever unit the card is showing.
 */
/** Format one excursion magnitude in the active unit, with an optional explicit
 *  sign — '+'/'-' for the bar's worst-point / best-point end-caps, '' for the
 *  unsigned "kept" amount. */
function fmtEx(v: number, sign: '+' | '-' | '', unit: MfeUnit): string {
  if (unit === 'dollars') return `${sign}$${Math.round(v).toLocaleString()}`
  if (unit === 'atr') return `${sign}${v.toFixed(2)}×`
  return `${sign}${v.toFixed(1)}`
}

function ExcursionBar({ mfe, mae, capture, keptLabel, maeLabel, mfeLabel }: {
  mfe: number
  mae: number
  /** Mean MFE capture, 0..1. Null hides the kept fill + label (bar still shows). */
  capture: number | null
  /** The kept amount in the active unit (avg MFE × capture), pre-formatted.
   *  Null omits the "≈ …" — e.g. no capture, so no amount to show. */
  keptLabel: string | null
  /** Signed worst-point / best-point numbers rendered at the bar's ends. */
  maeLabel: string
  mfeLabel: string
}) {
  const span = mfe + mae
  if (!(span > 0)) return null
  const entry = (mae / span) * 100
  const cap = capture != null ? Math.max(0, Math.min(1, capture)) : null
  const keptWidth = cap != null ? (100 - entry) * cap : null
  return (
    <div className="mt-2">
      {/* worst point ←— bar —→ best point: the numbers sit at the ends they
          describe, so +MFE reads as the far edge of the run (offered), not a gain. */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-red-400 tabular-nums whitespace-nowrap">{maeLabel}</span>
        <div className="relative flex-1 h-[7px] rounded-[2px]" style={{ background: 'var(--color-surface-2)' }}>
          {/* heat (left of entry) */}
          <span className="absolute top-0 h-[7px] rounded-l-[2px]" style={{ left: 0, width: `${entry}%`, background: 'rgba(224,104,95,0.45)' }} />
          {/* full favourable run (faint) */}
          <span className="absolute top-0 h-[7px] rounded-r-[2px]" style={{ left: `${entry}%`, right: 0, background: 'rgba(79,197,142,0.18)' }} />
          {/* the part you kept (solid) */}
          {keptWidth != null && (
            <span className="absolute top-0 h-[7px]" style={{ left: `${entry}%`, width: `${keptWidth}%`, background: 'var(--color-pos)' }} />
          )}
          {/* entry tick */}
          <span className="absolute -top-[3px] h-[13px] w-px bg-gray-300" style={{ left: `${entry}%` }} />
        </div>
        <span className="text-[11px] font-medium text-green-400 tabular-nums whitespace-nowrap">{mfeLabel}</span>
      </div>
      {cap != null && (
        <div className="mt-2 text-center text-[11px] text-gray-400 leading-tight">
          kept <span className="text-gray-100 font-semibold">{Math.round(cap * 100)}%</span> of the move
          {keptLabel != null && (
            <> ≈ <span className="text-gray-100 font-semibold">{keptLabel}</span></>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({
  label, value, valueNode, tone, sub, subNode, valueClass, chartNode, title,
}: {
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
  return (
    <div className="border border-gray-800 rounded-[3px] p-[18px]" title={title}>
      <p className="text-xs text-gray-500 mb-1 whitespace-nowrap">{label}</p>
      {/* Blank value is intentional (e.g. the MFE tile, whose numbers live at the
          bar ends) — skip the line entirely so it doesn't leave an empty gap. */}
      {valueNode ? (
        <p className={`font-bold ${valueColor} ${valueClass ?? 'text-xl'}`}>{valueNode}</p>
      ) : value !== '' && (
        <p className={`font-bold ${valueColor} ${valueClass ?? 'text-xl'} whitespace-nowrap`}>{value}</p>
      )}
      {chartNode}
      {subNode ? <div className="mt-1">{subNode}</div> : sub ? <p className="text-[10px] text-gray-600 mt-1 whitespace-nowrap">{sub}</p> : null}
    </div>
  )
}


