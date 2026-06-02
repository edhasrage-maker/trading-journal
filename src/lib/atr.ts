/**
 * Average True Range (Wilder smoothed) computation for 1-minute bars.
 *
 * Used to compute the live ATR-10 at the moment a trade was entered, which
 * is more accurate for execution-quality analytics than the prep-time ATR
 * the trader enters manually each morning (that value can be stale by a
 * couple hours by the time a trade actually fires).
 *
 * Formula:
 *   TR_i  = max(high_i − low_i, |high_i − close_{i−1}|, |low_i − close_{i−1}|)
 *   ATR_1..n = SMA(TR_1..n)              (seed for first `period` bars)
 *   ATR_n = ((period − 1) × ATR_{n−1} + TR_n) / period   (Wilder smoothing)
 */

export interface AtrBar {
  ts: string             // ISO timestamp
  high: number
  low: number
  close: number
}

/**
 * Paginate ohlcv_bars in chunks of 1000 (the Supabase row cap), accumulating
 * all matching bars for a (symbol, date) pair. Returns bars sorted ascending
 * by ts. Without this, days where the RTH session's bars push the result past
 * 1000 rows would silently truncate, leaving late-afternoon trades with
 * either null ATR or worse, an ATR computed from a partial bar set.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllBars(supabase: any, symbol: string, dateYmd: string): Promise<AtrBar[]> {
  const PAGE = 1000
  const start = `${dateYmd}T00:00:00Z`
  // Two-day end so late-PT trades on the journal date (which can be early
  // next-day UTC) still have their full preceding-bar window.
  const endDate = new Date(`${dateYmd}T00:00:00Z`)
  endDate.setUTCDate(endDate.getUTCDate() + 1)
  const end = endDate.toISOString().slice(0, 10) + 'T23:59:59Z'
  const out: AtrBar[] = []
  for (let p = 0; p < 10; p++) {
    const { data } = await supabase
      .from('ohlcv_bars')
      .select('ts, high, low, close')
      .eq('symbol', symbol)
      .gte('ts', start)
      .lte('ts', end)
      .order('ts', { ascending: true })
      .range(p * PAGE, p * PAGE + PAGE - 1)
    const batch = (data ?? []) as AtrBar[]
    out.push(...batch)
    if (batch.length < PAGE) break
  }
  return out
}

/**
 * Compute ATR-`period` Wilder at the timestamp `at`. Uses bars strictly
 * BEFORE `at` to avoid look-ahead bias (the trader couldn't see the
 * not-yet-completed bar of their entry minute).
 *
 * Returns null when there aren't enough preceding bars to seed Wilder
 * (need at least `period + 1` bars so the first TR exists and `period` TRs
 * can be averaged for the seed).
 *
 * For the trading-journal use case, period=10 matches the 1-min ATR-10
 * the trader uses in Sierra Chart.
 */
export function liveAtr(bars: AtrBar[], at: Date, period = 10): number | null {
  const targetMs = at.getTime()
  const usable = bars.filter(b => new Date(b.ts).getTime() < targetMs)
  if (usable.length < period + 1) return null

  const trs: number[] = []
  for (let i = 1; i < usable.length; i++) {
    const b = usable[i]
    const prevClose = usable[i - 1].close
    const tr = Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    )
    trs.push(tr)
  }
  if (trs.length < period) return null

  // Seed: simple mean of the first `period` true ranges.
  let atr = 0
  for (let i = 0; i < period; i++) atr += trs[i]
  atr /= period

  // Wilder smooth over the remaining TRs.
  for (let i = period; i < trs.length; i++) {
    atr = ((period - 1) * atr + trs[i]) / period
  }
  return atr
}
