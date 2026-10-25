/**
 * The Score's version label and "which fill was this read for" fingerprint.
 *
 * Kept apart from the scorer (flow-score.ts) so the browser can tell whether a
 * trade's stored score is current without bundling the scorer itself.
 *
 * Both must stay byte-identical to the local Python scorer
 * (xy_playbook/push_scores.py: VERSION and fingerprint()), which writes the
 * same `trades.review_json.score` — otherwise the two would keep re-scoring
 * each other's rows.
 */
import type { TradeEntryCtx, TradeFlowScore } from '@/lib/supabase/types'

export const FLOW_VERSION = 'flow-5'

/** Python's str(float(x)) for a price: an integral value keeps its ".0". */
function pyFloatStr(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x)
}

export interface FlowFingerprintRow {
  entry_time: string | null
  entry_price: number | string | null
  direction: string | null
  symbol: string | null
}

/** Identifies the fill a score was read for; a re-timed or re-priced trade gets re-scored. */
export function flowFingerprint(r: FlowFingerprintRow): string {
  return `${r.entry_time}|${pyFloatStr(Number(r.entry_price))}|${r.direction}|${r.symbol}`
}

/** True when `score` is this version's read of exactly this fill. */
export function flowScoreIsCurrent(score: TradeFlowScore | null | undefined, r: FlowFingerprintRow): boolean {
  return !!score && score.v === FLOW_VERSION && score.src === flowFingerprint(r)
}

/** Version of the entry rules' snapshot (trades.review_json.entry_ctx, ./entry-context.ts). Bump when what it reads or how changes. */
export const ENTRY_CTX_VERSION = 'ectx-1'

/** True when `ctx` is this version's snapshot of exactly this fill. */
export function entryCtxIsCurrent(ctx: TradeEntryCtx | null | undefined, r: FlowFingerprintRow): boolean {
  return !!ctx && ctx.v === ENTRY_CTX_VERSION && ctx.src === flowFingerprint(r)
}

/** One trade's snapshot answer from POST /api/trades/score (`entry` in the response). */
export type EntryCtxResult =
  | { status: 'read' | 'current'; ctx: TradeEntryCtx }
  | { status: 'not_scorable' | 'pending' | 'error'; reason: string }

/** Trades per POST /api/trades/score request. */
export const FLOW_SCORE_MAX_IDS = 25

/** One trade's answer from POST /api/trades/score. */
export type FlowScoreResult =
  /** Scored now (and saved), or already carried this version's score for this fill. */
  | { status: 'scored' | 'current'; score: TradeFlowScore }
  /** not_scorable: the tape cannot read this trade. pending: not yet — ask again shortly. Nothing was written. */
  | { status: 'not_scorable' | 'pending' | 'error'; reason: string }
