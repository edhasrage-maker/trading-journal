import { symbolToMultiplier, symbolRoot } from '@/lib/futures-symbols'
import { plannedStopPrice } from '@/lib/planned-stop'
import { avgCaptureRatio, avgMaeHeatRatio, type TradeWithExcursion } from '@/lib/analytics'
import { tapeScoreBaseFromAnalyses, finishTapeScore, resolvedAudit, type TapeScoreBase, type TapeScoreOptions, type TapeScoreResult } from '@/lib/tapescore'
import { mgmtTotals, type MgmtTotals } from '@/lib/trade-management'
import { dayTradeInputs, tradeSumsInSequence, normalizeAtrStopTarget, type DayTradeInputs, type RiskDay } from '@/lib/exit-rollup'
import type { TradeSums } from '@/lib/tapescore-axes'
import { effectiveAnalysis } from '@/lib/tapescore-day-rules'
import type { ProcessVerdict, TradeEntryCtx, TradeStops, TradingDay } from '@/lib/supabase/types'
import type { EntryRuleConfig } from '@/lib/entry-rules'
import type { RunnerRuleConfig } from '@/lib/runner-rules'

/**
 * The per-day dashboard rollup, extracted verbatim from the inline computation
 * that used to live in `dashboard/page.tsx`. Kept as ONE pure function so it can
 * run BOTH at read time (dashboard fallback) and at write time (materialized
 * `trading_days.stats_json`) — a cached row and a freshly computed row are then
 * identical by construction. See docs/dashboard-stats-materialization-plan.md.
 */

/** The trade fields the rollup reads (superset-safe: extra fields are ignored). */
export interface TradeForStats {
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json: any
  pnl: number | null
  direction: 'long' | 'short' | null
  entry_price: number | null
  /** Optional: anchors the traded range to the exit fill (see excursion-guard). */
  exit_price?: number | null
  stop_price: number | null
  high_during_position: number | null
  low_during_position: number | null
  quantity: number | null
  symbol: string | null
  entry_atr_1m: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json: any
  mfe_dollars_per_leg: number | null
  /** The Exit score reads these two (src/lib/exit-score.ts): the planned
   *  target decides whether a winner "reached its target", and the 5-minute
   *  structure is one of the runner rules. A select that omits them does not
   *  fail — it silently scores every winner as a hand-closed exit. */
  tp1_price: number | null
  structure_5m_alignment: 'following' | 'fading' | 'neutral' | null
  /** The trade's order-flow Score total (review_json.score.total), selected
   *  by JSON path so the review blob never leaves the database. Null = not
   *  scored. Entry reads it when the trader includes the Score. */
  flow_total?: number | null
  /** Fill times — the rules TapeScore re-reads from the trades (size-up after
   *  a loss, quick re-entries after a loss) need the order and the gaps. */
  entry_time?: string | null
  exit_time?: string | null
  /** The entry rules' snapshot of the fill (review_json.entry_ctx), selected by
   *  JSON path. Null = not read yet. Entry's "Entry rules" part grades it. */
  entry_ctx?: TradeEntryCtx | null
  /** The trade's stop orders (review_json.stops), selected by JSON path. Null =
   *  imported without orders. The runner rule "breakeven only after TP1" reads
   *  it, and every planned-risk number reads the planned stop from it
   *  (src/lib/planned-stop.ts). */
  stops?: TradeStops | null
}

/**
 * The exact trade columns `computeDayStats` reads. EVERY query that feeds the
 * rollup selects this string (plus its own grouping key), so the dashboard, the
 * recaps, the filter and the write path can never compute a day from different
 * columns.
 */
export const ROLLUP_TRADE_COLS =
  'id, entry_time, exit_time, tags_json, pnl, direction, entry_price, exit_price, stop_price, tp1_price, high_during_position, low_during_position, quantity, symbol, entry_atr_1m, structure_5m_alignment, exits_json, mfe_dollars_per_leg, flow_total:review_json->score->total, entry_ctx:review_json->entry_ctx, stops:review_json->stops'

