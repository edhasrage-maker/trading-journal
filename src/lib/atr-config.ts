/**
 * Configurable ATR — computes Average True Range from 1-minute bars for a
 * user-chosen timeframe, smoothing method, and period. The stored `entry_atr_1m`
 * remains a fixed 1m-Wilder-10 baseline; this powers the user's *chosen* ATR that
 * drives the ATR@ column and the ATR-unit R fallback.
 *
 * Look-ahead safe: like liveAtr(), only bars strictly BEFORE the target time are
 * used, so the not-yet-complete entry bar never leaks in.
 *
 * With { timeframe: 1, method: 'wilder', period: 10 } this reproduces liveAtr()
 * exactly, so the default matches the trader's Sierra 1m ATR-10.
 */
import type { AtrBar } from './atr'

export type AtrMethod = 'wilder' | 'sma' | 'ema'

export interface AtrConfig {
  timeframe: number // minutes: one of ATR_TIMEFRAMES
  method: AtrMethod
  period: number
}

export const ATR_TIMEFRAMES = [1, 2, 3, 5, 15, 30, 60] as const
export const ATR_METHODS: AtrMethod[] = ['wilder', 'sma', 'ema']
export const ATR_METHOD_LABELS: Record<AtrMethod, string> = {
  wilder: "Wilder's (RMA)",
  sma: 'Simple (SMA)',
  ema: 'Exponential (EMA)',
}
export const DEFAULT_ATR_CONFIG: AtrConfig = { timeframe: 1, method: 'wilder', period: 10 }

/** Coerce arbitrary stored/user values into a valid AtrConfig (defaults on junk). */
export function normalizeAtrConfig(raw: Partial<AtrConfig> | null | undefined): AtrConfig {
  const tf = Number(raw?.timeframe)
  const period = Number(raw?.period)
  return {
    timeframe: (ATR_TIMEFRAMES as readonly number[]).includes(tf) ? tf : DEFAULT_ATR_CONFIG.timeframe,
    method: ATR_METHODS.includes(raw?.method as AtrMethod) ? (raw!.method as AtrMethod) : DEFAULT_ATR_CONFIG.method,
    period: Number.isFinite(period) && period >= 2 && period <= 200 ? Math.round(period) : DEFAULT_ATR_CONFIG.period,
  }
}

/** Aggregate 1-minute bars into `tfMins` OHLC buckets (epoch-clock-aligned).
 *  Only high/low/close are needed for ATR, so open is dropped. */
function aggregate(bars: AtrBar[], tfMins: number): AtrBar[] {
  if (tfMins <= 1) return bars
  const bucketMs = tfMins * 60_000
  const out: AtrBar[] = []
  let cur: (AtrBar & { bucket: number }) | null = null
  for (const b of bars) {
    const bucket = Math.floor(new Date(b.ts).getTime() / bucketMs) * bucketMs
    if (!cur || cur.bucket !== bucket) {
      if (cur) out.push({ ts: cur.ts, high: cur.high, low: cur.low, close: cur.close })
      cur = { ts: new Date(bucket).toISOString(), high: b.high, low: b.low, close: b.close, bucket }
    } else {
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.close = b.close
    }
  }
  if (cur) out.push({ ts: cur.ts, high: cur.high, low: cur.low, close: cur.close })
  return out
}

function trueRanges(bars: AtrBar[]): number[] {
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const prevClose = bars[i - 1].close
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)))
  }
  return trs
}

/**
 * ATR at `at` for the given config, from 1-minute `bars`. Returns null when there
 * aren't enough preceding (aggregated) bars to seed the smoothing.
 */
export function configuredAtr(bars: AtrBar[], at: Date, cfg: AtrConfig): number | null {
  const { timeframe, method } = cfg
  const period = Math.max(2, Math.round(cfg.period))
  const tfBars = aggregate(bars, Math.max(1, timeframe))
  const targetMs = at.getTime()
  const usable = tfBars.filter(b => new Date(b.ts).getTime() < targetMs)
  if (usable.length < period + 1) return null
  const trs = trueRanges(usable)
  if (trs.length < period) return null

  if (method === 'sma') {
    // Trailing simple mean of the last `period` true ranges.
    let s = 0
    for (let i = trs.length - period; i < trs.length; i++) s += trs[i]
    return s / period
  }

  // Wilder + EMA both seed with the SMA of the first `period` TRs, then smooth.
  let atr = 0
  for (let i = 0; i < period; i++) atr += trs[i]
  atr /= period
  if (method === 'ema') {
    const alpha = 2 / (period + 1)
    for (let i = period; i < trs.length; i++) atr = alpha * trs[i] + (1 - alpha) * atr
  } else {
    // Wilder (RMA) smoothing — matches liveAtr().
    for (let i = period; i < trs.length; i++) atr = ((period - 1) * atr + trs[i]) / period
  }
  return atr
}
