import type { EodAiAnalysis, ExecutionScore, ProcessVerdict, RuleStatus } from '@/lib/supabase/types'

/**
 * One TapeScore (Ruleset amendment 6, 2026-07-23).
 *
 * A single 0-100 headline per session, DERIVED from the existing scoring
 * layers — never produced by the AI, never stored. Deriving at read time means
 * every historical row gets a TapeScore for free and re-weights can't strand
 * stale stored values.
 *
 *   TapeScore = round(0.50·Risk + 0.30·Entry + 0.20·Capture)
 *
 *   Risk    = pass_count/5 × 100 over the five safety rails (the old "Rules")
 *   Entry   = the execution composite with MFE-capture REMOVED, renormalized
 *             (execution parameters 41 / prep adherence 24 / profit factor 11
 *             → /76), × 100. Ran-but-unscoreable → 0.
 *   Capture = mfe_capture × 100 — profit capture as its OWN axis.
 *
 * AMENDMENT 6 (2026-07-23, founder-directed) — the score now decomposes into
 * the same three axes the Review composition ring shows, mapping the trade
 * lifecycle: manage risk → enter well → exit well. Two deliberate changes:
 *   • Plan-quality (the old "Prep" 15% component) is DROPPED — Capture replaces
 *     it. A morning plan is an input to a decision, not a graded decision.
 *   • Capture is pulled OUT of the execution composite so it isn't
 *     double-counted: Entry is execution WITHOUT capture, Capture stands alone.
 * Weights moved 50/35/15 → 50/30/20. Risk stays dominant (safety-rail
 * philosophy). This re-scores history — intended, and the point of the change.
 *
 * Missing components renormalize the remaining weights. Breach sessions
 * (≤3/5 rails) are capped at 49 so they can never render green or amber.
 */

export type TapeScoreBand = 'high' | 'mid' | 'low'

export interface TapeScoreResult {
  /** 0-100 integer headline. */
  score: number
  band: TapeScoreBand
  /** 'v15' = derived from process/execution layers; 'legacy' = pre-v1.3 row
   *  that only carries the single 0-10 `score` field (scaled ×10). */
  basis: 'v15' | 'legacy'
  /** True when the Breach cap (≤49) lowered the weighted blend. */
  capped: boolean
  components: {
    /** Safety-rail score, 0-100 (pass_count/5 × 100). The 50% axis. */
    risk: number | null
    /** Entry quality, 0-100 — execution composite minus capture. The 30% axis. */
    entry: number | null
    /** Profit capture, 0-100 (mfe_capture × 100). The 20% axis. */
    capture: number | null
    /** Safety rails passed, 0-5. Null on legacy-basis rows. */
    passCount: number | null
    /** Re-derived from passCount ≥ 4 — not the stored verdict, so
     *  pre-amendment rows judged under other thresholds stay comparable. */
    verdict: 'Compliant' | 'Breach' | null
  }
}

const W_RISK = 0.5
const W_ENTRY = 0.3
const W_CAPTURE = 0.2
const BREACH_CAP = 49

export function tapeScoreBand(score: number): TapeScoreBand {
  return score >= 70 ? 'high' : score >= 50 ? 'mid' : 'low'
}

/** Safety-rail pass count with the legacy P1-P7 remap: pre-amendment-3 rows
 *  (detected by a P6/P7 key) keep P1-P3, map old P5 (cooldown) → P4 and old
 *  P6 (trade cap) → P5, and drop old P4/P7 (stop/setup validity — those
 *  moved into Execution Parameters). Rows already on the 5-rail shape count
 *  P1-P5 directly. */
export function railPassCount(process: ProcessVerdict): number {
  const perRule = process.per_rule as Record<string, RuleStatus | undefined>
  const isLegacyShape = 'P6' in perRule || 'P7' in perRule
  const railIds = isLegacyShape
    ? ['P1', 'P2', 'P3', 'P5', 'P6']
    : ['P1', 'P2', 'P3', 'P4', 'P5']
  let pass = 0
  for (const id of railIds) {
    if (perRule[id]?.status === 'pass') pass += 1
  }
  return pass
}

