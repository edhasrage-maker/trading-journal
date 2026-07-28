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
 *  2. RECENCY — the level must have LAST PRINTED within `maxMinutes` of the
 *     entry. Anchored on `lastMs`, not `firstMs`: a price row aggregates the
 *     whole session and price revisits levels, so a row's first print is
 *     usually near the open and says nothing about whether the level was live.
 *     Its last print does.
 *
 *  3. PRECEDENCE — the level must already have been forming at entry
 *     (`level.firstMs <= entryMs`).
 *
 * PRECEDENCE IS NOT SUFFICIENT ON ITS OWN, and this is the subtle part. A row
 * that started before the entry can still accumulate most of its delta AFTER
 * it, so a session-wide profile matched against a mid-session entry credits the
 * trader with size that had not printed yet. Since these tags feed Entry
 * scoring, that inflates the score on hindsight.
 *
 * The fix is upstream of this module: build the rows over `[sessionStart,
 * entryMs)` so every number is AS OF THE ENTRY. That is also what the trader's
 * DBP actually showed on screen at that moment. The gates here are the second
 * line of defence, not the first.
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
  /**
   * Row height in price units, matching the reader. A level is an INTERVAL
   * `[price, price + rowHeight)`, not a point, and on a 5pt NQ row that gap
   * matters: an entry near the row's top is 19 ticks from its low edge while
   * sitting squarely inside the level.
   */
  rowHeight: number
  /** Max distance from the level INTERVAL, in ticks. Zero when inside it. */
  maxTicks: number
  /** Max age, in minutes, since the level LAST printed. */
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
  /** Minutes between the level's LAST print and the entry. */
  ageMinutes: number
  /** Minutes the level had been forming at entry (entry − firstMs). */
  formingMinutes: number
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
  if (!(cfg.rowHeight > 0)) throw new Error(`matchTradeToLevels: rowHeight must be > 0 (got ${cfg.rowHeight})`)
  const requireEstablished = cfg.requireEstablished ?? true
  const maxMs = cfg.maxMinutes * 60_000
  const out: LevelMatch[] = []

  for (const level of levels) {
    if (requireEstablished && level.firstMs > trade.entryMs) continue
    const ageMs = trade.entryMs - level.lastMs
    if (Math.abs(ageMs) > maxMs) continue

    // Distance to the row INTERVAL, not to its low edge — 0 when price is
    // inside the row.
    const gap = Math.max(
      level.price - trade.entryPrice,
      trade.entryPrice - (level.price + cfg.rowHeight),
      0,
    )
    const distanceTicks = gap / cfg.tickSize
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
      formingMinutes: (trade.entryMs - level.firstMs) / 60_000,
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
