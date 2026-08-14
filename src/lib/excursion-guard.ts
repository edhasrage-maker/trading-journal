/**
 * Sanity check for a bars-derived excursion (MFE/MAE) before it is stored.
 *
 * A trade's high/low-during-position comes from the shared 1-minute bar feed,
 * which stores ONE series per mini root (NQ, ES). Around a quarterly roll that
 * series has to pick a contract per date, and a trader does not necessarily roll
 * on the same day the market's volume does — measured on real fills, this one
 * sometimes rolls before the crossover and sometimes after. When the pick is
 * wrong the bars are a different contract trading at the carry basis, ~295 NQ
 * points in Dec 2024, and the resulting "excursion" is nonsense: its high/low
 * doesn't even contain the price the trade actually filled at.
 *
 * That is the check. A genuine excursion window spans entry through exit, so it
 * MUST contain both fills. This is per-trade and self-validating, which no
 * per-date contract table can be — so it catches the wrong-contract case at any
 * future roll, for any instrument, without anyone maintaining a calendar.
 *
 * A failed check means store nothing. A missing capture/heat figure reads as
 * "not available yet"; a confidently wrong one silently corrupts the Exit axis
 * of the score and every downstream capture statistic.
 */

/**
 * How far outside the window a fill may sit before the excursion is rejected,
 * in index points.
 *
 * Small misses are expected and harmless: trades are usually micros (MNQ/MES)
 * priced against mini bars, the two track the same index but momentarily differ
 * by around a tick, and 1-minute bars aggregate ticks so a fill on a fast move
 * can land just outside the bar that contains it. Observed on real data, that
 * noise runs to about 5 points. A wrong-contract miss is 100-300. Ten points
 * sits clear of the noise with an order of magnitude of margin below the errors
 * it exists to catch.
 */
export const EXCURSION_TOLERANCE_POINTS = 10

/**
 * True when [low, high] plausibly contains the trade's own fills. Prices that
 * aren't known (null/undefined/non-finite) can't contradict the window, so they
 * pass — this rejects only demonstrable contradictions, never absent data.
 */
export function excursionContainsFills(
  high: number,
  low: number,
  entryPrice: number | null | undefined,
  exitPrice: number | null | undefined,
  tolerance: number = EXCURSION_TOLERANCE_POINTS,
): boolean {
  if (!Number.isFinite(high) || !Number.isFinite(low)) return false
  for (const p of [entryPrice, exitPrice]) {
    const v = Number(p)
    if (p == null || !Number.isFinite(v)) continue
    if (v > high + tolerance) return false
    if (v < low - tolerance) return false
  }
  return true
}

/**
 * Widen [low, high] so it actually contains the trade's own fills.
 *
 * The window spans entry through exit, so both fills are prices the position
 * demonstrably traded at — they belong inside it by definition. Feeds don't
 * always agree: Sierra's high/low-during-position starts recording just after
 * the fill, and a 1-minute bar can miss the exact entry tick, so a stored high
 * can sit a tick BELOW the entry on a long. That is the same sub-tolerance
 * noise `excursionContainsFills` already calls expected and harmless — and the
 * honest way to resolve it is to include the fill, not to keep a range that
 * excludes a price we know traded.
 *
 * Beyond `tolerance` the range is returned UNTOUCHED. A fill 300 points outside
 * its window is the wrong-contract case, not noise; stretching the range to
 * swallow it would manufacture a vast excursion and, worse, hide the
 * contradiction that the downstream integrity guards look for.
 *
 * Pure. Callers keep the raw stored values as provenance and anchor on read.
 */
export function anchorExcursionToFills(
  high: number,
  low: number,
  entryPrice: number | null | undefined,
  exitPrice: number | null | undefined,
  tolerance: number = EXCURSION_TOLERANCE_POINTS,
): { high: number; low: number } {
  if (!Number.isFinite(high) || !Number.isFinite(low)) return { high, low }
  if (!excursionContainsFills(high, low, entryPrice, exitPrice, tolerance)) return { high, low }
  let hi = high, lo = low
  for (const p of [entryPrice, exitPrice]) {
    const v = Number(p)
    if (p == null || !Number.isFinite(v)) continue
    if (v > hi) hi = v
    if (v < lo) lo = v
  }
  return { high: hi, low: lo }
}
