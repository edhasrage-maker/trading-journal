/**
 * Performance-weighted buckets for prep-page market-state metrics.
 *
 * For each numeric metric (RVOL, ADR, IB size, ATR), this module splits the
 * trader's historical sessions into terciles (low / mid / high), computes
 * per-bucket day-level performance (win rate + avg PnL), and ranks the three
 * tiers by avg PnL so the best-performing one gets the green flag and the
 * worst gets red.
 *
 * The endpoint and UI surface a "Suggested: Bad/Mid/Good" hint next to each
 * flag row in the prep form, showing where today's value lands and how the
 * trader has historically performed when the metric was in that bucket.
 *
 * Day-level (not per-trade) on purpose: the question being answered is
 * "is THIS session likely to be a good day for me?", not "is each individual
 * trade likely to be a winner?". Per-day aggregation matches that question.
 */

export type PerfFlag = 'red' | 'yellow' | 'green'
export type Tier = 'low' | 'mid' | 'high'

export interface BucketStats {
  tier: Tier
  /** Inclusive lower bound, exclusive upper. null = open on that side. */
  range: [number | null, number | null]
  count: number
  win_rate: number          // % of days in this bucket where day_pnl > 0
  avg_pnl: number           // mean day_pnl across the bucket
  /** Relative rank: best avg_pnl bucket gets green, middle yellow, worst red. */
  performance_flag: PerfFlag
}

export interface MetricBuckets {
  buckets: BucketStats[]
  total_days_sampled: number
  /** True when fewer than 9 qualifying days were available — buckets is empty in that case. */
  insufficient_data: boolean
}

/** What the prep page's FlagRow needs to render a hint. */
export interface MetricSuggestion {
  flag: PerfFlag
  tier: Tier
  win_rate: number
  avg_pnl: number
  count: number
  range: [number | null, number | null]
}

/** One historical day's input row (value + outcome) for one metric. */
export interface DaySample {
  value: number
  pnl: number
}

/** Build the bucket structure for a single metric from raw daily samples. */
export function computeBuckets(samples: DaySample[]): MetricBuckets {
  if (samples.length < 9) {
    return { buckets: [], total_days_sampled: samples.length, insufficient_data: true }
  }

  const sorted = [...samples].sort((a, b) => a.value - b.value)
  const t1 = sorted[Math.floor(sorted.length / 3)].value
  const t2 = sorted[Math.floor((2 * sorted.length) / 3)].value

  const low = sorted.filter(s => s.value < t1)
  const mid = sorted.filter(s => s.value >= t1 && s.value < t2)
  const high = sorted.filter(s => s.value >= t2)

  const summarize = (tier: Tier, range: [number | null, number | null], s: DaySample[]): Omit<BucketStats, 'performance_flag'> => ({
    tier,
    range,
    count: s.length,
    win_rate: s.length > 0 ? s.filter(x => x.pnl > 0).length / s.length : 0,
    avg_pnl: s.length > 0 ? s.reduce((acc, x) => acc + x.pnl, 0) / s.length : 0,
  })

  const stats = [
    summarize('low', [null, t1], low),
    summarize('mid', [t1, t2], mid),
    summarize('high', [t2, null], high),
  ]

  // Rank by avg_pnl descending to assign performance_flag, then restore
  // tier order for display so the UI always sees [low, mid, high].
  const byPnl = [...stats].sort((a, b) => b.avg_pnl - a.avg_pnl)
  const flags: Record<Tier, PerfFlag> = { low: 'red', mid: 'yellow', high: 'red' }
  flags[byPnl[0].tier] = 'green'
  flags[byPnl[1].tier] = 'yellow'
  flags[byPnl[2].tier] = 'red'

  const buckets: BucketStats[] = stats.map(s => ({ ...s, performance_flag: flags[s.tier] }))

  return {
    buckets,
    total_days_sampled: samples.length,
    insufficient_data: false,
  }
}

/** Find which bucket today's value lands in. Returns null if data is insufficient. */
export function suggestFlag(value: number | null | undefined, m: MetricBuckets): MetricSuggestion | null {
  if (value == null || m.insufficient_data || m.buckets.length === 0) return null
  for (const b of m.buckets) {
    const [lo, hi] = b.range
    const aboveLo = lo == null || value >= lo
    const belowHi = hi == null || value < hi
    if (aboveLo && belowHi) {
      return {
        flag: b.performance_flag,
        tier: b.tier,
        win_rate: b.win_rate,
        avg_pnl: b.avg_pnl,
        count: b.count,
        range: b.range,
      }
    }
  }
  // Outside all buckets (extreme value below lowest sample OR above highest).
  // Snap to the nearest end-bucket — high values to "high", low to "low".
  const low = m.buckets[0]
  const high = m.buckets[m.buckets.length - 1]
  const target = low.range[0] != null && value < low.range[0] ? low : high
  return {
    flag: target.performance_flag,
    tier: target.tier,
    win_rate: target.win_rate,
    avg_pnl: target.avg_pnl,
    count: target.count,
    range: target.range,
  }
}
