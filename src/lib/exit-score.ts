import { exitKind, tradeFacts, type MgmtTradeInput, type TradeFacts } from '@/lib/trade-management'
import { symbolToMultiplier } from '@/lib/futures-symbols'
import { plannedStopPrice, stopPlan, type StopSource } from '@/lib/planned-stop'

/**
 * The five per-trade factors (founder-directed, 2026-10-13; split across two
 * axes 2026-10-14). Deterministic: every number comes from the trade's own
 * logged prices and fills; nothing is estimated by the AI.
 *
 *   Exit axis (src/lib/tapescore-axes.ts — 42 / 33 / 25):
 *   1  Profit kept        WINNERS only. A winner that reached its planned
 *                         target counts in full; any other winner counts for
 *                         the share of its best point it kept.
 *   3  Stop respected     Trades whose planned stop came into play, or whose
 *                         stop the trader moved past its plan after the
 *                         first minute. Passes when price never traded past
 *                         the planned stop by more than slippage and the stop
 *                         was never moved past the plan (src/lib/planned-stop.ts:
 *                         Sierra's stop history where the trade has it, so a
 *                         stop tightened during the trade is judged at each
 *                         moment, not by its last price; founder 2026-10-16).
 *   5  Runner             Only trades where a second target was attempted. The
 *                         parts that can be measured today: the first target
 *                         was actually filled, and the 5-minute structure was
 *                         with the trade.
 *
 *   Risk axis (moved from Exit 2026-10-14; see src/lib/tapescore-axes.ts):
 *   2  Loss size          LOSERS only. The dollar loss against the spread of the
 *                         trader's own planned dollar risk (their RiskYardstick:
 *                         mean and SD over recent stop trades). Full marks up to
 *                         mean + 1 SD, none at mean + 2 SD or more, linear in
 *                         between. Without a yardstick: against the trade's own
 *                         planned risk, full marks to 1.1×, none at 2×.
 *   4  Stop size          Trades with a stop and an entry ATR. Passes when the
 *                         stop is no wider than the trader's ATR stop setting
 *                         (1× the 1-minute ATR-10 by default).
 *
 * Apart from loss size's yardstick (founder, 2026-10-14), definitions and
 * thresholds are unchanged by the move. A trade that never went
 * anywhere is not an exit failure and is not counted against factor 1. How the
 * factors are weighted and pooled lives in src/lib/tapescore-axes.ts.
 *
 * NOT MEASURED YET (factor 5): whether the stop was moved to breakeven after
 * the first target, the 4-hour alignment, and which trailing method was used.
 * None of these is recorded on a trade today.
 */

export type TradeFactorKey = 'kept' | 'lossSize' | 'stopRespected' | 'stopSize' | 'runner'
export const TRADE_FACTORS: readonly TradeFactorKey[] = ['kept', 'lossSize', 'stopRespected', 'stopSize', 'runner']

/** The trader's usual risk: mean and population SD of the planned dollar risk
 *  of their recent stop trades (src/lib/exit-rollup.ts builds it). */
export interface RiskYardstick { mean: number; sd: number; n: number }

/** Loss against the yardstick: full marks up to mean + this many SDs … */
const LOSS_OK_SDS = 1
/** … and none from mean + this many. Linear in between. */
const LOSS_ZERO_SDS = 2
/** Without a yardstick — loss ÷ the trade's own planned risk: full marks up to here … */
const LOSS_OK = 1.1
/** … and none from here. Linear in between. */
const LOSS_ZERO = 2.0
/** A stop "came into play" once the trade was this share of the way to it. */
const STOP_IN_PLAY = 0.9
/** Slippage past the stop that still counts as respected: this share of the risk, at least two ticks. */
const STOP_SLIP_SHARE = 0.1
const STOP_SLIP_MIN_PTS = 0.5
/** Stop width allowed over the trader's ATR stop setting before it reads as too wide. */
const STOP_SIZE_TOLERANCE = 1.1

export interface ExitTradeInput extends MgmtTradeInput {
  tp1_price?: number | null
  structure_5m_alignment?: 'following' | 'fading' | 'neutral' | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json?: any
}

