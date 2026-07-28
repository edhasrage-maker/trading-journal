// The machine-checkable half of the AI "trust layer" (Pt 21 ticket 7). The
// prose rules in eod-prompt.ts (NARRATIVE DISCIPLINE + the ruleset blocks) are
// the authoritative INSTRUCTIONS to the model; this file is their machine
// MIRROR — the checks that assert an actual output obeyed them. The eval harness
// (scripts/eval-ai-output.ts) imports these; a runtime validator could too.
//
// Kept dependency-light on purpose (types only) so it's trivially unit-testable
// and safe to import anywhere. The one cross-check that needs trades + the rail
// config — A7, deterministic-override agreement — lives in the harness, where
// computeDeterministicRules is already in scope.
//
// See docs/ai-output-constraints-eval-plan.md.

import type { EodAiAnalysis } from '@/lib/supabase/types'

export interface Violation {
  /** Constraint id, e.g. 'A5' or 'B2'. */
  id: string
  tier: 'A' | 'B'
  /** Human-readable description of what was violated. */
  message: string
  /** The offending text, when there is a specific span to show. */
  evidence?: string
}

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length

// A number that reads as a P&L figure: a `$` amount, a signed number, or a bare
// run of 3+ digits (P&L is ~≥$100). Deliberately conservative — "10 MNQ" (2
// digits) and "3 give-backs" (1 digit) don't trip it; "+$479" / "1,200" do.
const PNL_NUMBER = /\$\s?\d|[-+]\s?\$?\d|(?<!\d)\d{3,}(?:[.,]\d+)?/

// notes[] must be a diagnostic narrative, NOT a calculation trace. These mirror
// the LENGTH DISCIPLINE / notes rules in the EOD prompt.
export const CALC_TRACE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'per-trade arithmetic', re: /\bT\d+\b[^.]*\bM[AF]E\b[^.]*[=:]/i },
  { label: 'per-trade arithmetic', re: /\bM[AF]E\s*=\s*\d/i },
  { label: 'composite formula', re: /\d*\.?\d+\s*\*\s*\d*\.?\d+\s*[-+*]/ },
  { label: 'criterion-value list', re: /\b(setup_in_playbook|stop_in_atr_band|two_thirds_orderflow)\s*=\s*\d/i },
  { label: '"Reporting X = Y"', re: /\bReporting\b[^.]*=/i },
]

const AXIS_KEYS = ['mfe_capture', 'prep_adherence', 'execution_parameters', 'composite'] as const

const inUnit = (v: unknown): boolean => v == null || (typeof v === 'number' && v >= 0 && v <= 1)

/**
 * A1 — checks on the RAW model text, before parsing: it must be a bare JSON
 * object (no markdown fences, no prose wrapper). Returns [] when clean.
 */
export function checkRawOutput(rawText: string): Violation[] {
  const out: Violation[] = []
  const t = rawText.trim()
  if (/^```/.test(t) || /```\s*$/.test(t)) {
    out.push({ id: 'A1', tier: 'A', message: 'Output wrapped in markdown code fences', evidence: t.slice(0, 40) })
  }
  if (!t.startsWith('{') || !t.endsWith('}')) {
    out.push({ id: 'A1', tier: 'A', message: 'Output is not a bare JSON object (must start with { and end with })', evidence: `${t.slice(0, 20)}…${t.slice(-20)}` })
  }
  return out
}

/**
 * A2–A6, A8 — structural checks on a PARSED EodAiAnalysis. Pure; no I/O. Skips a
 * check when the relevant field is absent (legacy rows / partial outputs) rather
 * than inventing a violation — the eval fixtures declare which ids they expect.
 */
