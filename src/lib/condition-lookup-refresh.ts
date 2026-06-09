import type {
  ConditionLookupRow,
  ConditionMetric,
  ConditionThreshold,
  ConditionVerdict,
  ConditionComboType,
} from '@/lib/supabase/types'

/**
 * Pure aggregation logic to derive the condition_thresholds + condition_lookup
 * tables directly from the live trade history. Replaces the manual CSV-upload
 * loop that was originally fed by an external R/Python notebook — once you
 * have trades + market_context in the DB, there's no reason the lookup
 * shouldn't be one button-click refreshable.
 *
 * Pipeline:
 *   1. From market_context, compute median / p33 / p67 thresholds per metric.
 *   2. For each trade (native + historical), derive its 5 metric values from
 *      its trading day's market_context row.
 *   3. Bucket each trade against the thresholds (median: LOW/HIGH, tertile: L/M/H).
 *   4. Enumerate all combos (BASELINE + 1-way + 2-way + 3-way variants) and
 *      aggregate trades matching each constraint set.
 *   5. Assign verdicts based on sample adequacy + EV + Wilson WR vs baseline.
 *
 * The output shape matches what the CSV upload route + condition-lookup runtime
 * already expect, so no consumer changes are needed.
 */

// ─── Input shapes ────────────────────────────────────────────────────────────

export interface MarketContextLite {
  trading_day_id: string
  rvol: number | null
  ib_vs_10d_avg: number | null   // → IB metric
  adr: number | null
  day_range: number | null       // for DR_ADR derivation
  atr_at_ib_close: number | null // → ATR_730 metric (preferred)
  atr_1m: number | null          // → ATR_730 fallback when atr_at_ib_close is null
}

export interface TradeLite {
  date: string                   // YYYY-MM-DD
  pnl: number | null
}

// ─── Metric derivation from market_context ───────────────────────────────────

export interface MetricRow {
  rvol: number | null
  dr_adr: number | null
  ib: number | null
  atr_730: number | null
  atr_entry: number | null
}

/** Derive the 5 prep metrics from a market_context row. RVOL/IB pass through;
 *  DR_ADR is computed from day_range/adr; ATR_730 uses our new IB-close ATR
 *  with EOD ATR fallback; ATR_entry is null (no per-trade ATR captured today). */
export function deriveMetrics(ctx: MarketContextLite | null): MetricRow {
  if (!ctx) return { rvol: null, dr_adr: null, ib: null, atr_730: null, atr_entry: null }
  // DR_ADR stored as percent (median ≈ 102 per existing thresholds). day_range
  // and adr are both in points; ratio × 100 gives the percent.
  const dr_adr = (ctx.day_range != null && ctx.adr != null && ctx.adr > 0)
    ? (ctx.day_range / ctx.adr) * 100
    : null
  return {
    rvol: ctx.rvol,
    dr_adr,
    ib: ctx.ib_vs_10d_avg,
    atr_730: ctx.atr_at_ib_close ?? ctx.atr_1m,
    atr_entry: null,  // not captured per-trade today; future enhancement
  }
}

// ─── Threshold computation ───────────────────────────────────────────────────

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * p))
  return sortedAsc[idx]
}

/** Compute median + p33/p67 from non-null values per metric. */
export function computeThresholds(metricRows: MetricRow[]): ConditionThreshold[] {
  const keys: ConditionMetric[] = ['RVOL', 'DR_ADR', 'IB', 'ATR_730', 'ATR_entry']
  const fieldMap: Record<ConditionMetric, keyof MetricRow> = {
    RVOL: 'rvol', DR_ADR: 'dr_adr', IB: 'ib', ATR_730: 'atr_730', ATR_entry: 'atr_entry',
  }
  const out: ConditionThreshold[] = []
  const now = new Date().toISOString()
  for (const metric of keys) {
    const vals = metricRows
      .map(r => r[fieldMap[metric]])
      .filter((v): v is number => v != null && Number.isFinite(v))
      .sort((a, b) => a - b)
    // For ATR_entry (no data yet) or any metric with too few samples, write
    // NaN sentinels so the consumer can detect "no thresholds, no buckets".
    // The schema column is `numeric` so we store 0 as a placeholder — the
    // bucketing functions short-circuit on null inputs anyway.
    if (vals.length < 10) {
      out.push({ metric, median: 0, tertile_low: 0, tertile_high: 0, updated_at: now })
      continue
    }
    out.push({
      metric,
      median: percentile(vals, 0.5),
      tertile_low: percentile(vals, 1 / 3),
      tertile_high: percentile(vals, 2 / 3),
      updated_at: now,
    })
  }
  return out
}

