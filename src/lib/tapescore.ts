import type { EodAiAnalysis, ExecutionScore, ProcessVerdict, RuleStatus } from '@/lib/supabase/types'
import {
  blendAxis, emptyTradeSums, entryChecklist, mergeTradeSums, sumScore,
  type PartView, type TapeScoreParts, type TradePartKey, type TradeSums,
} from '@/lib/tapescore-axes'
import { dailyLossLimitBroken } from '@/lib/tapescore-day-rules'

/**
 * One TapeScore (Ruleset amendment 6, 2026-07-23).
 *
 * A single 0-100 headline per session, DERIVED from the existing scoring
 * layers — never produced by the AI, never stored. Deriving at read time means
 * every historical row gets a TapeScore for free and re-weights can't strand
 * stale stored values.
 *
 *   TapeScore = round((Risk + Entry + Exit) / 3)   — the three axes weighted equally
 *
 * Each axis is a blend of parts (src/lib/tapescore-axes.ts holds the weights):
 *
 *   Risk  = rules kept 45 (rails passed ÷ rails tracked, from the analysis)
 *         + loss size 27 + stop size 18 + re-entries after a loss 10
 *         (per trade, from the day's trades)
 *   Entry = checklist 45 (six of the analysis's checklist items)
 *         + order-flow Score 35 (per trade — only when the trader includes it)
 *         + plan adherence 20 (from the analysis)
 *   Exit  = profit kept on winners 42 + stop respected 33 + runner rules 25
 *         (per trade, from the day's trades)
 *
 * A part with nothing to judge drops out and the axis's other parts share its
 * weight in proportion. An axis that is missing altogether (no rails audit → no
 * Risk; no analysis execution read → no Entry; no trade to judge → no Exit)
 * drops out and the other axes re-weight. Breach sessions — decided by the
 * RULES alone — are capped at 49 so they can never render green or amber.
 *
 * AMENDMENT 9 (2026-10-14, founder-directed) — the axes measure what their
 * names say. Risk is actual risk management, not just rule following: loss size
 * and stop size moved into it from Exit (same definitions, thresholds and
 * average-dollar-risk rule). Exit keeps how you got out (three factors). Entry
 * is the trade idea: the checklist now reads six of the nine items the analysis
 * grades (stop-in-ATR-band is Risk's stop size; the two emotion items left),
 * profit factor is gone, and the per-trade order-flow Score can join it (a
 * per-user setting, on unless switched off). The checklist selection happens at
 * read time from the stored per-item pass rates, so history re-scores with no
 * re-analysis. The stored rules audit and checklist are also corrected from the
 * day's trades at read time (src/lib/tapescore-day-rules.ts): a broken daily
 * loss limit is a Breach on its own, "no size-up after a loss" is recomputed
 * with the recap's pressing-into-drawdown definition, and "no mistakes tagged"
 * is read off the trades' tags. Risk also gained a light fourth part:
 * re-entries within 5 minutes of a losing exit must carry a fresh trigger.
 * A day's score is built in two steps: `tapeScoreBase` (the parts
 * that come from the analysis — cacheable) and `finishTapeScore` (blend in the
 * per-trade parts, which need the trader's average risk from EARLIER days).
 *
 * A PERIOD pools: its per-trade parts are summed over the period's trades
 * (never a mean of daily values), its session parts (rules, checklist, plan)
 * are the mean over its sessions, and its headline stays the mean of day
 * TapeScores.
 *
 * Earlier amendments: 6 split the score into the Risk / Entry / Exit axes
 * (dropping plan quality); 7 weighted the three axes equally; 8 made Exit the
 * deterministic per-trade score instead of the AI's `mfe_capture`, which stays
 * in the stored analysis but no longer feeds TapeScore.
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
    /** Risk, 0-100: rules kept 45 / loss size 27 / stop size 18 / re-entries 10. Null without a
     *  rules audit. One of three equal axes (⅓). */
    risk: number | null
    /** Entry, 0-100: checklist 45 / order-flow Score 35 / plan adherence 20.
     *  Null without an analysis execution read. One of three equal axes (⅓). */
    entry: number | null
    /** Exit, 0-100: profit kept 42 / stop respected 33 / runner rules 25.
     *  Null when no part had a trade to judge. One of three equal axes (⅓). */
    exit: number | null
    /** Safety rails passed, 0..railCount. Null on legacy-basis rows. */
    passCount: number | null
    /** How many rails this trader actually tracks (active_rails when the
     *  analysis recorded it, else the historical 5). Display denominators
     *  must use THIS, not a literal 5 — a trader who removed a rail is not
     *  "4/5". Null when passCount is null. */
    railCount: number | null
    /** Re-derived from passCount ≥ 4 — not the stored verdict, so
     *  pre-amendment rows judged under other thresholds stay comparable. */
    verdict: 'Compliant' | 'Breach' | null
  }
  /** Every part behind the three axis numbers — what the explanations print.
   *  Null on legacy-basis rows. */
  parts: TapeScoreParts | null
}

