import type { ExecutionScore } from '@/lib/supabase/types'

/**
 * The three TapeScore axes, part by part (founder-directed, 2026-10-14).
 * Pure — no server imports — so the client can read and explain a score.
 *
 *   Risk  — actual risk management, not just rule following
 *             Rules kept        45%  rails passed ÷ rails tracked (the day's rules audit,
 *                                    with the read-time corrections in tapescore-day-rules.ts)
 *             Loss size         27%  losing trades: the loss against your average dollar risk
 *             Stop size         18%  trades with a stop: no wider than your ATR stop setting
 *             Re-entries        10%  trades entered within 5 minutes of a losing exit that
 *                                    day: pass with a fresh trigger (an entry model other
 *                                    than "Based on Price"), fail without one
 *   Entry — the trade idea
 *             Checklist         45%  six of the end-of-day checklist items (below)
 *             Order-flow Score  35%  each trade's order-flow Score — only when you include it
 *             Plan adherence    20%  did the trades match the morning plan
 *   Exit  — how you got out
 *             Profit kept       42%  winners
 *             Stop respected    33%  trades whose stop came into play
 *             Runner rules      25%  trades that went for a second target
 *
 * A part with nothing to judge drops out and the axis's other parts share its
 * weight in proportion (no losers and no quick re-entries → rules 45 / stop size 18 → 71 / 29). The
 * per-trade parts (loss size, stop size, re-entries, order-flow Score and the
 * three Exit parts) are kept as SUMS + COUNTS, so a week or a month is the same arithmetic
 * over more trades — never an average of daily values.
 *
 * Loss size and stop size are scored per trade exactly as before they moved
 * here from Exit (src/lib/exit-score.ts); the average-dollar-risk rule is in
 * src/lib/exit-rollup.ts.
 */

export type Axis = 'risk' | 'entry' | 'exit'
export type RiskPart = 'rules' | 'lossSize' | 'stopSize' | 'reentry'
export type EntryPart = 'checklist' | 'flow' | 'plan'
export type ExitPart = 'kept' | 'stopRespected' | 'runner'
export type PartKey = RiskPart | EntryPart | ExitPart

export const AXIS_PARTS = {
  risk: ['rules', 'lossSize', 'stopSize', 'reentry'],
  entry: ['checklist', 'flow', 'plan'],
  exit: ['kept', 'stopRespected', 'runner'],
} as const satisfies Record<Axis, readonly PartKey[]>

/** Each part's share of its axis when every part has something to judge. */
export const PART_WEIGHTS: Record<PartKey, number> = {
  rules: 0.45, lossSize: 0.27, stopSize: 0.18, reentry: 0.10,
  checklist: 0.45, flow: 0.35, plan: 0.20,
  kept: 0.42, stopRespected: 0.33, runner: 0.25,
}

export const PART_LABELS: Record<PartKey, string> = {
  rules: 'Rules kept',
  lossSize: 'Loss size',
  stopSize: 'Stop size',
  reentry: 'Re-entries after a loss had a fresh trigger',
  checklist: 'Checklist',
  flow: 'Order-flow Score',
  plan: 'Plan adherence',
  kept: 'Profit kept on winners',
  stopRespected: 'Stop respected',
  runner: 'Runner rules',
}

export const AXIS_NAMES: Record<Axis, string> = { risk: 'Risk', entry: 'Entry', exit: 'Exit' }

/** What each axis is made of, in one phrase — for the places that describe the axes. */
export const AXIS_DESC: Record<Axis, string> = {
  risk: 'rules kept, loss size, stop size, re-entries after a loss',
  entry: 'checklist, order-flow Score (if you include it), plan adherence',
  exit: 'profit kept on winners, stop respected, runner rules',
}

// ── Entry · the checklist ─────────────────────────────────────────────────

type BreakdownKey = keyof NonNullable<ExecutionScore['execution_parameter_breakdown']>