export function checkStructural(a: EodAiAnalysis): Violation[] {
  const out: Violation[] = []

  // A3 — verdict enum.
  if (a.process && a.process.verdict !== 'Compliant' && a.process.verdict !== 'Breach') {
    out.push({ id: 'A3', tier: 'A', message: `process.verdict must be Compliant|Breach`, evidence: String(a.process.verdict) })
  }

  // A4 — score ranges.
  if (a.score != null && (a.score < 0 || a.score > 10)) {
    out.push({ id: 'A4', tier: 'A', message: 'score out of range [0,10]', evidence: String(a.score) })
  }
  if (a.execution) {
    for (const k of AXIS_KEYS) {
      if (!inUnit(a.execution[k])) {
        out.push({ id: 'A4', tier: 'A', message: `execution.${k} out of [0,1]`, evidence: String(a.execution[k]) })
      }
    }
    const pf = a.execution.profit_factor
    if (pf != null && (typeof pf !== 'number' || pf < 0)) {
      out.push({ id: 'A4', tier: 'A', message: 'execution.profit_factor must be ≥ 0', evidence: String(pf) })
    }
  }

  // A5 — headline caps.
  if (a.headline != null) {
    if (words(a.headline) > 14) out.push({ id: 'A5', tier: 'A', message: 'top headline > 14 words', evidence: a.headline })
    if (/\bcompliance\b/i.test(a.headline)) out.push({ id: 'A5', tier: 'A', message: 'top headline uses the word "Compliance"', evidence: a.headline })
    if (PNL_NUMBER.test(a.headline)) out.push({ id: 'A5', tier: 'A', message: 'top headline contains a P&L number', evidence: a.headline })
  }
  for (const [obj, name] of [[a.process, 'process'], [a.execution, 'execution']] as const) {
    const h = (obj as { headline?: string } | undefined)?.headline
    if (h != null && words(h) > 15) out.push({ id: 'A5', tier: 'A', message: `${name}.headline > 15 words`, evidence: h })
  }

  // A6 — notes are narrative, not a calc trace.
  for (const [obj, name] of [[a.process, 'process'], [a.execution, 'execution']] as const) {
    const notes = (obj as { notes?: string } | undefined)?.notes
    if (!notes) continue
    for (const { label, re } of CALC_TRACE_PATTERNS) {
      const m = notes.match(re)
      if (m) { out.push({ id: 'A6', tier: 'A', message: `${name}.notes contains ${label}`, evidence: m[0] }); break }
    }
  }

  // A8 — bullet-count discipline.
  const caps: [keyof EodAiAnalysis, number][] = [
    ['what_worked', 4], ['mistakes', 5], ['patterns', 4], ['next_session_focus', 3],
  ]
  for (const [key, cap] of caps) {
    const arr = a[key]
    if (Array.isArray(arr) && arr.length > cap) {
      out.push({ id: 'A8', tier: 'A', message: `${key} has ${arr.length} bullets (cap ${cap})` })
    }
  }

  return out
}

// ─── Tier B — behavioral rules (each needs a model judge) ────────────────────
// Each rule maps 1:1 to a NARRATIVE DISCIPLINE rule in the EOD prompt. The judge
// (a cheap model) is shown the trade context + the output and asked to detect
// ONE violation, returning { violated, evidence }.

export interface BehavioralRule {
  id: string
  /** One-line human description (also shown in the eval report). */
  description: string
  /** The instruction handed to the judge model. It must ask for a single
   *  violation and a short evidence quote. */
  judgePrompt: string
}

const JUDGE_TAIL =
  'Respond with ONLY JSON: {"violated": boolean, "evidence": "<short quote from the output, or empty>"}. ' +
  'Default to violated=false unless the output clearly does this.'