// Amendment 7: the three axes carry equal weight (⅓ each). Kept as separate
// named constants so the blend below reads the same and a future re-weight is a
// one-line change per axis.
const W_RISK = 1 / 3
const W_ENTRY = 1 / 3
const W_EXIT = 1 / 3
const BREACH_CAP = 49

export function tapeScoreBand(score: number): TapeScoreBand {
  return score >= 70 ? 'high' : score >= 50 ? 'mid' : 'low'
}

/** Safety-rail pass count with the legacy P1-P7 remap: pre-amendment-3 rows
 *  (detected by a P6/P7 key) keep P1-P3, map old P5 (cooldown) → P4 and old
 *  P6 (trade cap) → P5, and drop old P4/P7 (stop/setup validity — those
 *  moved into Execution Parameters). Rows already on the 5-rail shape count
 *  P1-P5 directly. */
export function railPassCount(process: ProcessVerdict, activeRails?: readonly string[]): number {
  const perRule = process.per_rule as Record<string, RuleStatus | undefined>
  const isLegacyShape = 'P6' in perRule || 'P7' in perRule
  // `activeRails` (present once the analysis records it) narrows the count to
  // the rails this trader actually tracks. Untracked rails AUTO-PASS, so
  // counting all five credits them for rules they never set.
  const railIds = activeRails
    ?? (isLegacyShape
      ? ['P1', 'P2', 'P3', 'P5', 'P6']
      : ['P1', 'P2', 'P3', 'P4', 'P5'])
  let pass = 0
  for (const id of railIds) {
    if (perRule[id]?.status === 'pass') pass += 1
  }
  return pass
}

/** How a day's per-trade parts are read. */
export interface TapeScoreOptions {
  /** The trader's setting: include the order-flow Score in Entry. On unless
   *  switched off (see includeFlowScoreInEntry in scoring-profile.ts). */
  includeFlow?: boolean
}

export interface TapeScoreInput extends TapeScoreOptions {
  process?: ProcessVerdict | null
  execution?: ExecutionScore | null
  /** Pre-v1.3 rows: the single 0-10 `score` field. */
  legacyScore?: number | null
  /** @deprecated Amendment 6 dropped plan quality from the score. Still
   *  accepted so existing call sites compile; ignored. */
  prepScore?: number | null
  /** The day's per-trade sums (src/lib/exit-rollup.ts) — Risk's loss size and
   *  stop size, Entry's order-flow Score, the three Exit parts. Null/absent =
   *  no trade to judge. */
  trades?: TradeSums | null
}

/**
 * The part of a day's TapeScore that comes from its EOD analysis alone — the
 * rules audit, the checklist and plan adherence — before the per-trade parts
 * are blended in. JSON-safe: this is what the per-day rollup caches, because
 * loss size depends on earlier days and the order-flow setting can change, so
 * the finished score is only known at read time.
 */
export interface TapeScoreBase {
  basis: 'v15' | 'legacy'
  /** Rules kept, 0-100 (rails passed ÷ rails tracked). Null = no rules audit,
   *  which leaves the day without a Risk axis. */
  rules: number | null
  passCount: number | null
  railCount: number | null
  verdict: 'Compliant' | 'Breach' | null
  /** The analysis ran an execution read — the day has an Entry axis. */
  hasEntry: boolean
  /** Entry's checklist, 0-100 (six items), or null. */
  checklist: number | null
  /** The checklist fell back to the stored overall value (no per-item breakdown). */
  checklistLegacy: boolean
  /** Entry's plan adherence, 0-100, or null. */
  plan: number | null
  /** Entry when none of its parts can be read: the stored composite of a row
   *  that kept nothing else (0-100), else null → 0. */
  entryFallback: number | null
  /** Legacy-basis rows only: the finished 0-100 score. */
  legacy: number | null
}