/** The day-level inputs (columns) the rollup reads. */
export interface DayForStats {
  id: string
  date: string
  eod_pnl: number | null
  day_type: string | null
  day_types: string[] | null
  ai_analysis_json: TradingDay['ai_analysis_json'] | null
  eod_ai_analysis_json: TradingDay['eod_ai_analysis_json'] | null
  /** Earned achievement coin ids (trading_days.achievements_json). */
  achievements?: string[]
}

/** The shape the dashboard consumes per day (unchanged from the old inline map). */
export interface DayStatsRollup {
  id: string
  date: string
  eod_pnl: number | null
  day_type: string | null
  day_types: string[]
  achievements: string[]
  trade_count: number
  trade_wins: number
  trades_with_pnl_count: number
  setups: string[]
  process_score: number | null
  overall_grade: number | null
  process_verdict: 'Compliant' | 'Breach' | null
  process_v13_score: number | null
  /** The part of the day's TapeScore that comes from its EOD analysis — the
   *  rules audit, the checklist, plan adherence. The finished `tapescore` is
   *  NOT on the rollup: Risk's loss size depends on earlier days and Entry's
   *  order-flow Score on a setting, so it is attached when days are read in
   *  sequence (`scoreDayRollups`). Null = never analyzed. */
  tape: TapeScoreBase | null
  /** The day's per-trade inputs (src/lib/exit-rollup.ts): stop size, the
   *  order-flow Score and the three Exit parts as sums + counts, and the
   *  losing trades as raw pairs for loss size. */
  trade_parts: DayTradeInputs
  process_breach_rules: string[] | null
  win_rate: number | null
  avg_mfe_pts: number | null
  avg_mae_pts: number | null
  avg_mfe_dollars: number | null
  avg_mae_dollars: number | null
  avg_capture: number | null
  avg_heat: number | null
  atr_1m: number | null
  avg_live_atr_1m: number | null
  live_atr_count: number
  avg_mfe_atr: number | null
  avg_mae_atr: number | null
  /** Realized-R sums for the payoff ratio, kept as SUMS + COUNTS rather than a
   *  per-day average. The dashboard pools a period, and averaging per-day
   *  averages would weight a one-trade day the same as a ten-trade day — the
   *  payoff would drift with how the trades happened to fall across sessions.
   *  Only trades carrying a real stop contribute, since R is undefined without
   *  one; `r_sample` is how many of `trades_with_pnl_count` qualified. */
  sum_win_r: number
  win_r_count: number
  sum_loss_r: number
  loss_r_count: number
  r_sample: number
  /** Trade-level shape of the day, for period-over-period attribution. Kept on
   *  the rollup so a multi-month comparison reads cached days instead of
   *  re-fetching every trade in the quarter. */
  /** SUMS + COUNTS, not per-day averages — same reasoning as the R sums above:
   *  a period pools these, and averaging per-day averages would weight a
   *  one-trade day like a ten-trade one. The counts differ from each other
   *  because risk needs a stop and lot size does not. */
  sum_risk_dollars: number
  /** Sum of the same trades' planned dollar risk squared — with the sum and
   *  the count, the risk yardstick's SD (src/lib/exit-rollup.ts). */
  sum_risk_sq: number
  risk_sample: number
  sum_quantity: number
  quantity_sample: number
  /** Trade counts per instrument root, e.g. { MES: 4, MNQ: 1 }. */
  symbol_counts: Record<string, number>
  /** Sum of the day's logged trade P&L. Differs from `eod_pnl` when the day
   *  carries a P&L the trades do not account for; the gap is what makes a
   *  period comparison unreconcilable, so it is surfaced rather than hidden. */
  logged_trade_pnl: number | null
  /** Trade management — the day's trades sorted into "went your way" / "never
   *  got going", as SUMS + COUNTS in every unit (src/lib/trade-management.ts).
   *  A period pools these by plain addition, so the dashboard card, the recent
   *  days table and the recap card are the same arithmetic over different
   *  trades. Optional only so a pre-v9 cached row still types while it
   *  recomputes. */
  mgmt?: MgmtTotals
}

/**
 * A day read in sequence: the rollup plus the two things that need the days
 * before it. This is the shape every surface renders from — `tapescore` exists
 * only here, so nothing can print a day's score without its Exit.
 */
