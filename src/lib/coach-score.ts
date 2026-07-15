/**
 * Coach Score — a per-trade execution grade (0–10) from the EOD 9-criterion
 * rubric, computed DETERMINISTICALLY from the trade's tags + geometry so it
 * shows live and free the moment a trade is tagged. Criteria that need judgment
 * (or a missing tag) come back `unknown`; the "Coach Score" AI button resolves
 * those, and applyAiResolutions() folds the answers back in.
 *
 * Rubric parity: mirrors src/lib/eod-prompt.ts §"Execution Parameters —
 * 9-criterion per-trade checklist" so a trade's live Coach Score lines up with
 * the EOD Execution score. `na` criteria are skipped in the denominator (same
 * as the EOD rubric); `unknown` is likewise excluded until the AI resolves it.
 *
 * Per-user thresholds: pass a `scoringProfile` (the trader's onboarding rules)
 * and the ATR stop target, TP1 R-multiple, and order-flow gate come from THEIR
 * profile instead of the owner's Ruleset v1.3. An empty/omitted profile falls
 * back to the v1.3 defaults, so the owner's local app is unchanged.
 */

import { resolveRubric, type ScoringProfile } from '@/lib/scoring-profile'

export interface GradableTrade {
  entry_price: number | null
  stop_price: number | null
  tp1_price: number | null
  direction: 'long' | 'short' | null
  quantity: number | null
  entry_atr_1m?: number | null
  exit_price?: number | null
  exits_json?: Array<{ price?: number | null }> | null
  // ── Optional market-read evidence (Pt 11 reweight) ──────────────────────
  // Used only by the coach-score route's market-read axis; safe to omit. The
  // EOD / intraday callers pass the full trade row, so these ride along.
  structure_5m_regime?: string | null
  high_during_position?: number | null
  low_during_position?: number | null
  post_exit_favorable_pts?: number | null
  post_exit_against_pts?: number | null
  pnl?: number | null
  symbol?: string | null
  tags_json?: {
    setups?: string[]
    confluences?: string[]
    order_flow?: string[]
    entry_model?: string[]
    trade_management?: string[]
    mistakes?: string[]
    emotions?: string[]
  } | null
}

export type CriterionStatus = 'pass' | 'fail' | 'na' | 'unknown'

export interface Criterion {
  key: string
  label: string
  status: CriterionStatus
  reason?: string
  /** 'auto' = deterministic; 'ai' = resolved by the Coach Score AI pass. */
  source: 'auto' | 'ai'
}

/**
 * Axis weights (Pt 11 reweight). The grade blends THREE dimensions so it scores
 * "how you traded vs what the market showed", not just rule-following:
 *   - execution   — the 9-criterion rule/compliance score (deterministic, free)
 *   - marketRead  — did the trade fit what price actually did (AI, evidence-light)
 *   - setupQuality— how clean an instance of the trader's OWN playbook it was (AI)
 * With a playbook: 60 / 20 / 20. Without one there's nothing to grade
 * setup-quality against, so it's 75 / 25 (execution / marketRead). Missing axes
 * renormalize — e.g. before the AI pass only `execution` is present, so the
 * score reads as the execution axis alone (a "partial" grade).
 */
export const COACH_AXIS_WEIGHTS = {
  playbook:   { execution: 0.60, marketRead: 0.20, setupQuality: 0.20 },
  noPlaybook: { execution: 0.75, marketRead: 0.25, setupQuality: 0 },
} as const

export interface CoachAxes {
  hasPlaybook: boolean
  /** 0–1 execution / rule-compliance (deterministic passes/total). */
  execution: number | null
  /** 0–1 market-read alignment (AI). Null until graded, or no evidence. */
  marketRead: number | null
  /** 0–1 setup-quality vs playbook (AI). Always null when !hasPlaybook. */
  setupQuality: number | null
  marketReadReason?: string
  setupQualityReason?: string
}