/**
 * Step 1 — everything a day's TapeScore takes from its EOD analysis. Null when
 * the day has no analysis at all (it then has no TapeScore, whatever its trades
 * say).
 */
export function tapeScoreBase(input: TapeScoreInput): TapeScoreBase | null {
  const { process, execution, legacyScore } = input

  // The rules part is scored over the rails the trader TRACKS. `active_rails`
  // is absent on rows analyzed before it existed and on the founder's build —
  // both grade all five, so they keep the historical /5 denominator exactly. An
  // empty array means they track nothing, which makes the rules part — and with
  // it the Risk axis — unscoreable rather than a free 5/5: the axis drops out
  // and the remaining two re-weight.
  const tracked = process?.active_rails?.length ?? null
  const railDenom = tracked ?? 5
  const passCount = process?.per_rule && railDenom > 0
    ? railPassCount(process, process.active_rails)
    : null
  const rules = passCount != null ? (passCount / railDenom) * 100 : null

  // Rails alone never make a TapeScore without an execution read either — the
  // day reads as unanalyzed until an EOD analysis (or a legacy score) exists.
  if (rules == null && execution == null) {
    if (legacyScore == null) return null
    return {
      basis: 'legacy', rules: null, passCount: null, railCount: null, verdict: null,
      hasEntry: false, checklist: null, checklistLegacy: false, plan: null, entryFallback: null,
      legacy: Math.round(clamp(legacyScore, 0, 10) * 10),
    }
  }

  // With a known rail set, trust the verdict the analysis already derived
  // proportionally (see applyDeterministicOverrides) — re-deriving it as
  // "passCount >= 4" would call every trader who tracks three rails a Breach
  // and cap them at 49. Legacy rows keep the historical arithmetic.
  // A broken daily loss limit (when tracked) is a Breach on its own, however
  // many other rules held (amendment 9). The other read-time corrections to the
  // audit (the size-up rule from the trades) arrive already applied — see
  // effectiveAnalysis in src/lib/tapescore-day-rules.ts.
  const verdict: 'Compliant' | 'Breach' | null =
    passCount == null ? null
      : dailyLossLimitBroken(process) ? 'Breach'
        : tracked != null ? (process?.verdict ?? null)
          : passCount >= 4 ? 'Compliant' : 'Breach'

  // Entry's session parts. `mfe_capture` and `profit_factor` are deliberately
  // not read (amendments 8 and 9).
  const cl = entryChecklist(execution)
  return {
    basis: 'v15', rules, passCount,
    railCount: passCount != null ? railDenom : null,
    verdict,
    hasEntry: execution != null,
    checklist: cl.value != null ? clamp01(cl.value) * 100 : null,
    checklistLegacy: cl.legacy,
    plan: execution?.prep_adherence != null ? clamp01(execution.prep_adherence) * 100 : null,
    entryFallback: execution?.composite != null ? clamp01(execution.composite) * 100 : null,
    legacy: null,
  }
}

type SessionPart = { score: number | null; n: number | null }

/** The three axes (unrounded) and their parts for a day or a period. */
function readAxes(
  session: { rules: SessionPart; checklist: SessionPart; plan: SessionPart },
  sums: TradeSums,
  includeFlow: boolean,
) {
  const tp = (k: TradePartKey) => ({ score: sumScore(sums[k]), n: sums[k].n })
  const risk = blendAxis('risk', { rules: session.rules, lossSize: tp('lossSize'), stopSize: tp('stopSize'), reentry: tp('reentry') })
  const entry = blendAxis('entry', {
    checklist: session.checklist,
    flow: includeFlow ? tp('flow') : { score: null, n: sums.flow.n },
    plan: session.plan,
  })
  const exit = blendAxis('exit', { kept: tp('kept'), stopRespected: tp('stopRespected'), runner: tp('runner') })
  return { risk, entry, exit }
}

