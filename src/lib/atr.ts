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

// ────────────────────────────────────────────────────────────────────────────
// Post-Exit Continuation
//
// What did the move do AFTER you closed? Computed per-trade from 1-min bars
// in a window starting at exit_time. Answers questions like:
//   - "I cut at +1R — did it go to +3R after I was out?"
//   - "I bailed early at -0.5R — did it stop me out, or recover?"
//
// Window default: 30 minutes. Public/future version may make this
// configurable (see docs/PUBLIC_VERSION.md).
// ────────────────────────────────────────────────────────────────────────────

export interface PostExitData {
  /** How much further the market continued in the trade's direction after exit (>= 0, in price points per contract). */
  continued_favorable_pts: number
  /** How much the market reversed against the trade direction after exit (>= 0). */
  continued_against_pts: number
  /** True when the window covered the full post-exit minutes; false when bars ran out (recent trade or end-of-day). */
  full_window: boolean
}

interface PostExitTrade {
  direction: 'long' | 'short' | null
  exit_price: number | null
  exit_time: string | null
}

/**
 * Compute post-exit continuation over `windowMinutes` after `trade.exit_time`.
 * Returns null when the trade is missing exit data or no post-exit bars exist.
 */
export function postExitExtension(
  bars: AtrBar[],
  trade: PostExitTrade,
  windowMinutes = 30,
): PostExitData | null {
  if (!trade.direction || trade.exit_price == null || !trade.exit_time) return null
  const exitMs = new Date(trade.exit_time).getTime()
  const endMs = exitMs + windowMinutes * 60_000
  const windowBars = bars.filter(b => {
    const t = new Date(b.ts).getTime()
    return t > exitMs && t <= endMs
  })
  if (windowBars.length === 0) return null
  let maxHigh = -Infinity
  let minLow = Infinity
  for (const b of windowBars) {
    if (b.high > maxHigh) maxHigh = b.high
    if (b.low < minLow) minLow = b.low
  }
  const isLong = trade.direction === 'long'
  const continued_favorable_pts = isLong
    ? Math.max(0, maxHigh - trade.exit_price)
    : Math.max(0, trade.exit_price - minLow)
  const continued_against_pts = isLong
    ? Math.max(0, trade.exit_price - minLow)
    : Math.max(0, maxHigh - trade.exit_price)
  const lastBarMs = new Date(windowBars[windowBars.length - 1].ts).getTime()
  const full_window = lastBarMs >= endMs - 60_000
  return { continued_favorable_pts, continued_against_pts, full_window }
}
