// Collapse exits_json FILL FRAGMENTS into real exit EVENTS.
//
// Why this exists: a broker fills one exit order in several pieces, and the
// importer stores each piece as its own leg. A live prod row looked like this —
// four "legs", one market exit:
//   [{qty:3,t:17:12:02.872,p:25005.25},{qty:7,t:17:12:02.872,p:25005},
//    {qty:9,t:17:12:02.872,p:25004.75},{qty:1,t:17:12:02.872,p:25004.5}]
// and another had 8 legs that were really TWO scale-outs (three fills at
// 15:35:16, five at 15:42:28). Any "is scaling out +EV?" math done on raw legs
// therefore compares fill fragments to each other and measures nothing.
//
// One event = the fills that landed within `toleranceMs` of the event's FIRST
// fill, at a qty-weighted average price. PURE.

export interface ExitFill {
  /** ISO-8601 fill timestamp. */
  time: string
  price: number
  qty: number
}

export interface ExitEvent {
  /** Timestamp of the event's first fill (ms epoch). */
  ms: number
  /** ISO time of the event's first fill. */
  time: string
  /** Qty-weighted average fill price for the event. */
  price: number
  /** Total contracts taken off in this event. */
  qty: number
  /** How many raw fills were merged (1 = a clean single fill). */
  fills: number
}

/** Fills this close together are one order being filled in pieces, not a
 *  decision to scale. 2s is generous for a market order on a fast tape and
 *  still far below any real "let some ride" interval. */
export const FILL_MERGE_TOLERANCE_MS = 2000

/**
 * Group fills into exit events. Fills with an unparseable time or a
 * non-positive qty are dropped. Returns events ordered by time.
 */
export function groupExitEvents(
  fills: readonly ExitFill[] | null | undefined,
  toleranceMs = FILL_MERGE_TOLERANCE_MS,
): ExitEvent[] {
  if (!Array.isArray(fills) || fills.length === 0) return []
  const clean = fills
    .filter(f => f && Number.isFinite(f.price) && Number.isFinite(f.qty) && f.qty > 0)
    .map(f => ({ ...f, ms: Date.parse(f.time) }))
    .filter(f => Number.isFinite(f.ms))
    .sort((a, b) => a.ms - b.ms)
  if (!clean.length) return []

  const events: ExitEvent[] = []
  // Accumulate price × qty so the event price is qty-weighted, not a naive mean:
  // a 9-lot fill must dominate a 1-lot fill.
  let cur = { ms: clean[0].ms, time: clean[0].time, notional: 0, qty: 0, fills: 0 }
  const flush = () => {
    if (cur.qty > 0) events.push({ ms: cur.ms, time: cur.time, price: cur.notional / cur.qty, qty: cur.qty, fills: cur.fills })
  }
  for (const f of clean) {
    // Compare against the event's START, not the previous fill, so a long chain
    // of 1.9s-apart fills can't creep into one event.
    if (f.ms - cur.ms > toleranceMs) {
      flush()
      cur = { ms: f.ms, time: f.time, notional: 0, qty: 0, fills: 0 }
    }
    cur.notional += f.price * f.qty
    cur.qty += f.qty
    cur.fills++
  }
  flush()
  return events
}
