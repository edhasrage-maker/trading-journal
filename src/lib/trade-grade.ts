/**
 * One trade's Score — the trade's grade (founder-approved mockup,
 * docs/trade-grade-mockup.html, 2026-10-15). It replaces the separate Rules
 * and Runner columns: everything that grades a single trade, in one number.
 *
 *   Score = Entry and Exit averaged (either alone when the other has nothing to judge)
 *   Entry = the trader's entry rules · the order-flow Score (if they include it),
 *           weighted as in the day's Entry (30 : 24.5 → 55% / 45%)
 *   Exit  = profit kept · stop respected · runner rules (theirs where one counts,
 *           else the generic part), weighted as in the day's Exit (42 / 33 / 25),
 *           from the parts that apply to the trade
 *
 * Risk, the analysis checklist and plan adherence are day-level and stay out.
 * Pure and client-safe: the same arithmetic as the day's sums
 * (src/lib/exit-rollup.ts → dayTradeInputs), one trade at a time.
 */
import { PART_WEIGHTS } from '@/lib/tapescore-axes'
import { exitTradeScores, type ExitTradeInput } from '@/lib/exit-score'
import { exitKind } from '@/lib/trade-management'
import { evaluateRules, tradeRulesScore, type EntryRuleConfig, type RuleResult } from '@/lib/entry-rules'
import { evaluateRunnerRules, tradeRunnerPart, type RunnerResult, type RunnerRuleConfig } from '@/lib/runner-rules'
import { tradeFlowTotal } from '@/lib/exit-rollup'
import type { TradeEntryCtx, TradeFlowScore } from '@/lib/supabase/types'

export type GradeTrade = ExitTradeInput & {
  id?: string | null
  entry_time?: string | null
  review_json?: { score?: TradeFlowScore | null; entry_ctx?: TradeEntryCtx | null } | null
}

export interface TradeGradeOptions {
  entryRules?: readonly EntryRuleConfig[] | null
  runnerRules?: readonly RunnerRuleConfig[] | null
  /** The trader includes the order-flow Score in Entry (default on). */
  includeFlow?: boolean
  /** The trader's ATR stop setting (only Stop size reads it; kept for parity with the day). */
  atrStopTarget?: number
  /** A fresher order-flow Score / entry snapshot than the row carries (just read on this page). */
  flow?: TradeFlowScore | null
  entryCtx?: TradeEntryCtx | null
}

export interface TradeGrade {
  /** 0..100 rounded; null when nothing about the trade could be judged. */
  score: number | null
  entry: number | null
  exit: number | null
  parts: {
    /** Share of counted entry rules passed, 0..100; null = none counted / known. */
    entryRules: number | null
    /** The order-flow Score total, 0..100; null = not scored or switched off. */
    flow: number | null
    kept: number | null
    stopRespected: number | null
    runner: number | null
    /** The runner part came from the trader's own runner rules. */
    runnerOwn: boolean
  }
  entryResults: RuleResult[]
  runnerResults: RunnerResult[] | null
  flowScore: TradeFlowScore | null
  /** The entry snapshot the rules read (for the panel's note on the two Tape Reader windows). */
  entryCtx: TradeEntryCtx | null
  /** How the trade ended, for the Exit lines. */
  exitKind: ReturnType<typeof exitKind>
}

function blend(parts: [number | null | undefined, number][]): number | null {
  let s = 0, w = 0
  for (const [v, wt] of parts) if (v != null && Number.isFinite(v)) { s += v * wt; w += wt }
  return w > 0 ? s / w : null
}

export function tradeGrade(t: GradeTrade, o: TradeGradeOptions = {}): TradeGrade {
  const entryRules = (o.entryRules ?? []).filter(r => r.on)
  const runnerRules = (o.runnerRules ?? []).filter(r => r.on)
  const includeFlow = o.includeFlow !== false
  const flowScore = o.flow ?? t.review_json?.score ?? null
  const ctx = o.entryCtx ?? t.review_json?.entry_ctx ?? null

  // Entry
  const entryResults = entryRules.length ? evaluateRules(entryRules, ctx, { direction: t.direction, symbol: t.symbol, entry_time: t.entry_time ?? null }) : []
  const rulesShare = tradeRulesScore(entryResults)
  const flowTotal = flowScore ? tradeFlowTotal({ review_json: { score: flowScore } }) : null
  const flow = includeFlow ? flowTotal : null
  const entry = blend([[rulesShare, PART_WEIGHTS.entryRules], [flow != null ? flow / 100 : null, PART_WEIGHTS.flow]])

  // Exit
  const ex = exitTradeScores(t, { atrStopTarget: o.atrStopTarget })
  const rp = tradeRunnerPart(t, runnerRules)
  const runner = rp.own ? rp.score : (ex.runner ?? null)
  const exit = blend([[ex.kept, PART_WEIGHTS.kept], [ex.stopRespected, PART_WEIGHTS.stopRespected], [runner, PART_WEIGHTS.runner]])

  const both = entry != null && exit != null ? (entry + exit) / 2 : (entry ?? exit)
  const pct = (x: number | null | undefined) => (x == null ? null : x * 100)
  return {
    score: both == null ? null : Math.round(both * 100),
    entry: entry == null ? null : Math.round(entry * 100),
    exit: exit == null ? null : Math.round(exit * 100),
    parts: {
      entryRules: pct(rulesShare), flow: flowTotal, kept: pct(ex.kept), stopRespected: pct(ex.stopRespected),
      runner: pct(runner), runnerOwn: rp.own,
    },
    entryResults,
    runnerResults: runnerRules.length ? evaluateRunnerRules(runnerRules, t) : null,
    flowScore: includeFlow ? flowScore : null,
    entryCtx: ctx,
    exitKind: exitKind(t),
  }
}

