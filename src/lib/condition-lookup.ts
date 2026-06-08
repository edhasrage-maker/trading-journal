import type {
  ConditionLookupRow,
  ConditionMetric,
  ConditionThreshold,
  ConditionVerdict,
} from '@/lib/supabase/types'

/**
 * Pure functions for the morning prep condition filter.
 *
 * Given today's 5 metric values + the thresholds table + the lookup table,
 * compute median + tertile bucket assignments, find the most-specific matching
 * row for each, and consolidate the two views into a single verdict.
 */

export type MedianBucket = 'LOW' | 'HIGH'
export type TertileBucket = 'L' | 'M' | 'H'

export interface MetricInputs {
  rvol: number | null
  dr_adr: number | null
  ib: number | null
  atr_730: number | null
  atr_entry: number | null
}

export interface BucketAssignment {
  metric: ConditionMetric
  value: number | null
  median_bucket: MedianBucket | null      // null if value is null
  tertile_bucket: TertileBucket | null
  median_threshold: number
  tertile_low: number
  tertile_high: number
}

export interface MatchResult {
  row: ConditionLookupRow
  used_buckets: Record<ConditionMetric, string | 'ANY'>
}

export interface LookupOutcome {
  buckets: BucketAssignment[]
  best_median: MatchResult | null
  best_tertile: MatchResult | null
  consolidated: {
    pick: 'median' | 'tertile'
    verdict: ConditionVerdict | null
    condition_id: string | null
    explanation: string
  }
  conflict: boolean
  conflict_reason: string | null
}

// Ordered metric keys (must match column names on rows)
const METRIC_KEYS: ConditionMetric[] = ['RVOL', 'DR_ADR', 'IB', 'ATR_730', 'ATR_entry']

// Map metric → input field name
const INPUT_FIELD: Record<ConditionMetric, keyof MetricInputs> = {
  RVOL: 'rvol',
  DR_ADR: 'dr_adr',
  IB: 'ib',
  ATR_730: 'atr_730',
  ATR_entry: 'atr_entry',
}

// Map metric → corresponding bucket column on the lookup row
const BUCKET_COL: Record<ConditionMetric, keyof ConditionLookupRow> = {
  RVOL: 'rvol_b',
  DR_ADR: 'dr_adr_b',
  IB: 'ib_b',
  ATR_730: 'atr_730_b',
  ATR_entry: 'atr_entry_b',
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucketing
// ─────────────────────────────────────────────────────────────────────────────

export function bucketMedian(value: number | null, median: number): MedianBucket | null {
  if (value == null || !Number.isFinite(value)) return null
  return value > median ? 'HIGH' : 'LOW'
}

export function bucketTertile(
  value: number | null,
  tertileLow: number,
  tertileHigh: number,
): TertileBucket | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value <= tertileLow) return 'L'
  if (value <= tertileHigh) return 'M'
  return 'H'
}