// ─── Bucketing ───────────────────────────────────────────────────────────────

const METRICS: ConditionMetric[] = ['RVOL', 'DR_ADR', 'IB', 'ATR_730', 'ATR_entry']
const FIELD_MAP: Record<ConditionMetric, keyof MetricRow> = {
  RVOL: 'rvol', DR_ADR: 'dr_adr', IB: 'ib', ATR_730: 'atr_730', ATR_entry: 'atr_entry',
}

interface BucketedTrade {
  trade: TradeLite
  median: Record<ConditionMetric, 'LOW' | 'HIGH' | null>
  tertile: Record<ConditionMetric, 'L' | 'M' | 'H' | null>
}

export function bucketTrades(
  trades: TradeLite[],
  metricsByDate: Map<string, MetricRow>,
  thresholds: ConditionThreshold[],
): BucketedTrade[] {
  const byMetric = new Map(thresholds.map(t => [t.metric, t]))
  const out: BucketedTrade[] = []
  for (const t of trades) {
    const m = metricsByDate.get(t.date)
    if (!m) continue
    const median = {} as Record<ConditionMetric, 'LOW' | 'HIGH' | null>
    const tertile = {} as Record<ConditionMetric, 'L' | 'M' | 'H' | null>
    for (const metric of METRICS) {
      const v = m[FIELD_MAP[metric]]
      const th = byMetric.get(metric)
      if (v == null || !th || th.median === 0) {
        median[metric] = null
        tertile[metric] = null
        continue
      }
      median[metric] = v > th.median ? 'HIGH' : 'LOW'
      tertile[metric] = v <= th.tertile_low ? 'L' : v <= th.tertile_high ? 'M' : 'H'
    }
    out.push({ trade: t, median, tertile })
  }
  return out
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

/** Wilson 95% CI for a proportion. Returns null when n is 0. */
function wilsonCI(wins: number, n: number): { lo: number; hi: number } | null {
  if (n === 0) return null
  const z = 1.96
  const p = wins / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) }
}

/** Mean ± 1.96 × SE as a normal-approximation CI on EV. */
function normalCI(values: number[]): { mean: number; lo: number; hi: number } | null {
  if (values.length === 0) return null
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  if (values.length < 2) return { mean, lo: NaN, hi: NaN }
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  const se = Math.sqrt(variance / values.length)
  return { mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se }
}

/** Two-proportion z-test, returns two-tailed p-value. */
function twoPropZ(w1: number, n1: number, w2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 1
  const p1 = w1 / n1, p2 = w2 / n2
  const pPool = (w1 + w2) / (n1 + n2)
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2))
  if (se === 0) return 1
  const z = (p1 - p2) / se
  // Standard normal CDF via error function (Abramowitz & Stegun 7.1.26)
  const erf = (x: number): number => {
    const sign = Math.sign(x)
    const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429]
    const p = 0.3275911
    const ax = Math.abs(x)
    const t = 1 / (1 + p * ax)
    const y = 1 - (((((a[4] * t + a[3]) * t) + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-ax * ax)
    return sign * y
  }
  const cdf = 0.5 * (1 + erf(z / Math.sqrt(2)))
  return 2 * Math.min(cdf, 1 - cdf)
}

// ─── Aggregation per combo ───────────────────────────────────────────────────

interface AggregateStats {
  n_trades: number
  n_sessions: number
  wins: number
  losses: number
  total_pnl: number
  trade_wr: number | null
  trade_wr_ci_lo: number | null
  trade_wr_ci_hi: number | null
  day_wr: number | null
  ev_per_trade: number | null
  ev_ci_lo: number | null
  ev_ci_hi: number | null
  ev_ci_excludes_zero: boolean | null
  profit_factor: number | null
}

