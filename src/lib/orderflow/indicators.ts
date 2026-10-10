/**
 * VWAP and EMA for the Deep Dive time chart, computed the way TapeScore's live
 * chart does (src/lib/session-levels.ts, the port of the founder's Sierra
 * EdhasrageSessionLevels study) rather than the blind re-tag viewer's variants:
 *
 *   VWAP  — HLC3 × volume of each 1m bar, cumulative from the anchor.
 *           24h VWAP anchors at the trading day's 15:00 PT start; RTH VWAP at
 *           06:30 PT (none outside RTH).
 *   EMA   — 9 / 20 on 5-minute closes with Sierra's progressive warm-up
 *           (session-levels.ts sierraEma). Each 1m bar shows the EMA as of its
 *           own close, so the forming 5m bucket's value moves with price — the
 *           value at a 5m close equals the native 5m EMA exactly.
 *
 * One deliberate difference from session-levels.ts: the 24h VWAP anchors on the
 * TRADING date (15:00 PT the day before, including for evening trades), where
 * the live chart keys off the PT calendar date.
 */
import type { Bar1m } from './bars'

const tod = (t: number) => { const d = new Date(t * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes() }
/** Trading day key: bars at or after 15:00 PT belong to the next day. */
const tradingDayKey = (t: number) => Math.floor((t + 9 * 3600) / 86400)

export function vwap24h(m1: Bar1m[]): (number | null)[] {
  let key = NaN, pv = 0, v = 0
  return m1.map(b => {
    const k = tradingDayKey(b.t)
    if (k !== key) { key = k; pv = 0; v = 0 }
    pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v
    return v > 0 ? pv / v : null
  })
}

export function vwapRth(m1: Bar1m[]): (number | null)[] {
  let day = NaN, pv = 0, v = 0
  return m1.map(b => {
    const m = tod(b.t)
    if (m < 390 || m >= 780) return null
    const d = Math.floor(b.t / 86400)
    if (d !== day) { day = d; pv = 0; v = 0 }
    pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v
    return v > 0 ? pv / v : null
  })
}

/** Sierra progressive-warmup EMA on `tf`-minute closes, valued at every 1m bar. */
export function emaOnTf(m1: Bar1m[], length: number, tf = 5): number[] {
  const alphaAt = (t: number) => (t < length - 1 ? 2 / (t + 2) : 2 / (length + 1))  // t = 1-indexed bucket position
  let bucket = NaN, n = 0, emaPrev = NaN
  let lastClose = NaN
  return m1.map(b => {
    const k = Math.floor(b.t / (tf * 60))
    if (k !== bucket) {
      if (n > 0) emaPrev = n === 1 ? lastClose : alphaAt(n) * lastClose + (1 - alphaAt(n)) * emaPrev
      bucket = k; n++
    }
    lastClose = b.c
    return n === 1 ? b.c : alphaAt(n) * b.c + (1 - alphaAt(n)) * emaPrev
  })
}
