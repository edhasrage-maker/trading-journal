import { computeDayStats, fromStoredStats, toStoredStats, STATS_VERSION, type DayStatsRollup, type DayStatsStored } from '@/lib/day-stats'
import { aggregateTapeScore, type TapeScorePeriod } from '@/lib/tapescore'
import { rMultiple, type TradeLike } from '@/lib/analytics'
import type { PrepCommitment } from '@/lib/supabase/types'

/**
 * Shared data layer for the Week / Month recap pages.
 *
 * Same read-through pattern as the dashboard (Pt 10 materialization): read the
 * tiny `stats_json` rollups for the window, recompute ONLY the dirty days from
 * their trades/blobs, and write the recomputed rollup back so the next load is
 * pure cache. A recap window is 5–25 days, so steady state this is one query of
 * tiny rows and zero trade fetches.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const PAGE_SIZE = 1000

export interface PeriodDay {
  rollup: DayStatsRollup
  commitment: PrepCommitment | null
}

/** Rollups + commitments for every trading_days row in [start, end]. */
export async function loadPeriodDays(sb: AnyClient, start: string, end: string): Promise<PeriodDay[]> {
  // Day columns + commitment; the stats cache separately and GUARDED — on a
  // pre-migration DB the stats columns don't exist and that query errors, which
  // we read as "every day dirty" (same reasoning as the dashboard).
  const [dayResult, statsResult] = await Promise.all([
    sb.from('trading_days')
      .select('id, date, eod_pnl, day_type, day_types, prep_notes_json, achievements_json')
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true }),
    sb.from('trading_days')
      .select('id, stats_json, stats_version')
      .gte('date', start)
      .lte('date', end) as Promise<{ data: { id: string; stats_json: DayStatsStored | null; stats_version: number | null }[] | null; error: unknown }>,
  ])

  interface DayRow {
    id: string
    date: string
    eod_pnl: number | null
    day_type: string | null
    day_types: string[] | null
    prep_notes_json: { commitment?: PrepCommitment } | null
    achievements_json: string[] | null
  }
  const days = (dayResult.data ?? []) as DayRow[]

  const cacheAvailable = !statsResult.error
  const statsByDayId = new Map<string, DayStatsStored>()
  if (cacheAvailable && statsResult.data) {
    for (const r of statsResult.data) {
      if (r.stats_json != null && r.stats_version === STATS_VERSION) statsByDayId.set(r.id, r.stats_json)
    }
  }

  const dirtyIds = days.filter(d => !statsByDayId.has(d.id)).map(d => d.id)

  // Dirty inputs — blobs, trades, prep ATR — fetched only for dirty days.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blobsByDayId = new Map<string, { ai_analysis_json: any; eod_ai_analysis_json: any }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tradesByDay = new Map<string, any[]>()
  const prepAtrByDay = new Map<string, number | null>()
  if (dirtyIds.length > 0) {
    const [blobRes, ctxRes] = await Promise.all([
      sb.from('trading_days').select('id, ai_analysis_json, eod_ai_analysis_json').in('id', dirtyIds),
      sb.from('market_context').select('trading_day_id, atr_1m').in('trading_day_id', dirtyIds),
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (blobRes.data ?? []) as any[]) {
      blobsByDayId.set(r.id, { ai_analysis_json: r.ai_analysis_json, eod_ai_analysis_json: r.eod_ai_analysis_json })
    }
    for (const c of (ctxRes.data ?? []) as { trading_day_id: string; atr_1m: number | null }[]) {
      prepAtrByDay.set(c.trading_day_id, c.atr_1m)
    }
    for (let p = 0; p < 10; p++) {
      const { data } = await sb
        .from('trades')
        .select('id, trading_day_id, tags_json, pnl, direction, entry_price, stop_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, exits_json, mfe_dollars_per_leg')
        .in('trading_day_id', dirtyIds)
        .order('id', { ascending: true })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch = (data ?? []) as any[]
      for (const t of batch) {
        const arr = tradesByDay.get(t.trading_day_id) ?? []
        arr.push(t)
        tradesByDay.set(t.trading_day_id, arr)
      }
      if (batch.length < PAGE_SIZE) break
    }
  }

  const out: PeriodDay[] = days.map(d => {
    const achievements = Array.isArray(d.achievements_json) ? d.achievements_json : []
    const cached = statsByDayId.get(d.id)
    const rollup = cached
      ? fromStoredStats(cached, { id: d.id, date: d.date, day_type: d.day_type, day_types: d.day_types, achievements })
      : computeDayStats(
        {
          id: d.id,
          date: d.date,
          eod_pnl: d.eod_pnl,
          day_type: d.day_type,
          day_types: d.day_types,
          ai_analysis_json: blobsByDayId.get(d.id)?.ai_analysis_json ?? null,
          eod_ai_analysis_json: blobsByDayId.get(d.id)?.eod_ai_analysis_json ?? null,
          achievements,
        },
        tradesByDay.get(d.id) ?? [],
        prepAtrByDay.get(d.id) ?? null,
      )
    return { rollup, commitment: d.prep_notes_json?.commitment ?? null }
  })

  // Best-effort write-back so the next load serves these from cache. Read-only
  // (demo) users just error → swallowed → they recompute each visit, correctly.
  if (cacheAvailable && dirtyIds.length > 0) {
    const byId = new Map(out.map(p => [p.rollup.id, p.rollup]))
    await Promise.all(dirtyIds.map(id => {
      const rollup = byId.get(id)
      if (!rollup) return Promise.resolve()
      return sb
        .from('trading_days')
        .update({ stats_json: toStoredStats(rollup), stats_version: STATS_VERSION } as never)
        .eq('id', id)
        .then(() => {}, () => {})
    }))
  }

  return out
}