function aggregate(matched: BucketedTrade[]): AggregateStats {
  const trades = matched.map(b => b.trade).filter(t => t.pnl != null)
  const pnls = trades.map(t => t.pnl!).filter(Number.isFinite)
  const wins = pnls.filter(p => p > 0).length
  const losses = pnls.filter(p => p < 0).length
  const total_pnl = pnls.reduce((s, v) => s + v, 0)
  const dates = new Set(matched.map(b => b.trade.date))
  const n_trades = pnls.length
  const n_sessions = dates.size
  const wr = wins + losses > 0 ? wins / (wins + losses) : null
  const wilson = wr != null ? wilsonCI(wins, wins + losses) : null
  const evRes = normalCI(pnls)
  const sumW = pnls.filter(p => p > 0).reduce((s, v) => s + v, 0)
  const sumL = pnls.filter(p => p < 0).reduce((s, v) => s + v, 0)
  const pf = sumL < 0 ? sumW / Math.abs(sumL) : (sumW > 0 ? Infinity : null)
  // Per-day PnL for day win rate
  const dayPnl = new Map<string, number>()
  for (const b of matched) {
    if (b.trade.pnl == null) continue
    dayPnl.set(b.trade.date, (dayPnl.get(b.trade.date) ?? 0) + b.trade.pnl)
  }
  const winDays = [...dayPnl.values()].filter(v => v > 0).length
  const day_wr = dayPnl.size > 0 ? winDays / dayPnl.size : null
  const evExcludesZero = evRes && Number.isFinite(evRes.lo) && Number.isFinite(evRes.hi)
    ? (evRes.lo > 0 || evRes.hi < 0)
    : null
  return {
    n_trades, n_sessions, wins, losses, total_pnl,
    trade_wr: wr,
    trade_wr_ci_lo: wilson?.lo ?? null,
    trade_wr_ci_hi: wilson?.hi ?? null,
    day_wr,
    ev_per_trade: evRes?.mean ?? null,
    ev_ci_lo: evRes?.lo ?? null,
    ev_ci_hi: evRes?.hi ?? null,
    ev_ci_excludes_zero: evExcludesZero,
    profit_factor: pf === Infinity ? null : pf,  // schema is numeric — null Infinity
  }
}

// ─── Verdict assignment ──────────────────────────────────────────────────────

const VERDICT_RANK: Record<ConditionVerdict, number> = {
  GREEN_ROBUST: 1,
  GREEN_DIRECTIONAL: 2,
  YELLOW_FLAT_POS: 3,
  YELLOW_FLAT_NEG: 4,
  RED_DIRECTIONAL: 5,
  INSUFFICIENT_DATA: 6,
}

interface VerdictInputs {
  stats: AggregateStats
  baselineWr: number
  baselineWins: number
  baselineN: number
}

