/**
 * Indicator calculations over OHLCV bar series. Pure functions — no I/O.
 * Used by LiveChart to overlay VWAP / EMA(9) / EMA(20) on the candle series.
 */

export interface IndicatorBar {
  ts: string  // ISO-8601
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

/**
 * Exponential moving average over closing prices.
 * Returns an array aligned 1:1 with the input — null for indices before the
 * EMA has seeded (i < period - 1). First valid EMA value is the SMA of the
 * first `period` closes (standard convention).
 */
export function calcEMA(closes: number[], period: number): (number | null)[] {
  if (period <= 0) throw new Error(`EMA period must be positive, got ${period}`)
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period) return out
  const mult = 2 / (period + 1)

  // Seed: SMA of first `period` closes
  let sma = 0
  for (let i = 0; i < period; i++) sma += closes[i]
  sma /= period
  out[period - 1] = sma
  let prev = sma

  for (let i = period; i < closes.length; i++) {
    const ema = closes[i] * mult + prev * (1 - mult)
    out[i] = ema
    prev = ema
  }
  return out
}

/**
 * Volume-weighted average price, cumulative from the start of the bar series.
 * VWAP = Σ(typical_price * volume) / Σ(volume), where typical = (H+L+C)/3.
 *
 * Bars with null/zero volume contribute the typical price weighted by 0 — the
 * VWAP value still tracks (just doesn't advance from the prior point). If
 * volume is null for ALL bars in the series, VWAP falls back to the running
 * typical-price average so the line still renders.
 */
export function calcVWAP(bars: IndicatorBar[]): number[] {
  const out: number[] = []
  let cumPV = 0
  let cumV = 0
  let cumTypical = 0
  let count = 0

  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3
    const vol = b.volume ?? 0
    cumPV += typical * vol
    cumV += vol
    cumTypical += typical
    count += 1
    out.push(cumV > 0 ? cumPV / cumV : cumTypical / count)
  }
  return out
}