/** Lean per-trade rows for the finding engine, scoped to the window's days. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPeriodTrades(sb: AnyClient, dayIds: string[]): Promise<any[]> {
  if (dayIds.length === 0) return []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  for (let p = 0; p < 10; p++) {
    const { data } = await sb
      .from('trades')
      .select('id, trading_day_id, pnl, entry_price, stop_price, quantity, direction, entry_time, tags_json, symbol, high_during_position, low_during_position, exit_time, tp1_price, entry_atr_1m, structure_5m_alignment')
      .in('trading_day_id', dayIds)
      .order('id', { ascending: true })
      .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch = (data ?? []) as any[]
    out.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return out
}

export interface PeriodSummary {
  pnl: number
  trades: number
  /** Days with at least one trade. */
  tradedDays: number
  /** Traded days whose P&L was positive. */
  dayWins: number
  /** Trade-weighted mean MFE capture, 0–100, null when no day carries one. */
  capture: number | null
  /** Trade-weighted avg MFE$ over avg MAE$; null when MAE is 0/absent. */
  mfeMae: number | null
  /** Days with a rails verdict, and how many of those were Compliant. */
  railsDays: number
  railsKept: number
  score: TapeScorePeriod
  /** Trade win rate, 0-100. Denominator is trades carrying a P&L, which is why
   *  it can differ from the R sample below. Null with nothing to divide. */
  winRate: number | null
  /** Expectancy per trade in R. Only trades with a real stop qualify, so
   *  `rSample` is smaller than `trades` and is cited alongside the number. */
  avgR: number | null
  rSample: number
  /** Period P&L over trade count. Uses the same day-level P&L as `pnl`, so it
   *  agrees with the headline even on days the trade log does not account for. */
  dollarsPerTrade: number | null
  /** Trades per traded session. */
  tradesPerDay: number | null
  /** Mean planned dollar risk and lot size across the period. */
  avgRisk: number | null
  avgQuantity: number | null
  /** Instrument roots by trade count, largest first. */
  symbolCounts: Record<string, number>
  /** Day-level P&L minus the P&L its trades account for, and how many days
   *  contributed. Non-zero means the book does not reconcile and a per-trade
   *  comparison cannot be read against the headline P&L. */
  unloggedPnl: number
  unloggedDays: number
}