export interface ScoredDayRollup extends DayStatsRollup {
  /** One TapeScore: the analysis parts plus the per-trade parts. */
  tapescore: TapeScoreResult | null
  /** The day's per-trade sums + counts, with "Loss size" scored against the
   *  trader's risk yardstick going into the day. A period pools these. */
  trade_sums: TradeSums | null
}

/**
 * Attach each day's per-trade sums and finished TapeScore. `history` is earlier
 * days the caller loaded only so the first days of `rollups` have an average
 * dollar risk to be measured against (see `loadRiskHistory`); days already in
 * `rollups` serve as each other's history. `opts.includeFlow` is the trader's
 * order-flow Score setting (on unless switched off) — applied here, at read
 * time, so changing it needs no recompute. Order is preserved.
 */
export function scoreDayRollups(
  rollups: readonly DayStatsRollup[],
  history: readonly RiskDay[] = [],
  opts: TapeScoreOptions = {},
): ScoredDayRollup[] {
  const reads = tradeSumsInSequence(rollups, history)
  return rollups.map((r, i) => {
    const sums = reads[i]?.sums ?? null
    // "No size-up after a loss" against the same yardstick Loss size just used;
    // the day's verdict fields follow it, so the verdict shown and the score's
    // cap agree.
    const sizeUpFails = reads[i]?.sizeUpFails ?? undefined
    const audit = sizeUpFails !== undefined ? resolvedAudit(r.tape, sizeUpFails) : null
    return {
      ...r,
      ...(audit ? processFields(audit) : {}),
      tapescore: finishTapeScore(r.tape, sums, { ...opts, sizeUpFails }),
      trade_sums: sums,
    }
  })
}

/** The rollup's three rules-audit fields from an audit. */
function processFields(p: ProcessVerdict | null | undefined): Pick<DayStatsRollup, 'process_verdict' | 'process_v13_score' | 'process_breach_rules'> {
  if (!p) return { process_verdict: null, process_v13_score: null, process_breach_rules: null }
  if (!p.per_rule) return { process_verdict: p.verdict ?? null, process_v13_score: null, process_breach_rules: null }
  // Tracked rails only (active_rails, when the analysis recorded it) — an
  // untracked rail auto-passes and must not pad the score, and a trader who
  // tracks 4 rails scores out of 4, not 5.
  const ruleIds = (p.active_rails?.length ? p.active_rails : ['P1', 'P2', 'P3', 'P4', 'P5']) as readonly string[]
  let passCount = 0
  const failed: string[] = []
  for (const id of ruleIds) {
    const r = p.per_rule[id as keyof typeof p.per_rule]
    if (!r) continue
    if (r.status === 'pass') passCount += 1
    if (r.status === 'fail' || r.status === 'incomplete') failed.push(id)
  }
  return {
    process_verdict: p.verdict ?? null,
    process_v13_score: Math.round((passCount / ruleIds.length) * 10),
    process_breach_rules: failed,
  }
}

/** Summed planned dollar risk, its sum of squares, and the count over a day's
 *  trades with a logged stop — what the risk yardstick (mean + SD) reads. The
 *  same loop the rollup runs, shared so a day whose cache is missing yields the
 *  identical figures. */
export function dayRiskSums(
  trades: ReadonlyArray<Pick<TradeForStats, 'pnl' | 'entry_price' | 'stop_price' | 'quantity' | 'symbol' | 'direction' | 'stops'>>,
): { sum_risk_dollars: number; sum_risk_sq: number; risk_sample: number } {
  let sum = 0, sq = 0, n = 0
  for (const t of trades) {
    const stop = plannedStopPrice(t)
    if (t.pnl == null || t.entry_price == null || stop == null || t.quantity == null) continue
    const risk = Math.abs(t.entry_price - stop) * t.quantity * symbolToMultiplier(t.symbol ?? '')
    if (risk > 0) { sum += risk; sq += risk * risk; n++ }
  }
  return { sum_risk_dollars: sum, sum_risk_sq: sq, risk_sample: n }
}

