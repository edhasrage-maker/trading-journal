import type { ChartCalibration } from '@/lib/supabase/types'

/**
 * Convert a price to a y_pct (0-100) using two price anchors on the chart screenshot.
 * Returns null if the calibration is degenerate (anchor prices equal).
 *
 * Note: a chart's HIGH price is at a *lower* y_pct (top of image). The formula
 * handles that automatically because (y_low - y_high) is positive on a normal chart.
 */
export function priceToYPct(price: number, c: ChartCalibration): number | null {
  const dp = c.low.price - c.high.price
  if (dp === 0) return null
  return c.high.y_pct + ((price - c.high.price) * (c.low.y_pct - c.high.y_pct)) / dp
}

/**
 * Convert an ISO timestamp to an x_pct (0-100) using two time anchors.
 * The trade timestamp is interpreted in the browser's local timezone so the
 * time-of-day mapping is consistent with the chart's HH:MM anchors.
 *
 * Returns null if the calibration is degenerate (anchor times equal) or the
 * timestamp can't be parsed.
 */
export function timeToXPct(timeIso: string, c: ChartCalibration): number | null {
  const startMin = parseHHMM(c.start.time)
  const endMin = parseHHMM(c.end.time)
  if (startMin == null || endMin == null) return null
  const dt = endMin - startMin
  if (dt === 0) return null

  const tradeMin = isoToLocalMinutes(timeIso)
  if (tradeMin == null) return null

  return c.start.x_pct + ((tradeMin - startMin) * (c.end.x_pct - c.start.x_pct)) / dt
}

/**
 * Combine price + time conversion for a trade's ENTRY. Returns null if either
 * axis is degenerate or the trade lacks the required fields.
 */
export function tradeToPixelPct(
  trade: { entry_time?: string | null; entry_price?: number | null },
  calibration: ChartCalibration,
): { x_pct: number; y_pct: number } | null {
  if (trade.entry_time == null || trade.entry_price == null) return null
  const x = timeToXPct(trade.entry_time, calibration)
  const y = priceToYPct(trade.entry_price, calibration)
  if (x == null || y == null) return null
  return { x_pct: x, y_pct: y }
}

/**
 * Pixel position for a trade's EXIT. Same math as the entry counterpart but
 * reads exit_time / exit_price. Returns null for open trades or trades that
 * never recorded an exit (e.g., manually-entered ones the trader didn't fill
 * out).
 */
export function tradeExitToPixelPct(
  trade: { exit_time?: string | null; exit_price?: number | null },
  calibration: ChartCalibration,
): { x_pct: number; y_pct: number } | null {
  if (trade.exit_time == null || trade.exit_price == null) return null
  const x = timeToXPct(trade.exit_time, calibration)
  const y = priceToYPct(trade.exit_price, calibration)
  if (x == null || y == null) return null
  return { x_pct: x, y_pct: y }
}

/** Parse an "HH:MM" string into minutes since midnight. */
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/**
 * Take an ISO timestamp and return its minutes-since-midnight in the local
 * timezone. We use Date object arithmetic so DST is handled correctly.
 */
function isoToLocalMinutes(iso: string): number | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}