export function summarizePeriod(days: PeriodDay[]): PeriodSummary {
  let pnl = 0, trades = 0, tradedDays = 0, dayWins = 0
  let capSum = 0, capN = 0
  let mfeSum = 0, maeSum = 0, excN = 0
  let railsDays = 0, railsKept = 0
  let wins = 0, winsDenom = 0
  let sumWinR = 0, sumLossR = 0, rSample = 0
  let riskSum = 0, riskN = 0, qtySum = 0, qtyN = 0
  const symbolCounts: Record<string, number> = {}
  let unloggedPnl = 0, unloggedDays = 0
  for (const { rollup: r } of days) {
    const dayPnl = r.eod_pnl ?? null
    if (dayPnl != null) pnl += dayPnl
    trades += r.trade_count
    if (r.trade_count > 0) {
      tradedDays++
      if ((dayPnl ?? 0) > 0) dayWins++
    }
    if (r.avg_capture != null && r.trade_count > 0) { capSum += r.avg_capture * r.trade_count; capN += r.trade_count }
    if (r.avg_mfe_dollars != null && r.avg_mae_dollars != null && r.trade_count > 0) {
      mfeSum += r.avg_mfe_dollars * r.trade_count
      maeSum += Math.abs(r.avg_mae_dollars) * r.trade_count
      excN += r.trade_count
    }
    if (r.process_verdict != null) {
      railsDays++
      if (r.process_verdict === 'Compliant') railsKept++
    }
    wins += r.trade_wins
    winsDenom += r.trades_with_pnl_count
    // Loss R is stored as a MAGNITUDE, so expectancy subtracts it. Summing the
    // two would report a positive R that no win rate could produce.
    sumWinR += r.sum_win_r
    sumLossR += r.sum_loss_r
    rSample += r.r_sample
    riskSum += r.sum_risk_dollars ?? 0
    riskN += r.risk_sample ?? 0
    qtySum += r.sum_quantity ?? 0
    qtyN += r.quantity_sample ?? 0
    for (const [root, n] of Object.entries(r.symbol_counts ?? {})) {
      symbolCounts[root] = (symbolCounts[root] ?? 0) + n
    }
    if (r.eod_pnl != null && r.logged_trade_pnl != null) {
      const gap = r.eod_pnl - r.logged_trade_pnl
      if (Math.abs(gap) > 1) { unloggedPnl += gap; unloggedDays++ }
    }
  }
  return {
    pnl,
    trades,
    tradedDays,
    dayWins,
    capture: capN > 0 ? Math.round((capSum / capN) * 100) : null,
    mfeMae: excN > 0 && maeSum > 0 ? Math.round((mfeSum / maeSum) * 10) / 10 : null,
    railsDays,
    railsKept,
    score: aggregateTapeScore(days.map(d => d.rollup.tapescore)),
    winRate: winsDenom > 0 ? Math.round((wins / winsDenom) * 100) : null,
    avgR: rSample > 0 ? Math.round(((sumWinR - sumLossR) / rSample) * 100) / 100 : null,
    rSample,
    dollarsPerTrade: trades > 0 ? Math.round(pnl / trades) : null,
    tradesPerDay: tradedDays > 0 ? Math.round((trades / tradedDays) * 10) / 10 : null,
    avgRisk: riskN > 0 ? Math.round(riskSum / riskN) : null,
    avgQuantity: qtyN > 0 ? Math.round((qtySum / qtyN) * 10) / 10 : null,
    symbolCounts,
    unloggedPnl: Math.round(unloggedPnl),
    unloggedDays,
  }
}

// ── Commitment follow-through (the loop, reported at period altitude) ──────

export type CommitmentDayState = 'held' | 'broke' | 'unresolved'