export interface TapeScoreInput {
  process?: ProcessVerdict | null
  execution?: ExecutionScore | null
  /** Pre-v1.3 rows: the single 0-10 `score` field. */
  legacyScore?: number | null
  /** @deprecated Amendment 6 dropped plan quality from the score — Capture
   *  replaced it. Still accepted so existing call sites compile; ignored. */
  prepScore?: number | null
}

/** Map a profit factor to the 0..1 sub-metric scale the composite uses
 *  (PF ≥ 2.0 maxes out). Mirrors profitFactorToSubMetric in eod-prompt.ts —
 *  duplicated here so this module stays free of the heavy AI-prompt deps that
 *  every server page importing tapescore would otherwise pull in. */
function pfToSubMetric(pf: number | null): number | null {
  return pf == null ? null : Math.max(0, Math.min(1, pf / 2))
}

/** Entry-quality (0..1) — the execution composite with MFE-capture pulled OUT
 *  (capture is its own axis now, amendment 6). Renormalizes the remaining
 *  sub-metrics (execution parameters 41 / prep adherence 24 / profit factor 11
 *  → /76). Null when none are scoreable; falls back to the stored composite for
 *  legacy rows that carry no sub-metrics. */
function entryFromExecution(e: ExecutionScore): number | null {
  const pfScore = pfToSubMetric(e.profit_factor ?? null) ?? (e.planned_vs_realized_rr ?? null)
  const parts: Array<[number | null, number]> = [
    [e.execution_parameters, 0.41],
    [e.prep_adherence, 0.24],
    [pfScore, 0.11],
  ]
  let num = 0, den = 0
  for (const [v, w] of parts) {
    if (v == null) continue
    num += v * w
    den += w
  }
  if (den > 0) return num / den
  // No sub-metrics stored — a legacy row that only kept the blended composite.
  // Use it as-is so the row still scores rather than dropping to null.
  return e.composite ?? null
}

export function computeTapeScore(input: TapeScoreInput): TapeScoreResult | null {
  const { process, execution, legacyScore } = input

  const passCount = process?.per_rule ? railPassCount(process) : null
  const risk = passCount != null ? (passCount / 5) * 100 : null

  // Split execution into Entry (composite minus capture) and Capture. An
  // execution object whose sub-metrics are all null means the analysis ran and
  // nothing was scoreable — a real 0 on both axes, not missing data (matches
  // the dashboard's overall_grade convention).
  let entry: number | null = null
  let capture: number | null = null
  if (execution != null) {
    const e = entryFromExecution(execution)
    entry = e != null ? clamp01(e) * 100 : null
    capture = execution.mfe_capture != null ? clamp01(execution.mfe_capture) * 100 : null
    if (entry == null && capture == null) { entry = 0; capture = 0 }
  }

  // Rails alone never make a TapeScore without an execution read either — the
  // day reads as unanalyzed until an EOD analysis (or a legacy score) exists.
  if (risk == null && entry == null && capture == null) {
    if (legacyScore == null) return null
    const score = Math.round(clamp(legacyScore, 0, 10) * 10)
    return {
      score,
      band: tapeScoreBand(score),
      basis: 'legacy',
      capped: false,
      components: { risk: null, entry: null, capture: null, passCount: null, verdict: null },
    }
  }

  let weighted = 0
  let weightSum = 0
  if (risk != null) { weighted += W_RISK * risk; weightSum += W_RISK }
  if (entry != null) { weighted += W_ENTRY * entry; weightSum += W_ENTRY }
  if (capture != null) { weighted += W_CAPTURE * capture; weightSum += W_CAPTURE }
  let score = Math.round(weighted / weightSum)

  const verdict: 'Compliant' | 'Breach' | null =
    passCount != null ? (passCount >= 4 ? 'Compliant' : 'Breach') : null
  let capped = false
  if (verdict === 'Breach' && score > BREACH_CAP) {
    score = BREACH_CAP
    capped = true
  }

  return {
    score,
    band: tapeScoreBand(score),
    basis: 'v15',
    capped,
    components: {
      risk: risk != null ? Math.round(risk) : null,
      entry: entry != null ? Math.round(entry) : null,
      capture: capture != null ? Math.round(capture) : null,
      passCount,
      verdict,
    },
  }
}