export interface CoachScore {
  /** 0–10 COMPOSED across the axes present (exec-only until the AI axes land). */
  score: number | null
  /** 0–10 execution axis alone — today's deterministic number, kept for display. */
  executionScore: number | null
  passes: number
  fails: number
  total: number          // passes + fails (na + unknown excluded)
  unknownCount: number   // criteria the AI could resolve
  criteria: Criterion[]
  axes: CoachAxes
  /** true while market-read (and, with a playbook, setup-quality) are ungraded. */
  partial: boolean
}

const arr = (v?: string[]): string[] => (Array.isArray(v) ? v : [])
const lc = (s: string) => s.toLowerCase()

/** Emotion tags that count as a clearly STABLE psychological state (criterion 9
 *  passes). Owner uses the literal "Stable"; public users tag their own words. */
const STABLE_EMOTIONS = new Set([
  'stable', 'calm', 'focused', 'confident', 'composed', 'patient',
  'disciplined', 'neutral', 'relaxed', 'clear', 'in control', 'centered',
])
/** Emotion tags that count as a clearly COMPROMISED state (criterion 9 fails).
 *  Owner uses "Compromised"/"MAXRAGE"; these cover the common tilt vocabulary. */
const COMPROMISED_EMOTIONS = new Set([
  'compromised', 'maxrage', 'rage', 'angry', 'anger', 'tilt', 'tilted',
  'fomo', 'fear', 'fearful', 'anxious', 'anxiety', 'greedy', 'greed',
  'frustrated', 'frustration', 'revenge', 'nervous', 'panic', 'panicked',
  'impatient', 'hesitant', 'stressed', 'euphoric', 'overconfident', 'desperate',
])

/** Weighted 0–10 blend of the axes, renormalized over whichever axes are
 *  present. Null when nothing is scorable. */
export function composeCoachScore(a: CoachAxes): number | null {
  const w = a.hasPlaybook ? COACH_AXIS_WEIGHTS.playbook : COACH_AXIS_WEIGHTS.noPlaybook
  const parts: Array<[number, number]> = []   // [weight, value 0–1]
  if (a.execution != null) parts.push([w.execution, a.execution])
  if (a.marketRead != null) parts.push([w.marketRead, a.marketRead])
  if (a.hasPlaybook && a.setupQuality != null) parts.push([w.setupQuality, a.setupQuality])
  const totW = parts.reduce((s, [pw]) => s + pw, 0)
  if (totW === 0) return null
  const v = parts.reduce((s, [pw, pv]) => s + pw * pv, 0) / totW
  return Math.round(v * 10)
}

export interface AxesMeta {
  hasPlaybook?: boolean
  marketRead?: number | null      // 0–1
  setupQuality?: number | null    // 0–1
  marketReadReason?: string
  setupQualityReason?: string
}

export function summarizeCoachScore(criteria: Criterion[], meta?: AxesMeta): CoachScore {
  const passes = criteria.filter(c => c.status === 'pass').length
  const fails = criteria.filter(c => c.status === 'fail').length
  const total = passes + fails
  const execution = total > 0 ? passes / total : null
  const hasPlaybook = meta?.hasPlaybook ?? true
  const axes: CoachAxes = {
    hasPlaybook,
    execution,
    marketRead: meta?.marketRead ?? null,
    setupQuality: hasPlaybook ? (meta?.setupQuality ?? null) : null,
    marketReadReason: meta?.marketReadReason,
    setupQualityReason: meta?.setupQualityReason,
  }
  const partial = axes.marketRead == null || (hasPlaybook && axes.setupQuality == null)
  return {
    score: composeCoachScore(axes),
    executionScore: execution != null ? Math.round(execution * 10) : null,
    passes, fails, total,
    unknownCount: criteria.filter(c => c.status === 'unknown').length,
    criteria, axes, partial,
  }
}