/**
 * Step 2 — blend the day's per-trade parts (null = no trade to judge) into its
 * base. A legacy-basis day is returned as it always was: it has no axes, so
 * there is nothing for the trades to join.
 */
export function finishTapeScore(
  base: TapeScoreBase | null | undefined,
  sums: TradeSums | null | undefined,
  opts: TapeScoreOptions = {},
): TapeScoreResult | null {
  if (!base) return null
  if (base.basis === 'legacy') {
    const score = base.legacy ?? 0
    return {
      score,
      band: tapeScoreBand(score),
      basis: 'legacy',
      capped: false,
      components: { risk: null, entry: null, exit: null, passCount: null, railCount: null, verdict: null },
      parts: null,
    }
  }

  const includeFlow = opts.includeFlow ?? true
  const axes = readAxes(
    { rules: { score: base.rules, n: null }, checklist: { score: base.checklist, n: null }, plan: { score: base.plan, n: null } },
    sums ?? emptyTradeSums(),
    includeFlow,
  )
  // Risk needs the rules audit; without it the axis is absent (as before).
  const risk = base.rules != null ? axes.risk.score : null
  // An execution read whose parts are all unreadable is a real 0, not missing
  // data (matches the dashboard's overall_grade convention), unless the row
  // kept only its composite.
  const entry = base.hasEntry ? (axes.entry.score ?? base.entryFallback ?? 0) : null
  const exit = axes.exit.score

  return {
    ...blendDay(base, risk, entry, exit),
    parts: {
      risk: axes.risk.parts, entry: axes.entry.parts, exit: axes.exit.parts,
      rulesKept: base.passCount, rulesOf: base.railCount,
      flowOn: includeFlow, checklistLegacy: base.checklistLegacy && base.checklist != null,
    },
  }
}

function blendDay(
  base: TapeScoreBase, risk: number | null, entry: number | null, exitIn: number | null,
): Omit<TapeScoreResult, 'parts'> {
  const exit = exitIn != null && Number.isFinite(exitIn) ? clamp(exitIn, 0, 100) : null
  let weighted = 0
  let weightSum = 0
  if (risk != null) { weighted += W_RISK * risk; weightSum += W_RISK }
  if (entry != null) { weighted += W_ENTRY * entry; weightSum += W_ENTRY }
  if (exit != null) { weighted += W_EXIT * exit; weightSum += W_EXIT }
  let score = Math.round(weighted / weightSum)

  // The cap is the RULES' verdict alone — loss size and stop size never cap.
  let capped = false
  if (base.verdict === 'Breach' && score > BREACH_CAP) {
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
      exit: exit != null ? Math.round(exit) : null,
      passCount: base.passCount,
      railCount: base.railCount,
      verdict: base.verdict,
    },
  }
}

/** Both steps at once, for a caller that already has the day's trade sums. */
export function computeTapeScore(input: TapeScoreInput): TapeScoreResult | null {
  return finishTapeScore(tapeScoreBase(input), input.trades ?? null, input)
}

/** The base (analysis parts) from the stored analysis blobs. */
export function tapeScoreBaseFromAnalyses(
  eod: EodAiAnalysis | null | undefined,
  prepScore: number | null | undefined,
): TapeScoreBase | null {
  return tapeScoreBase({
    process: eod?.process ?? null,
    execution: eod?.execution ?? null,
    legacyScore: eod?.score ?? null,
    prepScore: prepScore ?? null,
  })
}

/** Convenience wrapper over the stored analysis blobs. `trades` is the day's
 *  per-trade sums (or null) — required, so no caller can forget them. */
export function tapeScoreFromAnalyses(
  eod: EodAiAnalysis | null | undefined,
  prepScore: number | null | undefined,
  trades: TradeSums | null,
  opts: TapeScoreOptions = {},
): TapeScoreResult | null {
  return finishTapeScore(tapeScoreBaseFromAnalyses(eod, prepScore), trades, opts)
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
  /** The period's axes, 0-100. Per-trade parts are POOLED over the trades of
   *  the scored days that carry the axis (sums merged, read once) — never a
   *  mean of daily values; session parts (rules, checklist, plan) are the mean
   *  over those days. Null when the axis is absent on every day. */
  risk: number | null
  entry: number | null
  exit: number | null
  /** Every part behind the three numbers, for the explanations. */
  parts: TapeScoreParts | null
}