function assignVerdict(v: VerdictInputs): {
  verdict: ConditionVerdict
  verdict_rank: number
  wr_pval_vs_baseline: number | null
  wr_sig_5pct: boolean | null
  n_adequate: boolean
  n_reliable: boolean
} {
  const { stats, baselineWins, baselineN } = v
  const n_adequate = stats.n_trades >= 10 && stats.n_sessions >= 5
  const n_reliable = stats.n_trades >= 30 && stats.n_sessions >= 10
  // Insufficient data: too few trades to say anything meaningful
  if (stats.n_trades < 5) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      verdict_rank: VERDICT_RANK.INSUFFICIENT_DATA,
      wr_pval_vs_baseline: null,
      wr_sig_5pct: null,
      n_adequate, n_reliable,
    }
  }
  const pval = twoPropZ(stats.wins, stats.wins + stats.losses, baselineWins, baselineN)
  const sig = pval < 0.05
  const evPos = (stats.ev_per_trade ?? 0) > 0
  const evNeg = (stats.ev_per_trade ?? 0) < 0
  // Verdict logic:
  //   GREEN_ROBUST     = reliable sample + EV > 0 + WR significantly above baseline + PF >= 1.3
  //   GREEN_DIRECTIONAL= adequate sample + EV > 0 + WR significantly above baseline
  //   RED_DIRECTIONAL  = adequate sample + EV < 0 + WR significantly below baseline
  //   YELLOW_FLAT_POS  = positive EV but not statistically significant (or marginal sample)
  //   YELLOW_FLAT_NEG  = negative EV but not statistically significant
  let verdict: ConditionVerdict
  if (n_reliable && sig && evPos && (stats.profit_factor ?? 0) >= 1.3) verdict = 'GREEN_ROBUST'
  else if (n_adequate && sig && evPos) verdict = 'GREEN_DIRECTIONAL'
  else if (n_adequate && sig && evNeg) verdict = 'RED_DIRECTIONAL'
  else if (evPos) verdict = 'YELLOW_FLAT_POS'
  else if (evNeg) verdict = 'YELLOW_FLAT_NEG'
  else verdict = 'INSUFFICIENT_DATA'  // EV exactly 0 with adequate sample
  return {
    verdict,
    verdict_rank: VERDICT_RANK[verdict],
    wr_pval_vs_baseline: pval,
    wr_sig_5pct: sig,
    n_adequate, n_reliable,
  }
}

// ─── Combo enumeration ──────────────────────────────────────────────────────

type MedianBucket = 'LOW' | 'HIGH'
type TertileBucket = 'L' | 'M' | 'H'

/** All non-empty subsets of {1,2,3} metrics from the 5-metric list. */
function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = []
  const helper = (start: number, picked: T[]) => {
    if (picked.length === k) { out.push([...picked]); return }
    for (let i = start; i < arr.length; i++) {
      picked.push(arr[i])
      helper(i + 1, picked)
      picked.pop()
    }
  }
  helper(0, [])
  return out
}

/** Generate condition_id string from per-metric bucket values. */
function makeConditionId(buckets: Record<ConditionMetric, string>): string {
  return `${buckets.RVOL}_${buckets.DR_ADR}_${buckets.IB}_${buckets.ATR_730}_${buckets.ATR_entry}`
}

/** Match a bucketed trade against a constraint (mode + per-metric bucket constraints). */
function matchesConstraint(
  bt: BucketedTrade,
  constraint: Record<ConditionMetric, string>,
  mode: 'median' | 'tertile',
): boolean {
  for (const metric of METRICS) {
    const c = constraint[metric]
    if (c === 'ANY') continue
    const actual = mode === 'median' ? bt.median[metric] : bt.tertile[metric]
    if (actual == null) return false
    if (actual !== c) return false
  }
  return true
}

// ─── Top-level: build the full lookup ───────────────────────────────────────

/** Main entry: takes trades + a date→metric lookup + thresholds → full lookup
 *  rows. The route is responsible for joining metric rows to dates (since
 *  market_context is keyed by trading_day_id, not date) and passing the
 *  joined `metricsByDate` map. */