/** Rollups have carried `sum_risk_dollars` / `risk_sample` since this version,
 *  and `sum_risk_sq` since RISK_SQ_SINCE_VERSION, computed the same way ever
 *  since — a cached row at or above both has usable risk sums even when the
 *  rest of it is due a recompute. */
// v14: planned risk reads Sierra's planned stop (src/lib/planned-stop.ts), so
// sums cached before it are not "computed the same way" any more.
export const RISK_SUMS_SINCE_VERSION = 14
export const RISK_SQ_SINCE_VERSION = 14

/**
 * Is a cached `stats_json` row usable as-is? It must be at the current version
 * AND have been computed with the trader's current ATR stop setting — the
 * "Stop size" sums are baked in with it, so changing the setting makes every
 * cached row stale exactly like a version bump does. The same goes for the
 * trader's own rules (`rulesSig` = traderRulesSig of their entry and runner rules; '' = none): change
 * a number and every day re-grades. (The order-flow Score setting is not baked
 * in: the sums are always stored and the setting is applied when the days are
 * read.)
 */
export function isFreshStats(
  row: { stats_json: DayStatsStored | null; stats_version: number | null },
  atrStopTarget: number | null | undefined,
  rulesSig: string,
): row is { stats_json: DayStatsStored; stats_version: number } {
  return row.stats_json != null
    && row.stats_version === STATS_VERSION
    && row.stats_json.trade_parts?.atr_stop === normalizeAtrStopTarget(atrStopTarget)
    && (row.stats_json.trade_parts?.rules_sig ?? '') === rulesSig
}

/**
 * Cache format version for the materialized `trading_days.stats_json`. Bump this
 * whenever `computeDayStats`'s formula or output shape changes: the dashboard
 * read path treats any row whose `stats_version` != this constant as dirty and
 * recomputes it, so a formula change invalidates every cached row at once.
 */
// v2 (2026-07-23): TapeScore amendment 6 changed the derived score's formula
// and its components ({rules,execution,prep} → {risk,entry,capture}). The
// rollup caches that derived result, so every row must recompute — otherwise
// the Review · Month ring + decision-quality list read the stale old-shape
// components as null (0/0/0) and the cached scores stay on the old formula.
// v3 (2026-07-24): TapeScore amendment 7 re-weighted the three axes to equal
// thirds (was 50/30/20). Same components, new blend — every cached composite
// must recompute or the ring shows the old risk-dominant number.
// v4 (2026-08-14): excursions are now measured against a window anchored to the
// trade's own fills (src/lib/excursion-guard.ts). A stop-out's recorded high/low
// stopped just short of the price it was stopped AT, so heat was understated on
// exactly the trades where heat matters most — avg_mae/avg_heat move on those
// days, and every cached row must recompute to agree with a fresh one.
// v7 (2026-08-31): the rollup gained the trade-shape fields the month-over-month
// comparison reads (risk/quantity sums + counts, instrument split, logged trade
// P&L). Stored as SUMS so a period pools them correctly; every cached row must
// recompute or the comparison silently drops its risk and size rows.
// v8 (2026-10-08): mfeMaePoints returns null for a row whose entry/exit sits far
// outside its own traded range (excursionContradictsFills) instead of a
// fabricated excursion. One such row (an NQ entry on an MES trade) put a day's
// avg MAE at −1,843×ATR; cached rows must recompute to drop it.
// v9 (2026-10-13): the rollup gained `mgmt` — the trade-management sums behind
// the one "went your way / never got going / kept" definition that replaces the
// eight capture formulas. Every cached row must recompute to carry it, or the
// dashboard card would count only the days that happened to be dirty.
// v10 (2026-10-13): TapeScore amendment 8 — the Exit axis became the five-factor
// Exit score. The rollup no longer caches a finished `tapescore` (its Exit needs
// the days before it); it caches `tape` (Risk + Entry) and `exit` (the day's
// Exit inputs) instead, and the score is finished at read time. Every cached row
// must recompute: an old row has neither field, so it would read as unscored.
// v11 (2026-10-14): TapeScore amendment 9 — loss size and stop size moved from
// Exit into Risk, Entry reads six checklist items (no profit factor) and can
// include the per-trade order-flow Score. The rollup stores the analysis parts
// (`tape`: rules, checklist, plan) and `trade_parts` (per-trade sums, now with
// the order-flow Score, which the trade select reads) instead of `exit`. Every
// cached row must recompute: an old row has neither field.
// v12 (2026-10-14): Loss size and "no size-up after a loss" are judged against
// the trader's usual risk spread (mean + SD of recent planned dollar risk), so
// the rollup carries `sum_risk_sq`, `trade_parts` carries the size-up inputs
// (`size_up`), and the verdict fields are resolved when days are read.
// v13 (2026-10-14): MFE is measured on the AVAILABLE position
// (src/lib/available-mfe.ts) — a scaled-out trade's contracts each count only
// while they were on — so `mgmt` sums and the Exit "profit kept" factor move on
// every day with a scale-out.
// v14 (2026-10-16): planned risk is Sierra's stop a minute after the fill where
// the trade has its stop history, else the logged stop (src/lib/planned-stop.ts),
// and Stop respected fails a stop moved past its plan after that minute. A stop
// tightened during the trade no longer shrinks R or reads as "past stop" — R,
// Stop respected, Stop size, Loss size and the risk sums move on those days.
export const STATS_VERSION = 14