/** One day as the period aggregate reads it. */
export interface TapeScoreDay {
  tapescore: TapeScoreResult | null
  /** The day's per-trade sums + counts (src/lib/exit-rollup.ts), for pooling. */
  trade_sums?: TradeSums | null
}

export function aggregateTapeScore(days: (TapeScoreDay | null | undefined)[]): TapeScorePeriod {
  const scoredDays = days.filter((d): d is TapeScoreDay & { tapescore: TapeScoreResult } => d?.tapescore != null)
  const scored = scoredDays.map(d => d.tapescore)
  const withVerdict = scored.filter(d => d.components.verdict != null)
  const score = mean(scored.map(d => d.score))

  // Each axis covers the days that carry it: Risk the days with a rules audit,
  // Entry the days with an execution read, Exit every day with axes at all (a
  // legacy-basis day has none). A part's trades are pooled over those days.
  const axisDays = scoredDays.filter(d => d.tapescore.basis === 'v15' && d.tapescore.parts != null)
  const riskDays = axisDays.filter(d => d.tapescore.components.risk != null)
  const entryDays = axisDays.filter(d => d.tapescore.components.entry != null)
  const riskSums = mergeTradeSums(riskDays.map(d => d.trade_sums))
  const entrySums = mergeTradeSums(entryDays.map(d => d.trade_sums))
  const exitSums = mergeTradeSums(axisDays.map(d => d.trade_sums))
  const pooled: TradeSums = {
    lossSize: riskSums.lossSize, stopSize: riskSums.stopSize, reentry: riskSums.reentry,
    flow: entrySums.flow,
    kept: exitSums.kept, stopRespected: exitSums.stopRespected, runner: exitSums.runner,
  }

  const sessionPart = (list: typeof axisDays, pick: (p: TapeScoreParts) => PartView): SessionPart => {
    const vals = list.map(d => pick(d.tapescore.parts as TapeScoreParts).score).filter((v): v is number => v != null)
    return { score: mean(vals), n: vals.length }
  }
  // The trader's setting is the same on every day of one read.
  const includeFlow = axisDays.some(d => d.tapescore.parts?.flowOn)
  const axes = readAxes(
    {
      rules: sessionPart(riskDays, p => p.risk.rules),
      checklist: sessionPart(entryDays, p => p.entry.checklist),
      plan: sessionPart(entryDays, p => p.entry.plan),
    },
    pooled,
    includeFlow,
  )
  const total = (vals: (number | null)[]) => vals.reduce<number>((a, v) => a + (v ?? 0), 0)
  const risk = riskDays.length > 0 ? axes.risk.score : null
  // A window whose execution reads kept no part at all (old rows) keeps the
  // mean of those days' Entry, as before.
  const entry = entryDays.length > 0
    ? (axes.entry.score ?? mean(entryDays.map(d => d.tapescore.components.entry)))
    : null
  const exit = axisDays.length > 0 ? axes.exit.score : null

  return {
    score: score != null ? Math.round(score) : null,
    band: score != null ? tapeScoreBand(Math.round(score)) : null,
    scoredDays: scored.length,
    verdictDays: withVerdict.length,
    compliantDays: withVerdict.filter(d => d.components.verdict === 'Compliant').length,
    risk: risk != null ? Math.round(risk) : null,
    entry: entry != null ? Math.round(entry) : null,
    exit: exit != null ? Math.round(exit) : null,
    parts: axisDays.length > 0
      ? {
          risk: axes.risk.parts, entry: axes.entry.parts, exit: axes.exit.parts,
          rulesKept: riskDays.length > 0 ? total(riskDays.map(d => d.tapescore.components.passCount)) : null,
          rulesOf: riskDays.length > 0 ? total(riskDays.map(d => d.tapescore.components.railCount)) : null,
          flowOn: includeFlow,
          checklistLegacy: false,
        }
      : null,
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