export function buildLookupRows(
  trades: TradeLite[],
  metricsByDate: Map<string, MetricRow>,
  thresholds: ConditionThreshold[],
): ConditionLookupRow[] {
  const bucketed = bucketTrades(trades, metricsByDate, thresholds)

  // Baseline = all trades, all bucket constraints ANY
  const baselineStats = aggregate(bucketed)
  const baselineWins = baselineStats.wins
  const baselineN = baselineStats.wins + baselineStats.losses
  const baselineWr = baselineN > 0 ? baselineWins / baselineN : 0.5

  const rows: ConditionLookupRow[] = []

  const baseConstraint: Record<ConditionMetric, string> = {
    RVOL: 'ANY', DR_ADR: 'ANY', IB: 'ANY', ATR_730: 'ANY', ATR_entry: 'ANY',
  }

  // ─── BASELINE ─────────
  {
    const v = assignVerdict({ stats: baselineStats, baselineWr, baselineWins, baselineN })
    const cid = makeConditionId(baseConstraint)
    rows.push(buildRow(cid, 'BASELINE', 0, { ...baseConstraint }, baselineStats, v, 0))
  }

  // ─── 1-way / 2-way / 3-way × {median, tertile} ─────────
  // 3-way_tertile combos (5 × 3^3 = 135 rows) push us well past the
  // original ~236-row footprint and tertile-3-way is rarely populated.
  // Match the original shape: BASELINE + 1/2-way × {median,tertile} + 3-way_median only.
  const medianBuckets: MedianBucket[] = ['LOW', 'HIGH']
  const tertileBuckets: TertileBucket[] = ['L', 'M', 'H']

  for (const k of [1, 2, 3] as const) {
    for (const subset of combinations(METRICS, k)) {
      const combos = k === 1 ? medianBuckets.map(b => ({ [subset[0]]: b }))
        : k === 2 ? medianBuckets.flatMap(a => medianBuckets.map(b => ({ [subset[0]]: a, [subset[1]]: b })))
        : medianBuckets.flatMap(a => medianBuckets.flatMap(b => medianBuckets.map(c => ({ [subset[0]]: a, [subset[1]]: b, [subset[2]]: c }))))
      const combo_type = (k === 3 ? '3-way_median' : `${k}-way_median`) as ConditionComboType
      const match_priority = k
      for (const c of combos) {
        const constraint = { ...baseConstraint, ...(c as Record<string, string>) }
        const matched = bucketed.filter(b => matchesConstraint(b, constraint, 'median'))
        const stats = aggregate(matched)
        const v = assignVerdict({ stats, baselineWr, baselineWins, baselineN })
        const cid = makeConditionId(constraint)
        rows.push(buildRow(cid, combo_type, k, constraint, stats, v, match_priority))
      }
    }
  }
  for (const k of [1, 2] as const) {
    for (const subset of combinations(METRICS, k)) {
      const combos = k === 1 ? tertileBuckets.map(b => ({ [subset[0]]: b }))
        : tertileBuckets.flatMap(a => tertileBuckets.map(b => ({ [subset[0]]: a, [subset[1]]: b })))
      const combo_type = `${k}-way_tertile` as ConditionComboType
      const match_priority = k
      for (const c of combos) {
        const constraint = { ...baseConstraint, ...(c as Record<string, string>) }
        const matched = bucketed.filter(b => matchesConstraint(b, constraint, 'tertile'))
        const stats = aggregate(matched)
        const v = assignVerdict({ stats, baselineWr, baselineWins, baselineN })
        const cid = makeConditionId(constraint)
        rows.push(buildRow(cid, combo_type, k, constraint, stats, v, match_priority))
      }
    }
  }

  return rows
}

function buildRow(
  condition_id: string,
  combo_type: ConditionComboType,
  specificity: number,
  constraint: Record<ConditionMetric, string>,
  stats: AggregateStats,
  v: ReturnType<typeof assignVerdict>,
  match_priority: number,
): ConditionLookupRow {
  return {
    condition_id,
    combo_type,
    specificity,
    verdict: v.verdict,
    verdict_rank: v.verdict_rank,
    rvol_b: constraint.RVOL,
    dr_adr_b: constraint.DR_ADR,
    ib_b: constraint.IB,
    atr_730_b: constraint.ATR_730,
    atr_entry_b: constraint.ATR_entry,
    n_trades: stats.n_trades,
    n_sessions: stats.n_sessions,
    n_adequate: v.n_adequate,
    n_reliable: v.n_reliable,
    trade_wr: stats.trade_wr,
    trade_wr_ci_lo: stats.trade_wr_ci_lo,
    trade_wr_ci_hi: stats.trade_wr_ci_hi,
    day_wr: stats.day_wr,
    ev_per_trade: stats.ev_per_trade,
    ev_ci_lo: stats.ev_ci_lo,
    ev_ci_hi: stats.ev_ci_hi,
    ev_ci_excludes_zero: stats.ev_ci_excludes_zero,
    total_pnl: stats.total_pnl,
    profit_factor: stats.profit_factor,
    wr_pval_vs_baseline: v.wr_pval_vs_baseline,
    wr_sig_5pct: v.wr_sig_5pct,
    match_priority,
  }
}