export interface CommitmentReport {
  tracked: number
  held: number
  broke: number
  unresolved: number
  /** Weekday pips for the week view: one entry per period day WITH a commitment. */
  days: Array<{ date: string; state: CommitmentDayState }>
  /** Most-carried commitment text (by identity key), for the month view. */
  top: { text: string; tracked: number; held: number } | null
}

export function summarizeCommitments(days: PeriodDay[]): CommitmentReport | null {
  const withC = days.filter(d => d.commitment != null)
  if (withC.length === 0) return null
  let held = 0, broke = 0, unresolved = 0
  const byKey = new Map<string, { text: string; tracked: number; held: number }>()
  const dayStates: CommitmentReport['days'] = []
  for (const d of withC) {
    const c = d.commitment!
    const state: CommitmentDayState = c.resolved === 'followed' ? 'held' : c.resolved === 'not_followed' ? 'broke' : 'unresolved'
    if (state === 'held') held++
    else if (state === 'broke') broke++
    else unresolved++
    dayStates.push({ date: d.rollup.date, state })
    const k = c.key || c.today
    const agg = byKey.get(k) ?? { text: c.today, tracked: 0, held: 0 }
    agg.tracked++
    if (state === 'held') agg.held++
    byKey.set(k, agg)
  }
  let top: CommitmentReport['top'] = null
  for (const agg of byKey.values()) {
    if (!top || agg.tracked > top.tracked) top = agg
  }
  return { tracked: withC.length, held, broke, unresolved, days: dayStates, top }
}


// ── This period vs the trader's own baseline ────────────────────────────────

/**
 * A short window can't support a within-window comparison — split 14 trades by
 * setup and both arms are noise. But it CAN be read against the trader's own
 * history, where the comparison arm has hundreds of trades.
 *
 * This exists because the weekly recap used to say "too few trades to call a
 * setup edge or leak", which reads as a reprimand for being selective. Trading
 * 14 times in a week is not a deficiency, and the data is perfectly readable —
 * just not against itself.
 */
export interface BaselineRead {
  /** e.g. "Break And Retest" */
  label: string
  kind: 'setup' | 'day type'
  periodR: number
  periodN: number
  baselineR: number
  baselineN: number
  /** Which component actually moved, and what it contributed in R. Expectancy
   *  says a week was better; only this says WHY, and the two answers call for
   *  completely different responses. */
  driver: {
    kind: 'payoff' | 'win rate' | 'losses'
    contribution: number
    periodValue: number
    baselineValue: number
  }
  /** Period win rate is on a thin sample — a win-rate-driven week is then
   *  variance, and saying otherwise dresses luck as edge. */
  thin: boolean
  /** Hit rate for each arm, 0-100. Shown beside R so a reader can tell a
   *  genuinely better arm from one that simply had more room to run. */
  periodWinRate: number | null
  baselineWinRate: number | null
}

/** Baseline arm needs real weight — this is the whole point of the comparison. */
const BASELINE_MIN_N = 20
/** Period arm: enough that one trade can't create the read. */
const PERIOD_MIN_N = 3
/** Weekly noise is wide, so the gap has to be worth a sentence. */
const BASELINE_MIN_GAP_R = 0.5
/** Below this, a win-rate swing is variance and must be named as such. */
const THIN_SAMPLE_N = 10

type LabelledTrade = TradeLike & { _dayTypes?: string[] }
interface Outcome { r: number; win: boolean }

function profile(rows: Outcome[]) {
  if (rows.length === 0) return null
  const wins = rows.filter(o => o.win)
  const losses = rows.filter(o => !o.win)
  const mean = (a: Outcome[]) => (a.length ? a.reduce((s, o) => s + o.r, 0) / a.length : 0)
  return {
    n: rows.length,
    expectancy: mean(rows),
    winRate: wins.length / rows.length,
    // Empty side falls back to the other side's sign-appropriate zero so the
    // decomposition stays defined on a week with no winners (or no losers).
    winnerR: wins.length ? mean(wins) : 0,
    loserR: losses.length ? mean(losses) : 0,
    hasWins: wins.length > 0,
  }
}