/**
 * Deterministic Coach Score. `setupLibrary` (lowercased curated setup labels)
 * lets criterion 1 verify the setup is a real playbook entry; omit it to just
 * require a setup tag.
 */
export function computeCoachScore(
  t: GradableTrade,
  opts?: { setupLibrary?: Set<string>; instrumentHasBars?: boolean; scoringProfile?: ScoringProfile | null; hasPlaybook?: boolean },
): CoachScore {
  // "Has a playbook" drives the axis weighting (60/20/20 vs 75/25). Explicit
  // opt wins; else infer from the setup library (empty → no playbook). When no
  // library is passed at all (owner local path) assume a playbook exists.
  const hasPlaybook = opts?.hasPlaybook ?? (opts?.setupLibrary ? opts.setupLibrary.size > 0 : true)
  const tj = t.tags_json ?? {}
  const setups = arr(tj.setups)
  const confluences = arr(tj.confluences)
  const orderFlow = arr(tj.order_flow)
  const entryModel = arr(tj.entry_model)
  const mistakes = arr(tj.mistakes)
  const emotions = arr(tj.emotions)
  const rubric = resolveRubric(opts?.scoringProfile)
  const c: Criterion[] = []

  // 1. setup_in_playbook — a curated setup tag is present.
  if (setups.length === 0) {
    c.push({ key: 'setup_in_playbook', label: 'Setup in playbook', status: 'na', source: 'auto', reason: 'No setup tagged' })
  } else {
    const inLib = !opts?.setupLibrary || setups.some(s => opts.setupLibrary!.has(lc(s)))
    c.push({ key: 'setup_in_playbook', label: 'Setup in playbook', status: inLib ? 'pass' : 'fail', source: 'auto', reason: inLib ? undefined : 'Setup not in library' })
  }

  // 2. stop_in_atr_band — |entry−stop| ÷ entry ATR-10 within [0.5, 1.5]× the
  //    trader's ATR stop target (default 1 → [0.5, 1.5]; e.g. a 2-ATR trader →
  //    [1.0, 3.0]). 1.25 upper (× target) for size-ups. N/A without an ATR.
  {
    const e = t.entry_price, s = t.stop_price, atr = t.entry_atr_1m
    const tgt = rubric.atrStopTarget
    const lo = 0.5 * tgt
    // Label reflects the band; keep the familiar "0.5–1.5× ATR" for the default.
    const bandLabel = tgt === 1 ? 'Stop 0.5–1.5× ATR' : `Stop ${lo}–${(1.5 * tgt)}× ATR`
    if (opts?.instrumentHasBars === false) {
      // No bar data for this instrument → any stored entry_atr_1m is from a
      // DIFFERENT instrument (e.g. an ES trade carrying a stale NQ ATR). Don't
      // judge the stop against a wrong-scale ATR — mark N/A until bars exist.
      c.push({ key: 'stop_in_atr_band', label: bandLabel, status: 'na', source: 'auto', reason: 'No bars for this instrument' })
    } else if (e == null || s == null || atr == null || atr <= 0) {
      c.push({ key: 'stop_in_atr_band', label: bandLabel, status: 'na', source: 'auto', reason: atr == null ? 'No entry ATR' : 'Missing stop/entry' })
    } else {
      const mult = Math.abs(e - s) / atr
      const upper = ((t.quantity ?? 0) > rubric.sizeUpLots ? 1.25 : 1.5) * tgt
      const ok = mult >= lo && mult <= upper
      c.push({ key: 'stop_in_atr_band', label: bandLabel, status: ok ? 'pass' : 'fail', source: 'auto', reason: `${mult.toFixed(2)}× ATR` })
    }
  }

  // 3. tp1_at_2r_or_reasoned — planned TP1 ÷ planned stop ≥ the trader's TP
  //    R-multiple (default 2). Below it needs a logged reason (judgment) →
  //    unknown for the AI to check the notes.
  {
    const e = t.entry_price, s = t.stop_price, tp = t.tp1_price
    const rMult = rubric.tp1RMultiple
    const label = `TP1 ≥ ${rMult}R`
    if (e == null || s == null || tp == null || Math.abs(e - s) === 0) {
      c.push({ key: 'tp1_at_2r', label, status: 'na', source: 'auto', reason: 'Missing TP1/stop' })
    } else {
      const r = Math.abs(tp - e) / Math.abs(e - s)
      c.push(r >= rMult
        ? { key: 'tp1_at_2r', label, status: 'pass', source: 'auto', reason: `${r.toFixed(1)}R` }
        : { key: 'tp1_at_2r', label, status: 'unknown', source: 'auto', reason: `${r.toFixed(1)}R — needs a logged reason` })
    }
  }

  // 4. clear_area_of_interest — a confluence tag anchors the entry to a level.
  //    None tagged → unknown (AI reads notes/chart for a mid-range vs level entry).
  c.push(confluences.length > 0
    ? { key: 'clear_aoi', label: 'Clear area of interest', status: 'pass', source: 'auto' }
    : { key: 'clear_aoi', label: 'Clear area of interest', status: 'unknown', source: 'auto', reason: 'No confluence tagged' })

  // 5. two_thirds_orderflow — an order-flow rule, so it only applies to traders
  //    whose profile uses order flow (feedback_no_forced_orderflow): if they
  //    don't trade OF it's ALWAYS N/A (never a fail). For OF traders it gates the
  //    size-up (> sizeUpLots): ≥2/3 OF reads; base size is N/A (never a fail —
  //    see feedback_2of3_orderflow_is_sizing_gate).
  {
    const qty = t.quantity ?? 0
    if (!rubric.usesOrderFlow) {
      c.push({ key: 'two_thirds_of', label: '2/3 order flow (size-up)', status: 'na', source: 'auto', reason: "Doesn't trade order flow — N/A" })
    } else if (qty > rubric.sizeUpLots) {
      c.push({ key: 'two_thirds_of', label: '2/3 order flow (size-up)', status: orderFlow.length >= 2 ? 'pass' : 'fail', source: 'auto', reason: `${orderFlow.length}/3 OF` })
    } else {
      const reason = Number.isFinite(rubric.sizeUpLots) ? `≤${rubric.sizeUpLots} lots — N/A` : 'base size — N/A'
      c.push({ key: 'two_thirds_of', label: '2/3 order flow (size-up)', status: 'na', source: 'auto', reason })
    }
  }

  // 6. valid_entry_trigger — the entry used a DEFINED trigger from the trader's
  //    entry_model library (ANY of them — 1 ATR Entry, Break of Candle, POC
  //    break, Heiken-Ashi flip, break-of-cluster, etc.), not only one. An entry
  //    with no model tagged is a discretionary poke → unknown for the AI.
  c.push(entryModel.length > 0
    ? { key: 'valid_entry_trigger', label: 'Valid entry trigger', status: 'pass', source: 'auto', reason: entryModel.join(', ') }
    : { key: 'valid_entry_trigger', label: 'Valid entry trigger', status: 'unknown', source: 'auto', reason: 'No entry model tagged' })

  // 7. rule_based_exit (was chart_not_emotion) — a rule-based exit is disciplined
  //    by definition: hitting the planned TP, or getting stopped, both PASS
  //    automatically (getting stopped is correct execution — an invalidated
  //    idea). Only a discretionary exit BETWEEN target and stop needs a read.
  {
    const e = t.entry_price, tp = t.tp1_price, stop = t.stop_price, dir = t.direction
    const exits = [
      ...(t.exits_json ?? []).map(x => x?.price),
      t.exit_price,
    ].filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
    if (e == null || dir == null || exits.length === 0) {
      c.push({ key: 'rule_based_exit', label: 'Rule-based exit', status: 'unknown', source: 'auto', reason: 'Needs read of exit reasoning' })
    } else {
      const hitTp = tp != null && exits.some(p => (dir === 'long' ? p >= tp : p <= tp))
      const stopped = stop != null && exits.some(p => (dir === 'long' ? p <= stop : p >= stop))
      if (hitTp) c.push({ key: 'rule_based_exit', label: 'Rule-based exit', status: 'pass', source: 'auto', reason: 'Hit TP' })
      else if (stopped) c.push({ key: 'rule_based_exit', label: 'Rule-based exit', status: 'pass', source: 'auto', reason: 'Stopped out' })
      else c.push({ key: 'rule_based_exit', label: 'Rule-based exit', status: 'unknown', source: 'auto', reason: 'Discretionary exit — needs read' })
    }
  }

  // 8. no_mistakes_tagged.
  c.push({ key: 'no_mistakes', label: 'No mistakes tagged', status: mistakes.length === 0 ? 'pass' : 'fail', source: 'auto', reason: mistakes.length ? mistakes.join(', ') : undefined })

  // 9. stable_emotion — a clearly-stable emotion PASSES, a clearly-compromised
  //    one FAILS, and anything else (an ambiguous tag, or none) is `unknown` so
  //    the AI pass can judge it from the notes. Previously only the literal
  //    "Stable" tag passed, making "Calm"/"Focused"/"Confident" a deterministic
  //    FAIL the AI could never overturn (it only resolves `unknown`).
  if (emotions.length === 0) {
    c.push({ key: 'stable_emotion', label: 'Stable emotion', status: 'unknown', source: 'auto', reason: 'No emotion tagged' })
  } else {
    const norm = emotions.map(lc)
    const compromised = norm.some(e => COMPROMISED_EMOTIONS.has(e))
    const stable = norm.some(e => STABLE_EMOTIONS.has(e))
    if (compromised) {
      // Any compromised read is a red flag even if a stable tag rides alongside.
      c.push({ key: 'stable_emotion', label: 'Stable emotion', status: 'fail', source: 'auto', reason: emotions.join(', ') })
    } else if (stable) {
      c.push({ key: 'stable_emotion', label: 'Stable emotion', status: 'pass', source: 'auto' })
    } else {
      c.push({ key: 'stable_emotion', label: 'Stable emotion', status: 'unknown', source: 'auto', reason: `Ambiguous emotion (${emotions.join(', ')}) — needs read of notes` })
    }
  }

  return summarizeCoachScore(c, { hasPlaybook })
}

