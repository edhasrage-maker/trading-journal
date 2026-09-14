/**
 * Session volume profile — shared, client-safe maths.
 *
 * The profile is TICK-TRUE: rows are volume actually traded at each price,
 * summed from Sierra .scid trade records (see scid-volume-profile.ts). It is
 * deliberately NOT approximated from 1-minute bars. Measured on ES 2026-09-14
 * RTH, spreading each minute's volume across its high–low range reproduced the
 * value area to a tick but put the POC at 7,634 against a true 7,625: 7,619
 * contracts printed at one price late in the day, and smearing buried that
 * spike under a broad plateau. The value area survives smearing; the POC does
 * not, and the POC is the level a trader actually uses.
 */

/** One price row. `ask`/`bid` are the aggressor split, carried for a future
 *  delta column — the chart does not draw them yet. */
export interface ProfileRow {
  price: number
  volume: number
  ask: number
  bid: number
}

/** Compact wire/storage form: [price, volume, ask, bid], ascending price. */
export type ProfileRowTuple = [number, number, number, number]

export interface SessionProfile {
  rows: ProfileRow[]
  /** Row height in price units (0.25 for ES/NQ). */
  tick: number
  poc: number
  vah: number
  val: number
  total: number
}

/**
 * The profile's session window, in PT seconds-of-day: 06:30–13:15.
 *
 * 13:15, not the 13:00 the session levels use, and it is not a rounding choice.
 * It is CME's equity-index day session (08:30–15:15 CT), and it is what Sierra
 * uses. Measured on ES 2026-09-14: both windows put the POC at 7,625, but
 * ending at 13:00 the POC beats the next row by 105 contracts (6,161 vs 6,056),
 * while ending at 13:15 it wins 7,619 to 6,056 — and Sierra draws that POC bar
 * clearly longer than every other row. Only the 13:15 window reproduces that.
 */
export const PROFILE_RTH = {
  startSec: 6 * 3600 + 30 * 60,
  endSec: 13 * 3600 + 15 * 60,
} as const

/** Tick size per mini root. Both current roots trade in quarter points. */
export const PROFILE_TICK: Record<string, number> = { ES: 0.25, NQ: 0.25 }

/** Value-area share of total volume. 70% is the market-profile convention and
 *  Sierra's default. */
export const VALUE_AREA_PCT = 0.7

/**
 * POC and value area over ascending-price rows.
 *
 * The value area starts at the POC and grows one row at a time toward whichever
 * neighbouring row carries more volume (the side above wins a tie) until it
 * holds VALUE_AREA_PCT of the session. Returned VAH/VAL are the prices of the
 * outermost rows included — the same convention Sierra reports.
 *
 * Rows must be ascending by price and contiguous in ticks; gaps are fine
 * mathematically but a real session profile has none.
 */
export function valueArea(rows: readonly ProfileRow[], pct = VALUE_AREA_PCT): { poc: number; vah: number; val: number; total: number } | null {
  if (rows.length === 0) return null
  let total = 0
  let pocIdx = 0
  for (let i = 0; i < rows.length; i++) {
    total += rows[i].volume
    if (rows[i].volume > rows[pocIdx].volume) pocIdx = i
  }
  if (total <= 0) return null

  let lo = pocIdx
  let hi = pocIdx
  let acc = rows[pocIdx].volume
  while (acc < total * pct && (lo > 0 || hi < rows.length - 1)) {
    const up = hi < rows.length - 1 ? rows[hi + 1].volume : -1
    const dn = lo > 0 ? rows[lo - 1].volume : -1
    if (up >= dn) { hi++; acc += up } else { lo--; acc += dn }
  }
  return { poc: rows[pocIdx].price, vah: rows[hi].price, val: rows[lo].price, total }
}

export function toTuples(rows: readonly ProfileRow[]): ProfileRowTuple[] {
  return rows.map(r => [r.price, r.volume, r.ask, r.bid])
}

export function fromTuples(rows: readonly ProfileRowTuple[]): ProfileRow[] {
  return rows.map(([price, volume, ask, bid]) => ({ price, volume, ask, bid }))
}