/**
 * Strongest divergence between this window and the trader's book. `book` should
 * be the trailing history INCLUDING the window — the baseline is "how this
 * normally goes for you", not a disjoint sample.
 *
 * Selection uses expectancy OR the largest single component, whichever is
 * bigger. That second clause matters: a week can have its win rate fall ten
 * points while its winners run 0.65R further, net out to nothing, and read as
 * "unremarkable" when two real things happened and cancelled.
 */
export function periodVsBaseline(
  period: LabelledTrade[],
  book: LabelledTrade[],
  labelsOf: (t: LabelledTrade) => Array<{ kind: 'setup' | 'day type'; label: string }>,
): BaselineRead | null {
  const outcomes = (rows: LabelledTrade[], kind: string, label: string): Outcome[] =>
    rows
      .filter(t => labelsOf(t).some(l => l.kind === kind && l.label === label))
      .map(t => ({ r: rMultiple(t), pnl: t.pnl }))
      .filter((x): x is { r: number; pnl: number | null } => x.r != null)
      .map(x => ({ r: x.r, win: (x.pnl ?? 0) > 0 }))

  const seen = new Set<string>()
  let best: (BaselineRead & { weight: number }) | null = null

  for (const t of period) {
    for (const { kind, label } of labelsOf(t)) {
      const key = kind + '|' + label
      if (seen.has(key)) continue
      seen.add(key)

      const p = profile(outcomes(period, kind, label))
      const b = profile(outcomes(book, kind, label))
      if (!p || !b || p.n < PERIOD_MIN_N || b.n < BASELINE_MIN_N) continue

      // Exact decomposition of the expectancy gap. Each term is what that
      // component alone contributed, and the three sum to the total.
      const fromWinRate = (p.winRate - b.winRate) * (b.winnerR - b.loserR)
      const fromPayoff = p.winRate * (p.winnerR - b.winnerR)
      const fromLosses = (1 - p.winRate) * (p.loserR - b.loserR)

      const parts = [
        { kind: 'win rate' as const, contribution: fromWinRate, periodValue: p.winRate, baselineValue: b.winRate },
        { kind: 'payoff' as const, contribution: fromPayoff, periodValue: p.winnerR, baselineValue: b.winnerR },
        { kind: 'losses' as const, contribution: fromLosses, periodValue: p.loserR, baselineValue: b.loserR },
      ]
      const driver = parts.reduce((a, c) => (Math.abs(c.contribution) > Math.abs(a.contribution) ? c : a))
      // A payoff driver is meaningless with no winners to measure.
      if (driver.kind === 'payoff' && !p.hasWins) continue

      const gap = p.expectancy - b.expectancy
      const size = Math.max(Math.abs(gap), Math.abs(driver.contribution))
      if (size < BASELINE_MIN_GAP_R) continue

      const weight = size * Math.sqrt(p.n)
      if (!best || weight > best.weight) {
        best = {
          label, kind,
          periodR: p.expectancy, periodN: p.n,
          baselineR: b.expectancy, baselineN: b.n,
          driver, thin: p.n < THIN_SAMPLE_N, weight,
          periodWinRate: Math.round(p.winRate * 100),
          baselineWinRate: Math.round(b.winRate * 100),
        }
      }
    }
  }
  if (!best) return null
  const { weight: _w, ...read } = best
  void _w
  return read
}

