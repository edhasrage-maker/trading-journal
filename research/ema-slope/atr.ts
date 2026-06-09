import type { OhlcBar } from './load'

// Wilder's ATR. atr[i] = ATR computed using TRs up through bar i (i.e. known at bar i's close).
// Returns NaN for indices before the smoothing window has filled.
export function atrWilder(bars: OhlcBar[], period: number): number[] {
  const n = bars.length
  const out = new Array<number>(n).fill(NaN)
  if (n === 0) return out
  const tr = new Array<number>(n)
  tr[0] = bars[0].high - bars[0].low
  for (let i = 1; i < n; i++) {
    const b = bars[i]
    const prevClose = bars[i - 1].close
    tr[i] = Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    )
  }
  if (n < period) return out
  let atr = 0
  for (let i = 0; i < period; i++) atr += tr[i]
  atr /= period
  out[period - 1] = atr
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period
    out[i] = atr
  }
  return out
}