/** Convenience wrapper over the stored analysis blobs. */
export function tapeScoreFromAnalyses(
  eod: EodAiAnalysis | null | undefined,
  prepScore: number | null | undefined,
): TapeScoreResult | null {
  return computeTapeScore({
    process: eod?.process ?? null,
    execution: eod?.execution ?? null,
    legacyScore: eod?.score ?? null,
    prepScore: prepScore ?? null,
  })
}

/** Deterministic one-sentence day verdict — the fallback when the analysis
 *  row predates the AI `headline` field. Decision quality, never P&L. */
export function tapeScoreDaySentence(r: TapeScoreResult): string {
  if (r.basis === 'legacy') return 'Scored under an earlier rubric.'
  const { passCount, entry } = r.components
  const execQualifier =
    entry == null ? '' :
    entry >= 70 ? ' Entries were sharp.' :
    entry >= 50 ? ' Entries were mixed.' :
    ' Entries lagged.'
  if (passCount == null) return 'Execution-only read — no rules audit on this day.'
  if (passCount === 5) return `Clean tape — all five rules held.${execQualifier}`
  if (passCount === 4) return `One rule slipped — kept 4 of 5.${execQualifier}`
  return `Rules broke down — kept ${passCount} of 5.${execQualifier}`
}

export interface TapeScorePeriod {
  /** Mean of day TapeScores over scored days; null when none scored. */
  score: number | null
  band: TapeScoreBand | null
  /** Days that produced a TapeScore (any basis). */
  scoredDays: number
  /** Days with a rails verdict / days of those that were Compliant (≥4/5). */
  verdictDays: number
  compliantDays: number
  /** Mean axis values across days where each was present. */
  risk: number | null
  entry: number | null
  capture: number | null
}

export function aggregateTapeScore(days: (TapeScoreResult | null | undefined)[]): TapeScorePeriod {
  const scored = days.filter((d): d is TapeScoreResult => d != null)
  const withVerdict = scored.filter(d => d.components.verdict != null)
  const score = mean(scored.map(d => d.score))
  return {
    score: score != null ? Math.round(score) : null,
    band: score != null ? tapeScoreBand(Math.round(score)) : null,
    scoredDays: scored.length,
    verdictDays: withVerdict.length,
    compliantDays: withVerdict.filter(d => d.components.verdict === 'Compliant').length,
    risk: roundedMean(scored.map(d => d.components.risk)),
    entry: roundedMean(scored.map(d => d.components.entry)),
    capture: roundedMean(scored.map(d => d.components.capture)),
  }
}

/** Deterministic period verdict for the dashboard hero. */
export function tapeScorePeriodSentence(p: TapeScorePeriod): string | null {
  if (p.score == null) return null
  if (p.verdictDays === 0) return 'Not enough rules audits in this period to judge discipline.'
  const rate = p.compliantDays / p.verdictDays
  const lead = rate >= 0.85 ? 'Discipline held.' : rate >= 0.6 ? 'Discipline mostly held.' : 'Discipline slipped.'
  return `${lead} ${p.compliantDays} of ${p.verdictDays} sessions kept the rules.`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}
function clamp01(v: number): number {
  return clamp(v, 0, 1)
}
function mean(values: (number | null | undefined)[]): number | null {
  const nums = values.filter((v): v is number => v != null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
function roundedMean(values: (number | null | undefined)[]): number | null {
  const m = mean(values)
  return m != null ? Math.round(m) : null
}
