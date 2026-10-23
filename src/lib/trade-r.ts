import { plannedRiskDollars } from '@/lib/exit-score'
import type { StopSource } from '@/lib/planned-stop'

/**
 * Results in R — each trade's P&L against its own planned dollar risk
 * (plannedRiskDollars: Sierra's planned stop where the trade has its stop
 * history, else the logged stop). Founder, 2026-10-22: dollars per trade mix
 * position size in, so a big-size day and a quiet one can't be compared; R can.
 *
 * Used by the Recap's Trade management card (Net $ / R / Risk per trade, each
 * against the trader's usual over their last USUAL_SESSIONS sessions) and the
 * Recap header (the day in R, average win vs average loss). Mockup:
 * https://claude.ai/artifact/5QWKdATNpTntCQ6Ar9neZn. Pure and client-safe.
 */

/** The "usual" is the trader's last this-many sessions with trades. Founder
 *  picked 20 (2026-10-22), then 10 (2026-10-23) to react faster: on their days
 *  since Aug, 10 sessions (~38 trades) moved ~0.10R a day vs 0.05R for 20 and
 *  0.23R for 5 (~18 trades, mostly noise). */
export const USUAL_SESSIONS = 10

export type RTrade = StopSource & {
  pnl: number | null
  entry_price?: number | null
  stop_price?: number | null
  quantity?: number | null
  symbol?: string | null
}

/** A trade's result in R; null without a P&L or a planned stop. */
export function tradeR(t: RTrade): number | null {
  if (t.pnl == null) return null
  const risk = plannedRiskDollars(t)
  return risk ? t.pnl / risk : null
}

export interface PerTrade {
  /** Trades with a P&L. */
  trades: number
  /** Net P&L ÷ trades. */
  netPerTrade: number | null
  /** Average R over the trades with a planned stop. */
  rPerTrade: number | null
  /** Average planned dollar risk over the same trades. */
  riskPerTrade: number | null
  /** How many trades had a planned stop (the R and risk lines' sample). */
  withStop: number
}

/** Net $, R and risk per trade over a set of trades (a day, or a usual window pooled). */
export function perTrade(trades: readonly RTrade[]): PerTrade {
  const done = trades.filter(t => t.pnl != null)
  let net = 0, rSum = 0, riskSum = 0, withStop = 0
  for (const t of done) {
    net += t.pnl as number
    const risk = plannedRiskDollars(t)
    if (risk) { withStop++; riskSum += risk; rSum += (t.pnl as number) / risk }
  }
  return {
    trades: done.length,
    netPerTrade: done.length ? net / done.length : null,
    rPerTrade: withStop ? rSum / withStop : null,
    riskPerTrade: withStop ? riskSum / withStop : null,
    withStop,
  }
}

export interface DayR {
  /** The day's R, summed over trades with a planned stop; null when none has one. */
  totalR: number | null
  trades: number
  withStop: number
  /** Average winning and losing trade, in R (the loss as a positive number). */
  avgWinR: number | null
  avgLossR: number | null
  /** avgWinR ÷ avgLossR; null unless the day has both. */
  ratio: number | null
}

/** One day in R: its total, and its average win against its average loss. */
export function dayR(trades: readonly RTrade[]): DayR {
  const rs = trades.map(tradeR).filter((r): r is number => r != null)
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0)
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
  const avgWinR = avg(wins)
  const loss = avg(losses)
  const avgLossR = loss == null ? null : -loss
  return {
    totalR: rs.length ? rs.reduce((s, x) => s + x, 0) : null,
    trades: trades.filter(t => t.pnl != null).length,
    withStop: rs.length,
    avgWinR,
    avgLossR,
    ratio: avgWinR != null && avgLossR != null && avgLossR > 0 ? avgWinR / avgLossR : null,
  }
}

/** The trades of the last `sessions` dates in `byDate` (newest first by date), pooled. */
export function lastSessions<T extends RTrade>(byDate: ReadonlyMap<string, readonly T[]>, sessions = USUAL_SESSIONS): T[] {
  return [...byDate.entries()]
    .filter(([, ts]) => ts.some(t => t.pnl != null))
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .slice(0, sessions)
    .flatMap(([, ts]) => [...ts])
}

/** "+$118" / "−$45". */
export const fmtUsd = (x: number) => `${x >= 0 ? '+' : '−'}$${Math.abs(Math.round(x)).toLocaleString()}`
/** "+0.31R" / "−0.20R". */
export const fmtR = (x: number, digits = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}R`
