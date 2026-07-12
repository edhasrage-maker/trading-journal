import type { EodAiAnalysis, ExecutionScore, ProcessVerdict, RuleStatus } from '@/lib/supabase/types'

/**
 * One TapeScore (Ruleset amendment 5, 2026-07-12).
 *
 * A single 0-100 headline per session, DERIVED from the three existing
 * scoring layers — never produced by the AI, never stored. Deriving at read
 * time means every historical row gets a TapeScore for free and future
 * re-weights can't strand stale stored values.
 *
 *   TapeScore = round(0.50·Rules + 0.35·Execution + 0.15·Prep)
 *
 *   Rules     = pass_count/5 × 100 over the five safety rails
 *   Execution = execution.composite × 100 (ran-but-unscoreable → 0)
 *   Prep      = prep quality score (1-10) × 10
 *
 * Missing components renormalize the remaining weights. Breach sessions
 * (≤3/5 rails) are capped at 49 so they can never render green or amber.
 * The word "Compliance" is retired from user-facing copy — the verdict
 * surfaces as "Rules kept n/5".
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
    rules: number | null
    execution: number | null
    prep: number | null
    /** Safety rails passed, 0-5. Null on legacy-basis rows. */
    passCount: number | null
    /** Re-derived from passCount ≥ 4 — not the stored verdict, so
     *  pre-amendment rows judged under other thresholds stay comparable. */
    verdict: 'Compliant' | 'Breach' | null
  }
}

const W_RULES = 0.5
const W_EXECUTION = 0.35
const W_PREP = 0.15
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
  /** Prep AI quality score, 1-10 (`ai_analysis_json.score`). */
  prepScore?: number | null
}

export function computeTapeScore(input: TapeScoreInput): TapeScoreResult | null {
  const { process, execution, legacyScore, prepScore } = input

  const passCount = process?.per_rule ? railPassCount(process) : null
  const rules = passCount != null ? (passCount / 5) * 100 : null
  // Execution object present but composite null = the analysis ran and zero
  // trades were scoreable — that IS a 0, not missing data (matches the
  // dashboard's overall_grade convention).
  const exec = execution != null
    ? (execution.composite != null ? clamp01(execution.composite) * 100 : 0)
    : null
  const prep = prepScore != null ? clamp(prepScore, 0, 10) * 10 : null

  // A prep score alone never makes a TapeScore — the day reads as
  // unanalyzed until an EOD analysis (or a legacy score) exists.
  if (rules == null && exec == null) {
    if (legacyScore == null) return null
    const score = Math.round(clamp(legacyScore, 0, 10) * 10)
    return {
      score,
      band: tapeScoreBand(score),
      basis: 'legacy',
      capped: false,
      components: { rules: null, execution: null, prep, passCount: null, verdict: null },
    }
  }

  let weighted = 0
  let weightSum = 0
  if (rules != null) { weighted += W_RULES * rules; weightSum += W_RULES }
  if (exec != null) { weighted += W_EXECUTION * exec; weightSum += W_EXECUTION }
  if (prep != null) { weighted += W_PREP * prep; weightSum += W_PREP }
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
      rules: rules != null ? Math.round(rules) : null,
      execution: exec != null ? Math.round(exec) : null,
      prep: prep != null ? Math.round(prep) : null,
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
  const { passCount, execution } = r.components
  const execQualifier =
    execution == null ? '' :
    execution >= 70 ? ' Execution was sharp.' :
    execution >= 50 ? ' Execution was mixed.' :
    ' Execution lagged.'
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
  /** Mean component values across days where each was present. */
  rules: number | null
  execution: number | null
  prep: number | null
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
    rules: roundedMean(scored.map(d => d.components.rules)),
    execution: roundedMean(scored.map(d => d.components.execution)),
    prep: roundedMean(scored.map(d => d.components.prep)),
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
