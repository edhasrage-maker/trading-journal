// Pure EMA + slope math. No I/O.

export function emaSeries(closes: number[], length: number): number[] {
  if (closes.length === 0) return []
  const k = 2 / (length + 1)
  const out: number[] = new Array(closes.length)
  out[0] = closes[0]
  for (let i = 1; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k)
  }
  return out
}

// Simple rolling mean over `length` bars. The first `length-1` values are NaN
// (no partial-window average) so immature windows never leak into slope/spread —
// downstream NaN comparisons are all false, which naturally suppresses signals
// on those bars. Unlike emaSeries (which seeds out[0] = closes[0]).
export function smaSeries(closes: number[], length: number): number[] {
  const n = closes.length
  const out: number[] = new Array(n).fill(NaN)
  if (n === 0 || length <= 0) return out
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += closes[i]
    if (i >= length) sum -= closes[i - length]
    if (i >= length - 1) out[i] = sum / length
  }
  return out
}

// Average % change of the EMA per bar, across `lookback` bars ending at idx.
// Returns null if there isn't enough history at idx.
export function slopePercent(ema: number[], idx: number, lookback: number): number | null {
  if (idx < lookback) return null
  const a = ema[idx - lookback]
  const b = ema[idx]
  if (!a) return null
  return ((b / a - 1) * 100) / lookback
}

// Slope as a geometric angle in degrees, normalizing dy by tickSize and dx by 1 (per bar).
// Useful when comparing across instruments — but only meaningful relative to your chosen tick.
export function slopeDegrees(
  ema: number[],
  idx: number,
  lookback: number,
  tickSize: number,
): number | null {
  if (idx < lookback) return null
  const dPrice = ema[idx] - ema[idx - lookback]
  const dyTicks = dPrice / tickSize
  return (Math.atan2(dyTicks, lookback) * 180) / Math.PI
}