/** The rollup fields persisted in `stats_json` — everything `computeDayStats`
 *  returns EXCEPT the fields that already live in dedicated `trading_days`
 *  columns (id, date, day_type, day_types) or their own column merged at read
 *  time (achievements). Those are re-attached by `fromStoredStats`. */
export type DayStatsStored = Omit<DayStatsRollup, 'id' | 'date' | 'day_type' | 'day_types' | 'achievements'>

/** Project a full rollup down to what we store in `stats_json` (drops the
 *  column-owned fields so the cache never disagrees with the row). */
export function toStoredStats(r: DayStatsRollup): DayStatsStored {
  // `tapescore` / `trade_sums` are read-time fields (ScoredDayRollup). A scored
  // day is a DayStatsRollup to the type system, so drop them here rather than
  // trust every caller to pass the unscored one — a cached finished score would
  // go stale the moment an earlier day changed.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { id, date, day_type, day_types, achievements, tapescore, trade_sums, ...stored } = r as ScoredDayRollup
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return stored
}

/** Rehydrate a full rollup from a stored `stats_json` blob + the day's own
 *  columns. day_types is re-derived exactly as `computeDayStats` does. */
export function fromStoredStats(
  stored: DayStatsStored,
  day: { id: string; date: string; day_type: string | null; day_types: string[] | null; achievements?: string[] },
): DayStatsRollup {
  return {
    ...stored,
    id: day.id,
    date: day.date,
    day_type: day.day_type,
    day_types: (day.day_types && day.day_types.length > 0)
      ? day.day_types
      : (day.day_type ? [day.day_type] : []),
    achievements: day.achievements ?? [],
  }
}

/**
 * Compute the dashboard rollup for one day from its trades + prep ATR. Pure and
 * self-contained: live ATR is read from each trade's own `entry_atr_1m` (no
 * external map), and capture/heat/tapescore come from the shared analytics +
 * tapescore libs, so this matches the EOD recap and analytics exactly.
 *
 * @param prepAtr  the day's market_context.atr_1m (fallback ATR display value).
 * @param opts.atrStopTarget  the trader's ATR stop setting (scoring profile;
 *                 default 1) — the yardstick for Risk's "Stop size".
 * @param opts.entryRules  the trader's entry rules (scoring profile) — what
 *                 Entry's "Entry rules" part grades each trade against.
 * @param opts.runnerRules  the trader's runner rules — Exit's "Runner rules"
 *                 part on the trades where one counts.
 */
