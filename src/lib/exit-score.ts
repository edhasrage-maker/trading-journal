import { exitKind, tradeFacts, type MgmtTradeInput, type TradeFacts } from '@/lib/trade-management'
import { symbolToMultiplier } from '@/lib/futures-symbols'

/**
 * The five per-trade factors (founder-directed, 2026-10-13; split across two
 * axes 2026-10-14). Deterministic: every number comes from the trade's own
 * logged prices and fills; nothing is estimated by the AI.
 *
 *   Exit axis (src/lib/tapescore-axes.ts — 42 / 33 / 25):
 *   1  Profit kept        WINNERS only. A winner that reached its planned
 *                         target counts in full; any other winner counts for
 *                         the share of its best point it kept.
 *   3  Stop respected     Trades whose logged stop came into play. Passes when
 *                         price never traded past it by more than slippage
 *                         while the trade was on.
 *   5  Runner             Only trades where a second target was attempted. The
 *                         parts that can be measured today: the first target
 *                         was actually filled, and the 5-minute structure was
 *                         with the trade.
 *
 *   Risk axis (moved from Exit 2026-10-14; rules kept 50 / loss size 30 / stop size 20):
 *   2  Loss size          LOSERS only. The dollar loss against the trader's own
 *                         average dollar risk. Full marks up to 1.1× that
 *                         average, none at 2× or more.
 *   4  Stop size          Trades with a stop and an entry ATR. Passes when the
 *                         stop is no wider than the trader's ATR stop setting
 *                         (1× the 1-minute ATR-10 by default).
 *
 * Definitions and thresholds are unchanged by the move. A trade that never went
 * anywhere is not an exit failure and is not counted against factor 1. How the
 * factors are weighted and pooled lives in src/lib/tapescore-axes.ts.
 *
 * NOT MEASURED YET (factor 5): whether the stop was moved to breakeven after
 * the first target, the 4-hour alignment, and which trailing method was used.
 * None of these is recorded on a trade today.
 */

export type TradeFactorKey = 'kept' | 'lossSize' | 'stopRespected' | 'stopSize' | 'runner'
export const TRADE_FACTORS: readonly TradeFactorKey[] = ['kept', 'lossSize', 'stopRespected', 'stopSize', 'runner']

/** Loss ÷ average risk: full marks up to here … */
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
  /** The trader's average planned dollar risk before this trade. Null = unknown; the trade's own planned risk is used. */
  avgRiskDollars?: number | null
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
 * Factor 2 for one losing trade: its dollar loss against a yardstick — the
 * trader's average dollar risk when that is known, else the trade's own planned
 * risk. Null when there is neither. Split out of `exitTradeScores` (which calls
 * it) so a stored loss can be scored later, once the average is known, by the
 * same arithmetic.
 */
export function lossSizeScore(lossDollars: number, ownRisk: number | null, avgRiskDollars?: number | null): number | null {
  const yardstick = avgRiskDollars != null && avgRiskDollars > 0 ? avgRiskDollars : ownRisk
  if (yardstick == null || !(yardstick > 0)) return null
  const ratio = Math.abs(lossDollars) / yardstick
  return ratio <= LOSS_OK ? 1 : ratio >= LOSS_ZERO ? 0 : (LOSS_ZERO - ratio) / (LOSS_ZERO - LOSS_OK)
}

/**
 * The two numbers factor 2 needs from a losing trade — [dollars lost, its own
 * planned dollar risk or null] — for scoring with `lossSizeScore` once the
 * trader's average risk is known. Null for a trade factor 2 does not judge.
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
  const mfe = f.mfe.pts as number, mae = f.mae.pts as number, res = f.result.pts as number

  // 1 · profit kept — winners only
  if (t.pnl > 0) {
    if (exitKind(t) === 'target') out.kept = 1
    else if (mfe > 0) out.kept = clamp01(res / mfe)
  }

  // 2 · loss size — losers only, in dollars against the trader's average risk
  if (t.pnl < 0) {
    const s = lossSizeScore(Math.abs(t.pnl), ownRiskDollars(f, t.pnl), ctx.avgRiskDollars)
    if (s != null) out.lossSize = s
  }

  // 3 · stop respected — only when the logged stop came into play
  if (f.riskPts != null && mae >= STOP_IN_PLAY * f.riskPts) {
    const slip = Math.max(STOP_SLIP_MIN_PTS, STOP_SLIP_SHARE * f.riskPts)
    out.stopRespected = mae - f.riskPts <= slip + 1e-9 ? 1 : 0
  }

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

/** Planned dollar risk of a trade (stop distance × size), or null without a stop. */
export function plannedRiskDollars(t: ExitTradeInput): number | null {
  if (t.entry_price == null || t.stop_price == null || t.quantity == null) return null
  const mult = symbolToMultiplier(t.symbol ?? '')
  const risk = Math.abs(t.entry_price - t.stop_price) * t.quantity * mult
  return risk > 0 ? risk : null
}