export interface ExitContext {
  /** The trader's usual risk going into this trade. Null = unknown; the trade's own planned risk is used. */
  riskYardstick?: RiskYardstick | null
  /** Live ATR override for this trade (else the stored entry ATR). */
  atr?: number | null
  /** The trader's ATR stop setting, in ATRs (scoring profile; default 1). */
  atrStopTarget?: number
}

/** One trade's score on each factor that applies to it, 0..1. */
export type ExitTradeScores = Partial<Record<TradeFactorKey, number>>

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Did this trade go for a second target? A "TP2 …" management tag, or fills that took the first target and left a piece on. */
export function runnerAttempted(t: ExitTradeInput): boolean {
  const tags: unknown = t.tags_json?.trade_management
  if (Array.isArray(tags) && tags.some(x => typeof x === 'string' && /^tp2\b/i.test(x.trim()))) return true
  return firstTargetFilled(t) && distinctExitPrices(t) >= 2
}

function exitPrices(t: ExitTradeInput): number[] {
  const legs = Array.isArray(t.exits_json) ? t.exits_json : []
  const out: number[] = []
  for (const l of legs) { const p = Number(l?.price); if (Number.isFinite(p)) out.push(p) }
  return out
}
const distinctExitPrices = (t: ExitTradeInput) => new Set(exitPrices(t)).size

function firstTargetFilled(t: ExitTradeInput): boolean {
  if (t.entry_price == null || t.direction == null || t.tp1_price == null) return false
  const sign = t.direction === 'long' ? 1 : -1
  const tp = t.tp1_price
  if ((tp - t.entry_price) * sign <= 0) return false
  const prices = exitPrices(t)
  if (prices.length === 0 && t.exit_price != null) prices.push(t.exit_price)
  return prices.some(p => (p - tp) * sign >= -1e-9)
}

/** A trade's own planned dollar risk, at the size its fills actually traded. Null without a stop. */
function ownRiskDollars(f: TradeFacts, pnl: number): number | null {
  const res = f.result.pts as number
  const qtyUsd = res !== 0 ? Math.abs(pnl / res) : null                         // dollars per point for this trade
  return f.riskPts != null && qtyUsd != null ? f.riskPts * qtyUsd : null
}

/**
 * Factor 2 for one losing trade: its dollar loss against the trader's usual
 * risk spread when that is known (full marks to mean + 1 SD, none from mean +
 * 2 SD), else against the trade's own planned risk (1.1× / 2×). Null when there
 * is neither. Split out of `exitTradeScores` (which calls it) so a stored loss
 * can be scored later, once the yardstick is known, by the same arithmetic.
 */
export function lossSizeScore(lossDollars: number, ownRisk: number | null, yardstick?: RiskYardstick | null): number | null {
  const loss = Math.abs(lossDollars)
  if (yardstick && yardstick.mean > 0) {
    const ok = yardstick.mean + LOSS_OK_SDS * yardstick.sd
    const zero = yardstick.mean + LOSS_ZERO_SDS * yardstick.sd
    if (loss <= ok + 1e-9) return 1
    if (loss >= zero || zero <= ok) return 0
    return (zero - loss) / (zero - ok)
  }
  if (ownRisk == null || !(ownRisk > 0)) return null
  const ratio = loss / ownRisk
  return ratio <= LOSS_OK ? 1 : ratio >= LOSS_ZERO ? 0 : (LOSS_ZERO - ratio) / (LOSS_ZERO - LOSS_OK)
}

/**
 * The two numbers factor 2 needs from a losing trade — [dollars lost, its own
 * planned dollar risk or null] — for scoring with `lossSizeScore` once the
 * trader's yardstick is known. Null for a trade factor 2 does not judge.
 */
export function lossSizeInputs(t: ExitTradeInput, ctx: ExitContext = {}): [number, number | null] | null {
  const f = tradeFacts(t, { atr: ctx.atr })
  if (!f || t.pnl == null || !(t.pnl < 0)) return null
  return [Math.abs(t.pnl), ownRiskDollars(f, t.pnl)]
}

