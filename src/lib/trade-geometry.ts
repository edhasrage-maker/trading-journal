// Trade level geometry helpers (pure — safe for the client bundle).
//
// The vision extractor reads the two working-order lines off a Sierra Chart
// screenshot but can't always settle the position DIRECTION (footprint-heavy
// shots hide the position tile). When it returns `direction: null`, the
// server-side geometry guard — which validates stop/TP against the MODEL's
// direction — never fires, and the two levels land in a form whose direction
// was set elsewhere (default 'long', or the SC-import ground truth). The
// result is a reversed trade: a long with its stop ABOVE entry and target
// BELOW. Those aren't two bad reads — they're the correct two levels, swapped.

export type TradeDirection = 'long' | 'short'

/** True when `stop` sits on the wrong side of entry for the direction
 *  (a long's stop must be below entry, a short's above). */
export function stopWrongSided(direction: TradeDirection, entry: number, stop: number): boolean {
  return direction === 'long' ? stop >= entry : stop <= entry
}

/** True when `tp1` sits on the wrong side of entry for the direction
 *  (a long's target must be above entry, a short's below). */
export function tp1WrongSided(direction: TradeDirection, entry: number, tp1: number): boolean {
  return direction === 'long' ? tp1 <= entry : tp1 >= entry
}

/**
 * Put stop/TP1 back on the correct side of entry for `direction`.
 *
 * When BOTH levels are wrong-sided they're simply reversed → swap them. A
 * single wrong-sided level is genuinely ambiguous (could be a misread or a
 * mislabeled direction) so it's left untouched for the caller's own guard to
 * null. Missing entry/direction, or fewer than two levels, are returned as-is.
 *
 * Returns the corrected `{ stop, tp1 }`.
 */
export function normalizeTradeLevels(input: {
  direction: TradeDirection | null | undefined
  entry: number | null | undefined
  stop: number | null | undefined
  tp1: number | null | undefined
}): { stop: number | null; tp1: number | null } {
  const { direction, entry } = input
  let stop = input.stop ?? null
  let tp1 = input.tp1 ?? null

  if (
    entry == null ||
    stop == null ||
    tp1 == null ||
    (direction !== 'long' && direction !== 'short')
  ) {
    return { stop, tp1 }
  }

  if (stopWrongSided(direction, entry, stop) && tp1WrongSided(direction, entry, tp1)) {
    ;[stop, tp1] = [tp1, stop]
  }

  return { stop, tp1 }
}
