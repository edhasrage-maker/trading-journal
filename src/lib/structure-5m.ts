/**
 * 5-minute structure alignment detection — was the trade FOLLOWING or
 * FADING the 5m trend at entry?
 *
 * Method (simple, deterministic):
 *   1. Aggregate 1m bars → 5m bars from session start up through the trade's
 *      entry minute. (Boundaries: 5m bars start at minute % 5 == 0 in the
 *      bar's local PT minute.)
 *   2. Compute EMA-20 of the 5m closes.
 *   3. Compare the trade entry's containing 5m bar close to the EMA-20:
 *        close > EMA → uptrend
 *        close < EMA → downtrend
 *        |close − EMA| / close < 0.02%  → neutral (avoid noise around the line)
 *   4. Combine with trade direction:
 *        long  + uptrend   → 'following'
 *        long  + downtrend → 'fading'
 *        short + downtrend → 'following'
 *        short + uptrend   → 'fading'
 *        either + neutral  → 'neutral'
 *
 * Returns null when bars are missing, when fewer than 20 5m bars exist
 * before the entry (EMA not stabilized), or when trade direction is null.
 *
 * Not the only possible signal — pivot-based (HH/HL vs LH/LL) is the
 * obvious richer follow-up. Simple EMA-20 was picked first because it's
 * defensive against noise, well-understood, and uses bars we already have.
 */

import type { BarLike } from './analytics'

export type StructureAlignment = 'following' | 'fading' | 'neutral'

const EMA_PERIOD = 20
const NEUTRAL_THRESHOLD = 0.0002  // 0.02% — within this band, neither trending up nor down

interface Bar5m {
  /** ISO-8601 timestamp of the bar's open (UTC). */
  ts: string
  close: number
}

/**
 * Aggregate 1m bars into 5m buckets. Bucket key is `floor(epoch_ms / 5min)`
 * — exchange-agnostic, no timezone math needed. Each 5m bar's close is the
 * close of the LAST 1m bar in that bucket (i.e. the latest-timestamp bar).
 * Input bars should be sorted ascending by ts; if not, we sort first.
 */
function aggregate1mTo5m(bars1m: Array<{ ts: string; close?: number; high: number; low: number }>): Bar5m[] {
  if (bars1m.length === 0) return []
  // BarLike doesn't carry `close` in its public shape, but bar fetches do —
  // we accept either, derive a close fallback as `(high + low) / 2` if not
  // provided. Better to be approximately right than miss the bar entirely.
  const sorted = [...bars1m].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  const buckets = new Map<number, { ts: string; close: number }>()
  for (const b of sorted) {
    const ms = Date.parse(b.ts)
    if (!Number.isFinite(ms)) continue
    const bucketKey = Math.floor(ms / (5 * 60 * 1000))
    const close = b.close ?? (b.high + b.low) / 2
    const prev = buckets.get(bucketKey)
    // Always overwrite — the later 1m bar in the bucket has the canonical close.
    if (!prev || Date.parse(b.ts) > Date.parse(prev.ts)) {
      buckets.set(bucketKey, { ts: b.ts, close })
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
}

/**
 * Compute Wilder-style EMA. (Standard EMA is fine here too; Wilder is just
 * 2 / (N+1) → 1/N, more conservative response. We use standard 2/(N+1) since
 * the structure signal is short-term and a slightly more responsive EMA is
 * the right tradeoff.) Returns the EMA value as of the last bar.
 */
function emaLast(values: number[], period: number): number | null {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  // Seed: simple average of the first `period` closes.
  let ema = 0
  for (let i = 0; i < period; i++) ema += values[i]
  ema /= period
  // Walk forward applying the EMA recurrence.
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
  }
  return ema
}

/**
 * Compute the alignment for a single trade given the day's 1m bars.
 * Returns null when there's not enough data to call it.
 */
export function computeStructure5mAlignment(
  trade: {
    entry_time?: string | null
    direction?: 'long' | 'short' | null
  },
  bars1m: BarLike[] & Array<{ close?: number }>,
): StructureAlignment | null {
  if (!trade.entry_time || !trade.direction) return null
  if (bars1m.length === 0) return null

  const entryMs = Date.parse(trade.entry_time)
  if (!Number.isFinite(entryMs)) return null

  // Only consider bars whose timestamp is at or before the entry. The 5m
  // bucket that CONTAINS entry_time should include all 1m bars up to entry,
  // but not bars after entry (no lookahead). We filter strictly before
  // taking the bucket the entry falls into.
  const entryBucketKey = Math.floor(entryMs / (5 * 60 * 1000))
  const eligible = bars1m.filter(b => {
    const ms = Date.parse(b.ts)
    if (!Number.isFinite(ms)) return false
    const bucketKey = Math.floor(ms / (5 * 60 * 1000))
    return bucketKey < entryBucketKey || (bucketKey === entryBucketKey && ms <= entryMs)
  })
  if (eligible.length === 0) return null

  const bars5m = aggregate1mTo5m(eligible)
  if (bars5m.length < EMA_PERIOD) return null

  const lastClose = bars5m[bars5m.length - 1].close
  const ema = emaLast(bars5m.map(b => b.close), EMA_PERIOD)
  if (ema == null) return null

  // Neutral band — treat as no-trend if close hugs the EMA.
  const distance = Math.abs(lastClose - ema) / lastClose
  if (distance < NEUTRAL_THRESHOLD) return 'neutral'

  const uptrend = lastClose > ema
  const isLong = trade.direction === 'long'
  if (uptrend) return isLong ? 'following' : 'fading'
  return isLong ? 'fading' : 'following'
}
