'use client'

import { useCallback, useMemo } from 'react'
import { tradeGrade, type TradeGrade } from '@/lib/trade-grade'
import { reentryReads } from '@/lib/tapescore-day-rules'
import { useFlowScores, flowScoreFor, entryCtxFor } from '@/lib/use-flow-scores'
import type { EntryRuleConfig } from '@/lib/entry-rules'
import type { RunnerRuleConfig } from '@/lib/runner-rules'
import type { Trade } from '@/lib/supabase/types'

/**
 * Each trade's Score = its grade: Entry (the trader's entry rules + the
 * order-flow Score) and Exit (profit kept, stop respected, runner rules),
 * averaged — src/lib/trade-grade.ts. A quick re-entry after a loss adds
 * "Waited after a loss", read over the day's trades.
 *
 * One hook so the Session page's table and its trade panel read the SAME grade
 * from the same background scores — two copies of useFlowScores would each send
 * the day's trades to POST /api/trades/score. While capturing (live), there is
 * no grade; only the entry snapshots are read, for the rule mistake tags.
 */
export function useTradeGrades(trades: Trade[], {
  capture, entryRules, runnerRules, includeFlow = true, atrStopTarget = 1, enabled = true,
}: {
  capture: boolean
  entryRules?: EntryRuleConfig[]
  runnerRules?: RunnerRuleConfig[]
  includeFlow?: boolean
  atrStopTarget?: number
  /** False = this caller is handed grades from elsewhere; read nothing. */
  enabled?: boolean
}): (t: Trade) => TradeGrade | null {
  const { scores, entry } = useFlowScores(trades, enabled, { entryOnly: capture })
  const reentries = useMemo(() => reentryReads(trades), [trades])
  return useCallback((t: Trade): TradeGrade | null => (capture ? null : tradeGrade(t, {
    entryRules, runnerRules, includeFlow, atrStopTarget, flow: flowScoreFor(t, scores), entryCtx: entryCtxFor(t, entry),
    reentry: reentries.get(t.id) ?? null,
  })), [capture, entryRules, runnerRules, includeFlow, atrStopTarget, scores, entry, reentries])
}