/** The six end-of-day checklist items Entry uses. The analysis still grades all
 *  nine; "stop in the ATR band" is Risk's Stop size now, and the two emotion
 *  items are not part of the trade idea. */
export const ENTRY_CHECKLIST_KEYS = [
  'setup_in_playbook',
  'tp1_at_2r_or_reasoned',
  'clear_area_of_interest',
  'two_thirds_orderflow',
  'break_of_cluster_or_bubble_entry',
  'no_mistakes_tagged',
] as const satisfies readonly BreakdownKey[]

export const ENTRY_CHECKLIST_LABELS: Record<(typeof ENTRY_CHECKLIST_KEYS)[number], string> = {
  setup_in_playbook: 'setup in your playbook',
  tp1_at_2r_or_reasoned: 'first target at 2R or a reason',
  clear_area_of_interest: 'clear area of interest',
  two_thirds_orderflow: '2 of 3 order-flow reads',
  break_of_cluster_or_bubble_entry: 'break-of-cluster or bubble entry',
  no_mistakes_tagged: 'no mistakes tagged',
}

/** The checklist items as one phrase. */
export const ENTRY_CHECKLIST_DESC = ENTRY_CHECKLIST_KEYS.map(k => ENTRY_CHECKLIST_LABELS[k]).join(', ')

/**
 * A day's checklist value, 0..1: the mean of the six kept items' stored pass
 * rates, skipping items that did not apply that day (null). An analysis stored
 * before the per-item breakdown existed falls back to its stored overall
 * checklist value as is (`legacy`).
 */
export function entryChecklist(e: ExecutionScore | null | undefined): { value: number | null; legacy: boolean } {
  if (!e) return { value: null, legacy: false }
  const b = e.execution_parameter_breakdown
  if (b && typeof b === 'object') {
    let sum = 0, n = 0
    for (const k of ENTRY_CHECKLIST_KEYS) {
      const v = b[k]
      if (typeof v === 'number' && Number.isFinite(v)) { sum += v; n++ }
    }
    return { value: n > 0 ? sum / n : null, legacy: false }
  }
  return { value: e.execution_parameters ?? null, legacy: e.execution_parameters != null }
}

// ── Per-trade parts as sums + counts ───────────────────────────────────────

/** The parts scored trade by trade. Each trade scores 0..1 on the ones that apply to it. */
export type TradePartKey = 'lossSize' | 'stopSize' | 'reentry' | 'flow' | 'kept' | 'stopRespected' | 'runner'
export const TRADE_PARTS: readonly TradePartKey[] = ['lossSize', 'stopSize', 'reentry', 'flow', 'kept', 'stopRespected', 'runner']

export interface FactorSum { n: number; sum: number }
export type TradeSums = Record<TradePartKey, FactorSum>

export const emptyTradeSums = (): TradeSums => ({
  lossSize: { n: 0, sum: 0 }, stopSize: { n: 0, sum: 0 }, reentry: { n: 0, sum: 0 }, flow: { n: 0, sum: 0 },
  kept: { n: 0, sum: 0 }, stopRespected: { n: 0, sum: 0 }, runner: { n: 0, sum: 0 },
})

/** Plain addition — a period's sums are its days' sums added up. */
export function mergeTradeSums(list: (TradeSums | null | undefined)[]): TradeSums {
  const tot = emptyTradeSums()
  for (const s of list) {
    if (!s) continue
    for (const k of TRADE_PARTS) { tot[k].n += s[k]?.n || 0; tot[k].sum += s[k]?.sum || 0 }
  }
  return tot
}

/** 0..100, or null when no trade was judged. */
export function sumScore(s: FactorSum | null | undefined): number | null {
  return s && s.n > 0 ? (s.sum / s.n) * 100 : null
}

// ── Blending an axis ──────────────────────────────────────────────────────