/** Fold the Coach Score AI pass back into a base score: (1) resolved `unknown`
 *  criteria (marked source:'ai'), and (2) the market-read + setup-quality axis
 *  grades. `axes` scores are 0–1; omit a field to keep the base's value. */
export function applyAiResolutions(
  base: CoachScore,
  resolutions: Record<string, { status: 'pass' | 'fail' | 'na'; reason?: string }>,
  axes?: { marketRead?: number | null; marketReadReason?: string; setupQuality?: number | null; setupQualityReason?: string },
): CoachScore {
  const merged = base.criteria.map(cr => {
    if (cr.status !== 'unknown') return cr
    const r = resolutions[cr.key]
    if (!r) return cr
    return { ...cr, status: r.status, reason: r.reason ?? cr.reason, source: 'ai' as const }
  })
  return summarizeCoachScore(merged, {
    hasPlaybook: base.axes.hasPlaybook,
    marketRead: axes && 'marketRead' in axes ? axes.marketRead : base.axes.marketRead,
    marketReadReason: axes?.marketReadReason ?? base.axes.marketReadReason,
    setupQuality: axes && 'setupQuality' in axes ? axes.setupQuality : base.axes.setupQuality,
    setupQualityReason: axes?.setupQualityReason ?? base.axes.setupQualityReason,
  })
}