export function exitTradeScores(t: ExitTradeInput, ctx: ExitContext = {}): ExitTradeScores {
  const out: ExitTradeScores = {}
  const f = tradeFacts(t, { atr: ctx.atr })
  if (!f || t.pnl == null) return out
  const mfe = f.mfe.pts as number, res = f.result.pts as number

  // 1 · profit kept — winners only
  if (t.pnl > 0) {
    if (exitKind(t) === 'target') out.kept = 1
    else if (mfe > 0) out.kept = clamp01(res / mfe)
  }

  // 2 · loss size — losers only, in dollars against the trader's usual risk
  if (t.pnl < 0) {
    const s = lossSizeScore(Math.abs(t.pnl), ownRiskDollars(f, t.pnl), ctx.riskYardstick)
    if (s != null) out.lossSize = s
  }

  // 3 · stop respected — when the stop came into play, or the trader moved it away
  const sc = stopCheck(t, f)
  if (sc?.judged) out.stopRespected = sc.respected ? 1 : 0

  // 4 · stop size — against the trader's ATR stop setting
  if (f.riskPts != null && f.atr != null) {
    const target = ctx.atrStopTarget != null && ctx.atrStopTarget > 0 ? ctx.atrStopTarget : 1
    out.stopSize = f.riskPts / f.atr <= STOP_SIZE_TOLERANCE * target + 1e-9 ? 1 : 0
  }

  // 5 · runner — only when a second target was attempted; the measurable parts
  if (runnerAttempted(t)) {
    const parts: number[] = [firstTargetFilled(t) ? 1 : 0]
    if (t.structure_5m_alignment === 'following') parts.push(1)
    else if (t.structure_5m_alignment === 'fading') parts.push(0)
    out.runner = parts.reduce((a, b) => a + b, 0) / parts.length
  }
  return out
}

export interface StopCheck {
  /** The stop came into play (or was moved past its plan), so Stop respected judges it. */
  judged: boolean
  respected: boolean
  /** Price went past the planned stop — what the "past stop" label says. */
  past: boolean
}

/**
 * Factor 3 and the "past stop" label, from one reading so they never disagree.
 * Null without a planned stop.
 *
 * With Sierra's stop history (src/lib/planned-stop.ts) the stops were working
 * the whole time, so price can only get past the planned stop if one was moved
 * away or pulled: a fill at a working stop at or inside the plan is the stop
 * doing its job, however the tape printed around the fill, and a stop tightened
 * and then hit is a stop respected (founder, 2026-10-16). Moving a stop past
 * its planned stop after the first minute fails it outright (2026-10-17). Without the history, the
 * logged stop exactly as before: judged once price came within 10% of it,
 * respected within slippage, "past" once the heat passed it.
 */
export function stopCheck(t: ExitTradeInput, f: TradeFacts | null = tradeFacts(t)): StopCheck | null {
  if (!f || f.riskPts == null) return null
  const mae = f.mae.pts as number
  const slip = Math.max(STOP_SLIP_MIN_PTS, STOP_SLIP_SHARE * f.riskPts)
  const plan = stopPlan(t)
  if (plan.source !== 'sierra') {
    return { judged: mae >= STOP_IN_PLAY * f.riskPts, respected: mae - f.riskPts <= slip + 1e-9, past: mae > f.riskPts }
  }
  const sign = t.direction === 'long' ? 1 : -1
  const dist = (px: number) => ((t.entry_price as number) - px) * sign
  const movedAway = plan.movedAway != null
  const stopped = exitKind(t) === 'stopped'
  const atWorkingStop = stopped && plan.final != null && dist(plan.final) <= f.riskPts + 1e-9
  const past = mae - f.riskPts > slip + 1e-9 && !atWorkingStop
  return { judged: movedAway || stopped || mae >= STOP_IN_PLAY * f.riskPts, respected: !movedAway && !past, past }
}

/** Planned dollar risk of a trade (planned stop distance × size), or null without a stop. */
export function plannedRiskDollars(t: StopSource & {
  entry_price?: number | null; stop_price?: number | null; quantity?: number | null; symbol?: string | null
}): number | null {
  const stop = plannedStopPrice(t)
  if (t.entry_price == null || stop == null || t.quantity == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  const risk = Math.abs(t.entry_price - stop) * t.quantity * mult
  return risk > 0 ? risk : null
}