export interface PartView {
  /** 0..100 unrounded; null = nothing to judge. */
  score: number | null
  /** For a per-trade part: trades judged. For a session part on a period:
   *  sessions counted. Null for a session part on a single day. */
  n: number | null
  /** The share of the axis this part carried, 0..1 (0 when absent). */
  weight: number
}

export type AxisPartViews<A extends Axis> = Record<(typeof AXIS_PARTS)[A][number], PartView>

/** Blend one axis's parts, sharing an absent part's weight out in proportion. */
export function blendAxis<A extends Axis>(
  axis: A,
  vals: Record<(typeof AXIS_PARTS)[A][number], { score: number | null; n: number | null }>,
): { score: number | null; parts: AxisPartViews<A> } {
  const keys = AXIS_PARTS[axis] as readonly (typeof AXIS_PARTS)[A][number][]
  let wsum = 0
  for (const k of keys) if (vals[k].score != null) wsum += PART_WEIGHTS[k]
  const parts = {} as AxisPartViews<A>
  let score = 0
  for (const k of keys) {
    const s = vals[k].score
    const w = s != null && wsum > 0 ? PART_WEIGHTS[k] / wsum : 0
    parts[k] = { score: s, n: vals[k].n, weight: w }
    if (s != null) score += s * w
  }
  return { score: wsum > 0 ? score : null, parts }
}

/** Everything behind a day's (or a period's) three axis numbers. */
export interface TapeScoreParts {
  risk: AxisPartViews<'risk'>
  entry: AxisPartViews<'entry'>
  exit: AxisPartViews<'exit'>
  /** Rails kept / rails tracked (summed over a period's sessions). */
  rulesKept: number | null
  rulesOf: number | null
  /** Whether the trader includes the order-flow Score in Entry. */
  flowOn: boolean
  /** The checklist came from an analysis stored before the per-item breakdown. */
  checklistLegacy: boolean
}

// ── Showing why ───────────────────────────────────────────────────────────

export interface PartLine {
  key: PartKey
  label: string
  /** 0..100 rounded; null = nothing to judge (or switched off). */
  score: number | null
  /** "81 · 12 trades" / "100 · 5 of 5 kept" / "not applicable" / "off". */
  detail: string
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const TRADE_KEYS = new Set<PartKey>(TRADE_PARTS)

/** One axis's parts, in order, ready to print. */
export function axisPartLines(parts: TapeScoreParts | null | undefined, axis: Axis): PartLine[] {
  const keys = AXIS_PARTS[axis] as readonly PartKey[]
  return keys.map(key => {
    const p = parts ? (parts[axis] as Record<PartKey, PartView>)[key] : undefined
    const score = p?.score != null ? Math.round(p.score) : null
    let detail: string
    if (key === 'flow' && parts && !parts.flowOn) detail = 'off'
    else if (key === 'flow' && score == null) detail = 'no scored trades'
    else if (score == null) detail = 'not applicable'
    else if (key === 'rules' && parts?.rulesKept != null && parts.rulesOf != null) detail = `${score} · ${parts.rulesKept} of ${parts.rulesOf} kept`
    else if (key === 'checklist' && parts?.checklistLegacy && p?.n == null) detail = `${score} · older analysis, all items`
    else if (p?.n != null) detail = `${score} · ${plural(p.n, TRADE_KEYS.has(key) ? 'trade' : 'session')}`
    else detail = String(score)
    return { key, label: PART_LABELS[key], score, detail }
  })
}

/** The same lines as hover text, one per line, under a heading. Entry also
 *  names the checklist items unless `checklistItems` is false. */
export function axisTooltip(
  heading: string,
  parts: TapeScoreParts | null | undefined,
  axis: Axis,
  opts: { checklistItems?: boolean } = {},
): string {
  const lines = axisPartLines(parts, axis).map(l => `${l.label}: ${l.detail}`)
  if (axis === 'entry' && opts.checklistItems !== false) lines.push(`(Checklist: ${ENTRY_CHECKLIST_DESC}.)`)
  return [heading, ...lines].join('\n')
}