export function computeDayStats(
  day: DayForStats,
  trades: TradeForStats[],
  prepAtr: number | null,
  opts: { atrStopTarget?: number | null; entryRules?: readonly EntryRuleConfig[] | null; runnerRules?: readonly RunnerRuleConfig[] | null } = {},
): DayStatsRollup {
  // The stored analysis with the read-time corrections TapeScore makes from
  // the trades (src/lib/tapescore-day-rules.ts).
  const eod = effectiveAnalysis(day.eod_ai_analysis_json, trades)

  // Top setups across the day's trades, sorted by frequency.
  const setupCounts = new Map<string, number>()
  for (const t of trades) {
    const setups = (t.tags_json?.setups ?? []) as string[]
    for (const s of setups) setupCounts.set(s, (setupCounts.get(s) ?? 0) + 1)
  }
  const setupsAll = Array.from(setupCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s)

  // Displayed PnL: explicit eod_pnl override wins; else sum of trades; else null.
  const summedPnl = trades.reduce((acc, t) => acc + (t.pnl ?? 0), 0)
  const displayedPnl = day.eod_pnl != null
    ? day.eod_pnl
    : trades.length > 0 ? summedPnl : null

  const tradesWithPnl = trades.filter(t => t.pnl != null)
  const winsOnDay = tradesWithPnl.filter(t => (t.pnl ?? 0) > 0).length
  // Realized R per trade = PnL / planned risk, with the contract multiplier
  // applied so a micro and a mini are directly comparable. Deliberately NOT
  // back-solved from realized_rr for trades without a stop: a synthesised risk
  // makes the payoff look measured when it was invented.
  let sumWinR = 0, winRCount = 0, sumLossR = 0, lossRCount = 0
  for (const t of tradesWithPnl) {
    const stop = plannedStopPrice(t)
    if (t.entry_price == null || stop == null || t.quantity == null) continue
    const risk = Math.abs(t.entry_price - stop) * t.quantity * symbolToMultiplier(t.symbol ?? '')
    if (!(risk > 0)) continue
    const r = (t.pnl as number) / risk
    if (r > 0) { sumWinR += r; winRCount++ }
    else if (r < 0) { sumLossR += Math.abs(r); lossRCount++ }
  }
  const winRate = tradesWithPnl.length > 0
    ? (winsOnDay / tradesWithPnl.length) * 100
    : null

  // Average planned dollar risk and lot size, plus the instrument split. Risk
  // is the honest size measure: more lots on a smaller-tick instrument is
  // dollar parity, not an escalation, and a contracts-only read inverts that.
  let qtySum = 0, qtyN = 0
  const symbolCounts: Record<string, number> = {}
  for (const t of tradesWithPnl) {
    if (t.quantity != null) { qtySum += t.quantity; qtyN++ }
    const root = symbolRoot(t.symbol ?? '')
    if (root) symbolCounts[root] = (symbolCounts[root] ?? 0) + 1
  }
  const { sum_risk_dollars: riskSum, sum_risk_sq: riskSq, risk_sample: riskN } = dayRiskSums(tradesWithPnl)

  // Avg MFE / MAE per trade (points + $), floored at 0 per trade.
  const mfeMaeTrades = trades.filter(t =>
    t.entry_price != null &&
    t.high_during_position != null &&
    t.low_during_position != null &&
    t.direction != null
  )
  let avgMfePts: number | null = null
  let avgMaePts: number | null = null
  let avgMfeDollars: number | null = null
  let avgMaeDollars: number | null = null
  if (mfeMaeTrades.length > 0) {
    let mfeSum = 0, maeSum = 0, mfeDollarSum = 0, maeDollarSum = 0
    for (const t of mfeMaeTrades) {
      const isLong = t.direction === 'long'
      const mfe = Math.max(0, isLong
        ? (t.high_during_position! - t.entry_price!)
        : (t.entry_price! - t.low_during_position!))
      const mae = Math.max(0, isLong
        ? (t.entry_price! - t.low_during_position!)
        : (t.high_during_position! - t.entry_price!))
      mfeSum += mfe
      maeSum += mae
      const mult = symbolToMultiplier(t.symbol ?? '')
      const qty = t.quantity ?? 1
      mfeDollarSum += mfe * mult * qty
      maeDollarSum += mae * mult * qty
    }
    avgMfePts = mfeSum / mfeMaeTrades.length
    avgMaePts = maeSum / mfeMaeTrades.length
    avgMfeDollars = mfeDollarSum / mfeMaeTrades.length
    avgMaeDollars = maeDollarSum / mfeMaeTrades.length
  }

  const xcTrades = trades as unknown as TradeWithExcursion[]
  const captureStats = avgCaptureRatio(xcTrades)
  const heatStats = avgMaeHeatRatio(xcTrades)

  // Live ATR averaged across the day's trades (from each trade's entry_atr_1m).
  let avgLiveAtr1m: number | null = null
  let liveAtrCount = 0
  let liveAtrSum = 0
  for (const t of trades) {
    if (t.entry_atr_1m != null && t.entry_atr_1m > 0) { liveAtrSum += t.entry_atr_1m; liveAtrCount++ }
  }
  if (liveAtrCount > 0) avgLiveAtr1m = liveAtrSum / liveAtrCount

  // Average-of-ratios ×ATR (matches the EOD AvgMfeMaeCard): mean of per-trade
  // (excursion / that trade's OWN entry_atr_1m), over the ATR-bearing subset.
  let avgMfeAtr: number | null = null
  let avgMaeAtr: number | null = null
  {
    let mfeAtrSum = 0, maeAtrSum = 0, n = 0
    for (const t of mfeMaeTrades) {
      const atr = t.entry_atr_1m
      if (atr == null || atr <= 0) continue
      const isLong = t.direction === 'long'
      const mfe = Math.max(0, isLong ? (t.high_during_position! - t.entry_price!) : (t.entry_price! - t.low_during_position!))
      const mae = Math.max(0, isLong ? (t.entry_price! - t.low_during_position!) : (t.high_during_position! - t.entry_price!))
      mfeAtrSum += mfe / atr
      maeAtrSum += mae / atr
      n++
    }
    if (n > 0) { avgMfeAtr = mfeAtrSum / n; avgMaeAtr = maeAtrSum / n }
  }

  return {
    id: day.id,
    date: day.date,
    eod_pnl: displayedPnl,
    day_type: day.day_type,
    day_types: (day.day_types && day.day_types.length > 0)
      ? day.day_types
      : (day.day_type ? [day.day_type] : []),
    achievements: day.achievements ?? [],
    trade_count: trades.length,
    trade_wins: winsOnDay,
    trades_with_pnl_count: tradesWithPnl.length,
    sum_win_r: sumWinR,
    win_r_count: winRCount,
    sum_loss_r: sumLossR,
    loss_r_count: lossRCount,
    r_sample: winRCount + lossRCount,
    sum_risk_dollars: riskSum,
    sum_risk_sq: riskSq,
    risk_sample: riskN,
    sum_quantity: qtySum,
    quantity_sample: qtyN,
    symbol_counts: symbolCounts,
    logged_trade_pnl: tradesWithPnl.length > 0 ? summedPnl : null,
    mgmt: mgmtTotals(trades),
    setups: setupsAll,
    process_score: day.ai_analysis_json?.score ?? null,
    overall_grade: (() => {
      const j = day.eod_ai_analysis_json
      const composite = j?.execution?.composite
      if (composite != null) return Math.round(composite * 10)
      if (j?.execution != null) return 0
      return j?.score ?? null
    })(),
    // The rules audit as TapeScore reads it (a broken daily loss limit is a
    // Breach). "No size-up after a loss" needs the trader's risk yardstick, so
    // scoreDayRollups re-derives these three once it is known.
    ...processFields(eod?.process),
    tape: tapeScoreBaseFromAnalyses(eod, day.ai_analysis_json?.score ?? null),
    trade_parts: dayTradeInputs(trades, opts.atrStopTarget, opts.entryRules, opts.runnerRules),
    win_rate: winRate,
    avg_mfe_pts: avgMfePts,
    avg_mae_pts: avgMaePts,
    avg_mfe_dollars: avgMfeDollars,
    avg_mae_dollars: avgMaeDollars,
    avg_capture: captureStats.avg,
    avg_heat: heatStats.avg,
    atr_1m: prepAtr,
    avg_live_atr_1m: avgLiveAtr1m,
    live_atr_count: liveAtrCount,
    avg_mfe_atr: avgMfeAtr,
    avg_mae_atr: avgMaeAtr,
  }
}
