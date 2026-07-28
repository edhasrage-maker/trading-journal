import type { DetectedDeltaLevel } from './delta-by-price'

/**
 * Attach detected delta-by-price levels to trades — PURE. No fs, no clock.
 *
 * A level is only evidence about a trade if the trader could plausibly have
 * been reacting to it, so a match has to clear three gates, not one:
 *
 *  1. PROXIMITY — entry within `maxTicks` of the level. Expressed in TICKS, not
 *     points, so one config works across instruments.
 *
 *  2. RECENCY — entry within `maxMinutes` of the level. Size that printed three
 *     hours earlier is not what the trader was looking at.
 *
 *  3. PRECEDENCE — the level must already have been FORMING at entry time
 *     (`level.firstMs <= entryMs`). This is the gate that keeps the whole
 *     feature honest. Rows keep trading long after a trade is taken, so
 *     matching on the row's last print would routinely credit a trader with
 *     reading size that had not printed yet. Since these tags feed scoring,
 *     that is not a cosmetic error: it would inflate Entry on hindsight.
 *
 * `againstAggressor` is the interesting half. A long taken into a big SELL row
 * that got absorbed is a trader fading exhausted aggression; a long taken into
 * a big BUY row is one following strength. Same proximity, different trade.
 */

/** The minimum a trade has to expose to be matched. */
export interface TradeAnchor {
  id: string
  /** Entry timestamp, epoch ms. */
  entryMs: number
  entryPrice: number
  direction: 'long' | 'short' | null
}

export interface MatchConfig {
  /** Instrument tick size — 0.25 on ES and NQ. */
  tickSize: number
  /** Max |entry − level| distance, in ticks. */
  maxTicks: number
  /** Max |entry − level start| age, in minutes. */
  maxMinutes: number
  /**
   * Require the level to have started before the entry. Default TRUE, and
   * there is no good reason to turn it off outside of tests — see above.
   */
  requireEstablished?: boolean
}

export interface LevelMatch {
  tradeId: string
  level: DetectedDeltaLevel
  /** Absolute distance from entry to the level, in ticks. */
  distanceTicks: number
  /** How long the level had been forming at entry, in minutes. */
  ageMinutes: number
  /**
   * True when the trade took the side OPPOSITE the level's aggressor (a long
   * into heavy selling, a short into heavy buying) — i.e. fading it.
   * Null when the trade has no recorded direction.
   */
  againstAggressor: boolean | null
}

/**
 * Match one trade against a session's levels. Returns every qualifying level,
 * CLOSEST FIRST, so a caller that wants a single answer can take `[0]` without
 * having to re-sort. Ties on distance break toward the larger |delta|.
 */
export function matchTradeToLevels(
  trade: TradeAnchor,
  levels: DetectedDeltaLevel[],
  cfg: MatchConfig,
): LevelMatch[] {
  if (!(cfg.tickSize > 0)) throw new Error(`matchTradeToLevels: tickSize must be > 0 (got ${cfg.tickSize})`)
  const requireEstablished = cfg.requireEstablished ?? true
  const maxMs = cfg.maxMinutes * 60_000
  const out: LevelMatch[] = []

  for (const level of levels) {
    if (requireEstablished && level.firstMs > trade.entryMs) continue
    const ageMs = trade.entryMs - level.firstMs
    if (Math.abs(ageMs) > maxMs) continue

    const distanceTicks = Math.abs(trade.entryPrice - level.price) / cfg.tickSize
    if (distanceTicks > cfg.maxTicks) continue

    // A long fades a sell-side level; a short fades a buy-side level.
    const againstAggressor = trade.direction == null
      ? null
      : (trade.direction === 'long' ? level.side === 'sell' : level.side === 'buy')

    out.push({
      tradeId: trade.id,
      level,
      distanceTicks,
      ageMinutes: ageMs / 60_000,
      againstAggressor,
    })
  }

  out.sort((a, b) =>
    a.distanceTicks - b.distanceTicks ||
    Math.abs(b.level.delta) - Math.abs(a.level.delta))
  return out
}

/** Match many trades. Trades with no qualifying level are simply absent. */
export function matchTradesToLevels(
  trades: TradeAnchor[],
  levels: DetectedDeltaLevel[],
  cfg: MatchConfig,
): Map<string, LevelMatch[]> {
  const out = new Map<string, LevelMatch[]>()
  for (const t of trades) {
    const m = matchTradeToLevels(t, levels, cfg)
    if (m.length > 0) out.set(t.id, m)
  }
  return out
}
