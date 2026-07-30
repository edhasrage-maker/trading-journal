/**
 * Reconcile a bracket read off a Sierra Chart screenshot — PURE.
 *
 * A working bracket order's label states its projected P&L in POINTS, and that
 * distance is measured from the FILL. So each order gives two facts: a price on
 * the axis, and a distance from entry. Any one of {entry, stop, target} is
 * therefore determined by the other two, and nothing has to be trusted twice.
 *
 * THE AXIS PRICE IS THE FRAGILE HALF. It is small, frequently clipped at the
 * pane edge, and a multi-pane chartbook repeats a near-identical row of order
 * labels per pane. The points figure sits INSIDE the order label, right next to
 * the text the model is already reading, and comes back reliably. Solving from
 * points is therefore strictly better than reading a second price.
 *
 * Two real failures this exists to prevent:
 *
 *  - Sierra's "Trade: Qty@PRICE" readout is the last TAPE PRINT, not the
 *    position. One case read 27859 there when the orders put the fill at 27855
 *    — a 4-point error that silently mis-stated R.
 *
 *  - A short with entry 7415.50 and stop 7419.50 extracted correctly while TP1
 *    came back EMPTY, even though the limit order plainly read "(+12.50p)" at
 *    7403.00 — a value wholly determined by 7415.50 − 12.50.
 *
 * Geometry, for reference (long is the mirror of short):
 *     LONG :  stop  <  entry  <  TP1
 *     SHORT:  TP1   <  entry  <  stop
 */

export interface BracketInput {
  direction?: 'long' | 'short' | null
  entry_price?: number | null
  stop_price?: number | null
  tp1_price?: number | null
  /** Unsigned point distance from the STOP order's label. */
  stop_points?: number | null
  /** Unsigned point distance from the TARGET order's label. */
  tp1_points?: number | null
}

export interface BracketResult {
  entry_price: number | null
  stop_price: number | null
  tp1_price: number | null
  /** Which fields this function computed rather than accepted, for logging. */
  solved: ('entry' | 'stop' | 'tp1')[]
}

/** Positive finite number, or null. Distances are unsigned by convention. */
function dist(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.abs(v) : null
}
function price(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}
const round2 = (n: number): number => Math.round(n * 100) / 100

/** Half a point — inside one ES/NQ tick pair, so it tolerates rounding without
 *  tolerating a genuine misread. */
const TOL = 0.5

export function solveBracket(input: BracketInput): BracketResult {
  const dir = input.direction
  const solved: BracketResult['solved'] = []

  let entry = price(input.entry_price)
  let stop = price(input.stop_price)
  let tp1 = price(input.tp1_price)
  const spd = dist(input.stop_points)
  const tpd = dist(input.tp1_points)

  if (dir !== 'long' && dir !== 'short') {
    return { entry_price: entry, stop_price: stop, tp1_price: tp1, solved }
  }
  const isLong = dir === 'long'

  // ---- 1. Entry, from either bracket leg. ---------------------------------
  // Long: stop sits BELOW entry and target ABOVE, so entry = stop + d and
  // entry = target − d. Short is the mirror.
  const cands: number[] = []
  if (stop != null && spd != null) cands.push(isLong ? stop + spd : stop - spd)
  if (tp1 != null && tpd != null) cands.push(isLong ? tp1 - tpd : tp1 + tpd)

  // Two independent answers must AGREE before either is trusted. Disagreement
  // means one of the four inputs was misread and there is no way to tell which,
  // so the honest move is to keep whatever the model reported.
  const derivedEntry = cands.length === 0
    ? null
    : (cands.length === 2 && Math.abs(cands[0] - cands[1]) > TOL ? null : cands[0])

  if (derivedEntry != null) {
    // Arithmetic off two labels beats a single reading, so it wins on conflict.
    if (entry == null || Math.abs(entry - derivedEntry) > TOL) {
      entry = round2(derivedEntry)
      solved.push('entry')
    }
  }

  // ---- 2. Complete the bracket back from entry. ---------------------------
  // This is the half that was missing: a leg whose axis price never got read is
  // still fully determined once entry and that leg's own distance are known.
  if (entry != null) {
    if (stop == null && spd != null) {
      stop = round2(isLong ? entry - spd : entry + spd)
      solved.push('stop')
    }
    if (tp1 == null && tpd != null) {
      tp1 = round2(isLong ? entry + tpd : entry - tpd)
      solved.push('tp1')
    }
  }

  return { entry_price: entry, stop_price: stop, tp1_price: tp1, solved }
}