export function assignBuckets(
  inputs: MetricInputs,
  thresholds: ConditionThreshold[],
): BucketAssignment[] {
  const byMetric = new Map(thresholds.map(t => [t.metric, t]))
  return METRIC_KEYS.map(metric => {
    const t = byMetric.get(metric)
    if (!t) {
      // Threshold not configured for this metric — surface a placeholder
      return {
        metric,
        value: inputs[INPUT_FIELD[metric]],
        median_bucket: null,
        tertile_bucket: null,
        median_threshold: NaN,
        tertile_low: NaN,
        tertile_high: NaN,
      }
    }
    const value = inputs[INPUT_FIELD[metric]]
    return {
      metric,
      value,
      median_bucket: bucketMedian(value, t.median),
      tertile_bucket: bucketTertile(value, t.tertile_low, t.tertile_high),
      median_threshold: t.median,
      tertile_low: t.tertile_low,
      tertile_high: t.tertile_high,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the most-specific lookup row matching the supplied bucket assignments
 * for the given mode ('median' uses LOW/HIGH; 'tertile' uses L/M/H).
 * Sort: specificity DESC, verdict_rank ASC.
 */
export function findBestMatch(
  buckets: BucketAssignment[],
  lookup: ConditionLookupRow[],
  mode: 'median' | 'tertile',
): MatchResult | null {
  const myBucketByMetric = new Map<ConditionMetric, string | null>()
  for (const b of buckets) {
    myBucketByMetric.set(b.metric, mode === 'median' ? b.median_bucket : b.tertile_bucket)
  }

  const filtered = lookup.filter(row => {
    // Match the combo type to the mode
    if (mode === 'median' && !row.combo_type.includes('median') && row.combo_type !== 'BASELINE') return false
    if (mode === 'tertile' && !row.combo_type.includes('tertile') && row.combo_type !== 'BASELINE') return false

    // Each metric: row's bucket must equal mine, or be 'ANY'
    for (const metric of METRIC_KEYS) {
      const rowBucket = row[BUCKET_COL[metric]] as string
      if (rowBucket === 'ANY') continue
      const myBucket = myBucketByMetric.get(metric)
      if (myBucket == null) return false // I don't have a value for this metric, can't match a non-ANY constraint
      if (rowBucket !== myBucket) return false
    }
    return true
  })

  if (filtered.length === 0) return null

  // Sort: specificity DESC, verdict_rank ASC
  filtered.sort((a, b) => {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity
    return a.verdict_rank - b.verdict_rank
  })

  const row = filtered[0]
  const used: Record<ConditionMetric, string | 'ANY'> = {} as Record<ConditionMetric, string | 'ANY'>
  for (const metric of METRIC_KEYS) {
    used[metric] = row[BUCKET_COL[metric]] as string
  }
  return { row, used_buckets: used }
}

// ─────────────────────────────────────────────────────────────────────────────
// Consolidation
// ─────────────────────────────────────────────────────────────────────────────

const VERDICT_FAMILY: Record<ConditionVerdict, 'GREEN' | 'RED' | 'YELLOW' | 'GRAY'> = {
  GREEN_ROBUST: 'GREEN',
  GREEN_DIRECTIONAL: 'GREEN',
  RED_DIRECTIONAL: 'RED',
  YELLOW_FLAT_POS: 'YELLOW',
  YELLOW_FLAT_NEG: 'YELLOW',
  INSUFFICIENT_DATA: 'GRAY',
}

/**
 * Pick the consolidated verdict between the median and tertile matches.
 *
 * Rule (2026-06-08 update): TERTILE is preferred whenever it exists — the
 * tighter bucket is a more specific match for today's actual conditions,
 * even if the sample is smaller. Median is the FALLBACK for when tertile
 * has insufficient data to produce a row (some metric had <9 historical
 * sessions, so its tertile thresholds aren't defined).
 *
 * Conflict flag still fires when median and tertile pick opposing GREEN
 * vs RED families — useful to surface even when we're committing to one.
 */
export function consolidate(
  bestMedian: MatchResult | null,
  bestTertile: MatchResult | null,
): LookupOutcome['consolidated'] & { conflict: boolean; conflict_reason: string | null } {
  if (!bestMedian && !bestTertile) {
    return {
      pick: 'tertile',
      verdict: null,
      condition_id: null,
      explanation: 'No matching lookup row in either view',
      conflict: false,
      conflict_reason: null,
    }
  }
  if (bestMedian && !bestTertile) {
    return {
      pick: 'median',
      verdict: bestMedian.row.verdict,
      condition_id: bestMedian.row.condition_id,
      explanation: 'Tertile had insufficient data — using median view as fallback',
      conflict: false,
      conflict_reason: null,
    }
  }
  if (!bestMedian && bestTertile) {
    return {
      pick: 'tertile',
      verdict: bestTertile.row.verdict,
      condition_id: bestTertile.row.condition_id,
      explanation: 'Only tertile view returned a match',
      conflict: false,
      conflict_reason: null,
    }
  }

  // Both present — tertile wins by default. Conflict still detected for the UI.
  const m = bestMedian!.row
  const t = bestTertile!.row

  const mf = VERDICT_FAMILY[m.verdict]
  const tf = VERDICT_FAMILY[t.verdict]
  const conflict = (mf === 'GREEN' && tf === 'RED') || (mf === 'RED' && tf === 'GREEN')
  const conflictReason = conflict
    ? `Median says ${VERDICT_DISPLAY[m.verdict]}, tertile says ${VERDICT_DISPLAY[t.verdict]} — they disagree on direction.`
    : null

  return {
    pick: 'tertile',
    verdict: t.verdict,
    condition_id: t.condition_id,
    explanation: `Tertile view selected (specificity ${t.specificity}). Use the dropdown above to switch to the median view.`,
    conflict,
    conflict_reason: conflictReason,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level
// ─────────────────────────────────────────────────────────────────────────────

export function runLookup(
  inputs: MetricInputs,
  thresholds: ConditionThreshold[],
  lookup: ConditionLookupRow[],
): LookupOutcome {
  const buckets = assignBuckets(inputs, thresholds)
  const bestMedian = findBestMatch(buckets, lookup, 'median')
  const bestTertile = findBestMatch(buckets, lookup, 'tertile')
  const con = consolidate(bestMedian, bestTertile)
  return {
    buckets,
    best_median: bestMedian,
    best_tertile: bestTertile,
    consolidated: {
      pick: con.pick,
      verdict: con.verdict,
      condition_id: con.condition_id,
      explanation: con.explanation,
    },
    conflict: con.conflict,
    conflict_reason: con.conflict_reason,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict display helpers (used by UI)
// ─────────────────────────────────────────────────────────────────────────────

export const VERDICT_LABELS: Record<ConditionVerdict, string> = {
  GREEN_ROBUST: 'Trade normally',
  GREEN_DIRECTIONAL: 'Trade normally, monitor',
  RED_DIRECTIONAL: 'Avoid, half-size, or sit out',
  YELLOW_FLAT_POS: 'Be selective',
  YELLOW_FLAT_NEG: 'Be cautious',
  INSUFFICIENT_DATA: 'No statistical basis',
}

// Short human-readable grades shown next to the action label in the UI.
// Internal codes (GREEN_ROBUST etc.) remain the storage/lookup keys — these
// strings are display-only, so renaming a grade here is safe and instant.
export const VERDICT_DISPLAY: Record<ConditionVerdict, string> = {
  GREEN_ROBUST: 'Grade A',
  GREEN_DIRECTIONAL: 'Grade B',
  YELLOW_FLAT_POS: 'Grade C',
  YELLOW_FLAT_NEG: 'Grade D',
  RED_DIRECTIONAL: 'Grade F',
  INSUFFICIENT_DATA: 'Ungraded',
}

export const VERDICT_EMOJI: Record<ConditionVerdict, string> = {
  GREEN_ROBUST: '🟢',
  GREEN_DIRECTIONAL: '🟢',
  RED_DIRECTIONAL: '🔴',
  YELLOW_FLAT_POS: '🟡',
  YELLOW_FLAT_NEG: '🟡',
  INSUFFICIENT_DATA: '⚪',
}

export const VERDICT_TONE: Record<ConditionVerdict, 'good' | 'bad' | 'neutral' | 'unknown'> = {
  GREEN_ROBUST: 'good',
  GREEN_DIRECTIONAL: 'good',
  RED_DIRECTIONAL: 'bad',
  YELLOW_FLAT_POS: 'neutral',
  YELLOW_FLAT_NEG: 'neutral',
  INSUFFICIENT_DATA: 'unknown',
}