export const BEHAVIORAL_RULES: BehavioralRule[] = [
  { id: 'B1', description: 'No outcome bias (no post-exit counterfactuals)',
    judgePrompt: `Does the analysis judge a trade by what price did AFTER the trader was already out? Flag ANY post-exit counterfactual — phrases like "would have hit target", "would have been a winner", "scratched a winner", "subsequently ran in favor", "ran X ATR after the exit/stop", "price reversed right after the stop". Using post-exit price to grade the decision is forbidden outcome bias, even if the sentence also makes another point. ${JUDGE_TAIL}` },
  { id: 'B2', description: 'Causation vs correlation (reads inform decisions, not market outcomes)',
    judgePrompt: `Does the analysis claim a trader's read/orderflow CAUSED a market outcome — e.g. "the missing OF caused the loss", "1/3 OF led to the stop"? Reads inform decisions; they don't drive the market. ${JUDGE_TAIL}` },
  { id: 'B3', description: 'No caveat-attached rail pass',
    judgePrompt: `Does the analysis mark a safety rail (P1–P5) as pass but then attach a caveat that tonally re-fails it — e.g. "P4 passes BUT the rush back bears monitoring"? Passes must be clean; behavioral notes belong in patterns/next_session_focus. ${JUDGE_TAIL}` },
  { id: 'B4', description: 'Risk-off scratch is valid execution, not a mistake',
    judgePrompt: `Does the analysis list a disciplined risk-off scratch (exiting because the tape went two-way / order flow left) as a mistake or execution failure? A read-based scratch is valid execution. ${JUDGE_TAIL}` },
  { id: 'B5', description: 'Structural terms used literally',
    judgePrompt: `Does the analysis use "active downtrend" (needs lower highs AND lower lows), "breakdown" (needs a confirmed lower low), or "acceptance" (needs bars CLOSING beyond a level) without the structural precondition being met in the data? ${JUDGE_TAIL}` },
  { id: 'B6', description: 'Time-of-day is never a scored breach',
    judgePrompt: `Does the analysis list the TIME a trade was taken as a mistake or a rule breach? There is no entry-time rule; timing tendencies may only appear in patterns/next_session_focus. ${JUDGE_TAIL}` },
  { id: 'B7', description: 'Emotion judged on state, not a literal tag word',
    judgePrompt: `Does the analysis penalize the trader's emotional state only because it wasn't the literal word "Stable" — i.e. treat a clearly composed state (calm, focused, disciplined, confident) as non-stable? Criterion 9 judges the STATE in the trader's own vocabulary. ${JUDGE_TAIL}` },
]

// ─── Prompt-drift guard (Tier A, against the built prompt) ────────────────────
// Assert each behavioral rule's instruction still exists in the prompt, so a
// rule can't be silently deleted from eod-prompt.ts without the eval failing.
// `variant` says which built prompt each anchor should appear in.

export interface PromptAnchor {
  id: string
  phrase: string
  variant: 'owner' | 'generic' | 'both'
}

export const PROMPT_ANCHORS: PromptAnchor[] = [
  { id: 'B1', phrase: 'outcome bias', variant: 'both' },
  { id: 'B2', phrase: 'Causation vs correlation', variant: 'owner' },
  { id: 'B3', phrase: 'caveat-attached pass', variant: 'owner' },
  { id: 'B4', phrase: 'RISK-OFF SCRATCHES ARE VALID', variant: 'owner' },
  { id: 'B5', phrase: 'Active downtrend', variant: 'owner' },
  { id: 'B6', phrase: 'Time-of-day is NOT a scored rule', variant: 'owner' },
  { id: 'B7', phrase: 'judge the STATE', variant: 'both' },
  // The model has no bar series and no order-flow feed — only the per-trade
  // fields. Added after a live analysis invented session structure ("a tape that
  // had stopped supporting the bullish bias") to explain three losing longs the
  // trader had tagged "Follow LTF structure". Distinct from B1: outcome bias is
  // judging a decision by what happened next; this is fabricating market state.
  { id: 'B8', phrase: 'You cannot see the tape', variant: 'both' },
]

/** Returns a violation for every expected anchor missing from `promptText`.
 *  Case-insensitive — the same constraint appears with different capitalization
 *  across the owner (v13) and generic ruleset blocks. */
export function checkPromptDrift(promptText: string, anchors: PromptAnchor[]): Violation[] {
  const hay = promptText.toLowerCase()
  return anchors
    .filter(anchor => !hay.includes(anchor.phrase.toLowerCase()))
    .map(anchor => ({ id: anchor.id, tier: 'A' as const, message: `prompt is missing the "${anchor.id}" constraint`, evidence: anchor.phrase }))
}