/** The one sentence naming what actually moved. */
export function driverSentence(b: BaselineRead): string {
  const r = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}R`
  const pct = (v: number) => `${Math.round(v * 100)}%`
  switch (b.driver.kind) {
    case 'payoff':
      return `Your winners ran ${r(b.driver.periodValue)} against a usual ${r(b.driver.baselineValue)}.`
    case 'losses':
      return `Your losers cost ${r(b.driver.periodValue)} against a usual ${r(b.driver.baselineValue)}.`
    case 'win rate':
      return b.thin
        ? `You won ${pct(b.driver.periodValue)} of them against a usual ${pct(b.driver.baselineValue)} — on ${b.periodN} trades that is variance more than edge.`
        : `You won ${pct(b.driver.periodValue)} of them against a usual ${pct(b.driver.baselineValue)}.`
  }
}

// ── Prior-period comparison (computed, never AI) ───────────────────────────

export interface RecapVsRow {
  dim: string
  prior: string
  now: string
  delta: string
  tone: 'pos' | 'neg' | 'flat'
}

/** Computed comparison vs the prior period. Null when the prior period had no
 *  trading — an empty "before" column would imply a comparison that isn't one. */
export function comparisonRows(prior: PeriodSummary, now: PeriodSummary, scope: 'week' | 'month'): { title: string; rows: RecapVsRow[] } | null {
  if (prior.tradedDays === 0) return null
  const usd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString()}`
  const rows: RecapVsRow[] = []
  const dPnl = now.pnl - prior.pnl
  rows.push({
    dim: 'P&L', prior: usd(prior.pnl), now: usd(now.pnl),
    delta: `${dPnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(dPnl)).toLocaleString()}`,
    tone: dPnl > 0 ? 'pos' : dPnl < 0 ? 'neg' : 'flat',
  })
  if (prior.capture != null && now.capture != null) {
    const d = now.capture - prior.capture
    rows.push({
      dim: 'Profit captured', prior: `${prior.capture}%`, now: `${now.capture}%`,
      delta: d === 0 ? 'level' : `${d > 0 ? '+' : '−'}${Math.abs(d)} pts`, tone: d > 0 ? 'pos' : d < 0 ? 'neg' : 'flat',
    })
  }
  if (prior.railsDays > 0 && now.railsDays > 0) {
    const pr = prior.railsKept / prior.railsDays
    const nr = now.railsKept / now.railsDays
    const d = Math.round((nr - pr) * 100)
    rows.push({
      dim: 'Rules followed',
      prior: `${prior.railsKept} of ${prior.railsDays} days`, now: `${now.railsKept} of ${now.railsDays} days`,
      delta: d === 0 ? 'level' : `${d > 0 ? '+' : '−'}${Math.abs(d)} pts`, tone: d > 0 ? 'pos' : d < 0 ? 'neg' : 'flat',
    })
  }
  if (prior.score.score != null && now.score.score != null) {
    const d = now.score.score - prior.score.score
    rows.push({
      dim: 'TapeScore', prior: String(prior.score.score), now: String(now.score.score),
      delta: d === 0 ? 'level' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`, tone: d > 0 ? 'pos' : d < 0 ? 'neg' : 'flat',
    })
  }
  return { title: scope === 'week' ? 'Against the week before' : 'Against the month before', rows }
}

// ── Month arithmetic (PT session dates, pure string math) ──────────────────

/** 'YYYY-MM' → first/last date of that calendar month. */
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 2, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** One line of the period-over-period table: the same measure across N periods,
 *  plus the sentence saying which way it moved. */
export interface QuarterRow {
  driver: string
  /** One cell per period, oldest first. Already formatted. */
  values: string[]
  trend: string
  /** Tone for the MOST RECENT cell only — the others are context, and colouring
   *  every cell turns a trend into a scoreboard. */
  tone: 'pos' | 'neg' | null
  /** Set when the cell is day-level while the rest of the table is trade-level. */
  note?: string
}

export interface QuarterRead {
  labels: string[]
  rows: QuarterRow[]
  /** Total day-level P&L the trade log does not account for, across all periods,
   *  and how many days contributed. Non-zero means the per-trade rows cannot be
   *  reconciled against the P&L row and the table must say so. */
  unloggedPnl: number
  unloggedDays: number
  /** Per-period gap, for naming which months are affected. */
  unloggedByPeriod: Array<{ label: string; pnl: number; days: number }>
}

/** Largest instrument root and its share, e.g. "MES 82%". Null with no trades. */
function mixLabel(counts: Record<string, number>): string | null {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const [root, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return `${root} ${Math.round((n / total) * 100)}%`
}

/** Direction of travel across the series, ignoring nulls. */
function direction(vals: Array<number | null>): 'up' | 'down' | 'mixed' | null {
  const v = vals.filter((x): x is number => x != null)
  if (v.length < 2) return null
  let up = true, down = true
  for (let i = 1; i < v.length; i++) {
    if (v[i] <= v[i - 1]) up = false
    if (v[i] >= v[i - 1]) down = false
  }
  return up ? 'up' : down ? 'down' : 'mixed'
}

const pct = (a: number, b: number) => Math.round(((b - a) / Math.abs(a)) * 100)

/**
 * The period-over-period table. Every row is derived from the cached day
 * rollups, so a three-month comparison costs three `loadPeriodDays` calls and
 * no trade fetches.
 *
 * Two things this deliberately refuses to smooth over. The P&L row is DAY level
 * while risk, size and mix are TRADE level, so on any period whose trade log is
 * incomplete they cannot be reconciled — `unloggedPnl` reports the gap instead
 * of letting the reader assume the rows agree. And size is reported in dollar
 * risk as well as contracts, because more lots on a smaller-tick instrument is
 * dollar parity, not an escalation, and a contracts-only read inverts it.
 */
export function quarterRead(periods: Array<{ label: string; summary: PeriodSummary }>): QuarterRead | null {
  const withTrades = periods.filter(p => p.summary.trades > 0)
  if (withTrades.length < 2) return null

  const labels = withTrades.map(p => p.label)
  const s = withTrades.map(p => p.summary)
  const last = s[s.length - 1]
  const first = s[0]
  const rows: QuarterRow[] = []
  const dash = (v: string | null) => v ?? '—'

  const riskDir = direction(s.map(x => x.avgRisk))
  if (s.some(x => x.avgRisk != null)) {
    const change = first.avgRisk != null && last.avgRisk != null ? pct(first.avgRisk, last.avgRisk) : null
    rows.push({
      driver: 'Risk per trade',
      values: s.map(x => dash(x.avgRisk != null ? `$${x.avgRisk.toLocaleString()}` : null)),
      trend: change != null && Math.abs(change) >= 5
        ? `${change < 0 ? 'Down' : 'Up'} ${Math.abs(change)}% across the period.`
        : 'Broadly flat.',
      tone: null,
    })
  }

  if (s.some(x => Object.keys(x.symbolCounts).length > 0)) {
    rows.push({
      driver: 'Instrument mix',
      values: s.map(x => dash(mixLabel(x.symbolCounts))),
      trend: mixLabel(first.symbolCounts) !== mixLabel(last.symbolCounts)
        ? 'The book moved between instruments.'
        : 'Held the same instrument throughout.',
      tone: null,
    })
  }

  if (s.some(x => x.avgQuantity != null)) {
    const qtyUp = first.avgQuantity != null && last.avgQuantity != null && last.avgQuantity > first.avgQuantity
    const riskDown = riskDir === 'down'
    rows.push({
      driver: 'Size in contracts',
      values: s.map(x => dash(x.avgQuantity != null ? x.avgQuantity.toFixed(1) : null)),
      // The one row most likely to be misread on its own.
      trend: qtyUp && riskDown
        ? 'More lots at lower dollar risk is parity, not sizing up.'
        : 'Read against risk per trade, not on its own.',
      tone: null,
    })
  }

  const wrDir = direction(s.map(x => x.winRate))
  if (s.some(x => x.winRate != null)) {
    rows.push({
      driver: 'Win rate',
      values: s.map(x => dash(x.winRate != null ? `${x.winRate}%` : null)),
      trend: wrDir === 'down' ? 'Slipped every period.' : wrDir === 'up' ? 'Improved every period.' : 'Moved both ways.',
      tone: first.winRate != null && last.winRate != null ? (last.winRate >= first.winRate ? 'pos' : 'neg') : null,
    })
  }

  if (s.some(x => x.avgR != null)) {
    const dir = direction(s.map(x => x.avgR))
    rows.push({
      driver: 'Avg R',
      values: s.map(x => dash(x.avgR != null ? `${x.avgR >= 0 ? '+' : '−'}${Math.abs(x.avgR).toFixed(2)}R` : null)),
      trend: dir === 'up' ? 'Improved every period.' : dir === 'down' ? 'Fell every period.' : 'Dipped and recovered.',
      tone: first.avgR != null && last.avgR != null ? (last.avgR >= first.avgR ? 'pos' : 'neg') : null,
    })
  }

  if (s.some(x => x.capture != null)) {
    const best = Math.max(...s.map(x => x.capture ?? -1))
    rows.push({
      driver: 'Profit captured',
      values: s.map(x => dash(x.capture != null ? `${x.capture}%` : null)),
      trend: last.capture != null && last.capture === best ? 'Best of the set.' : 'Off its best.',
      tone: last.capture != null && last.capture === best ? 'pos' : null,
    })
  }

  if (s.some(x => x.railsDays > 0)) {
    const share = (x: PeriodSummary) => (x.railsDays > 0 ? Math.round((x.railsKept / x.railsDays) * 100) : null)
    rows.push({
      driver: 'Rules followed',
      values: s.map(x => (x.railsDays > 0 ? `${x.railsKept} of ${x.railsDays}` : '—')),
      trend: s.map(share).filter(v => v != null).join('% → ') + '%.',
      tone: direction(s.map(share)) === 'up' ? 'pos' : null,
    })
  }

  if (s.some(x => x.score.score != null)) {
    const dir = direction(s.map(x => x.score.score))
    rows.push({
      driver: 'TapeScore',
      values: s.map(x => dash(x.score.score != null ? String(x.score.score) : null)),
      trend: dir === 'up' ? 'Rose every period.' : dir === 'down' ? 'Fell every period.' : 'Moved both ways.',
      tone: dir === 'up' ? 'pos' : null,
    })
  }

  const pnlChange = first.pnl !== 0 ? pct(first.pnl, last.pnl) : null
  const riskChange = first.avgRisk != null && last.avgRisk != null ? pct(first.avgRisk, last.avgRisk) : null
  rows.push({
    driver: 'P&L',
    values: s.map(x => `${x.pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(x.pnl)).toLocaleString()}`),
    // P&L falling alongside risk is de-risking, not decay. Saying only the first
    // half of that would read as a verdict on the trading.
    trend: pnlChange != null && riskChange != null && pnlChange < 0 && riskChange < 0
      ? `Down ${Math.abs(pnlChange)}% — on ${Math.abs(riskChange)}% less risk per trade.`
      : pnlChange != null
        ? `${pnlChange < 0 ? 'Down' : 'Up'} ${Math.abs(pnlChange)}%.`
        : 'No prior period to compare.',
    tone: null,
    note: 'day level',
  })

  rows.push({
    driver: 'Trades / day',
    values: s.map(x => dash(x.tradesPerDay != null ? x.tradesPerDay.toFixed(1) : null)),
    trend: direction(s.map(x => x.tradesPerDay)) === 'down'
      ? 'Down every period — fewer shots taken per session.'
      : direction(s.map(x => x.tradesPerDay)) === 'up'
        ? 'Up every period — more shots taken per session.'
        : 'Moved both ways.',
    tone: null,
  })

  return {
    labels,
    rows,
    unloggedPnl: s.reduce((a, x) => a + x.unloggedPnl, 0),
    unloggedDays: s.reduce((a, x) => a + x.unloggedDays, 0),
    unloggedByPeriod: withTrades
      .map(p => ({ label: p.label, pnl: p.summary.unloggedPnl, days: p.summary.unloggedDays }))
      .filter(x => x.days > 0),
  }
}
