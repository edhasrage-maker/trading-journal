import { symbolToMultiplier } from './futures-symbols.ts'

/**
 * MFE on the AVAILABLE position — the one definition of "how much the market
 * offered you" for a trade that was scaled out (founder, 2026-10-14):
 *
 *   each contract is measured only while it was still on.
 *
 * Contracts taken off at TP1 are graded on their own window, from the entry to
 * their own fill; the runner on the rest of the move. A 3-lot short that takes
 * 2 off at TP1 and lets 1 run to full target kept 100% of what it was offered —
 * not 65% of "all three contracts held to the low", which no plan with a TP1
 * could ever have banked.
 *
 * Per exit EVENT (fills ≤ 2 s apart are one decision — exits_json legs arrive
 * as fill fragments):
 *
 *   the last exit      → the position's own best price (high/low_during_position,
 *                        tick-precise; the runner was on for the whole trade)
 *   every earlier exit → the best of its own fill and the 1-minute bars that
 *                        CLOSED while it was on (a bar that opens before the entry
 *                        or closes after the fill also holds prices from when the
 *                        contract wasn't there, so it is left out). Without bars:
 *                        its own fill — a resting target fills the moment price
 *                        reaches it — or, for a contract that came off at a loss,
 *                        the position's best (it was on through the peak).
 *
 *   every contract is capped at the position's best price and floored at 0.
 *
 * The result is returned as POINTS PER CONTRACT (Σ qty × excursion ÷ Σ qty), so
 * it drops into the same pts / $ / ×ATR arithmetic as everything else: dollars
 * = pts × contracts × multiplier. A trade with one exit gets the position's best
 * price unchanged — scaling is the only thing this moves.
 *
 * Stored per trade as `trades.mfe_dollars_per_leg` (the bar-refined dollars,
 * written at import and by scripts/backfill-available-mfe.ts); readers without
 * bars use that value when present, and the fill-only rule otherwise.
 */

export interface ExitFill { time: string; price: number; qty: number }
export interface MinuteBar { ts: string; high: number; low: number }

/** Fills within this many ms of each other are one exit decision. */
const SAME_EXIT_MS = 2000

/** exits_json → exit events, oldest first: fragments of one order merged
 *  (quantity-weighted price, time of the last fragment). */
export function exitEvents(raw: unknown): ExitFill[] {
  if (!Array.isArray(raw)) return []
  const legs = raw
    .map(l => ({ time: String(l?.time ?? ''), price: Number(l?.price), qty: Number(l?.qty) }))
    .filter(l => l.time && Number.isFinite(l.price) && Number.isFinite(l.qty) && l.qty > 0 && Number.isFinite(Date.parse(l.time)))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  const out: ExitFill[] = []
  for (const l of legs) {
    const last = out[out.length - 1]
    if (last && Date.parse(l.time) - Date.parse(last.time) <= SAME_EXIT_MS) {
      last.price = (last.price * last.qty + l.price * l.qty) / (last.qty + l.qty)
      last.qty += l.qty
      last.time = l.time
    } else {
      out.push({ ...l })
    }
  }
  return out
}

export interface AvailableInput {
  direction: 'long' | 'short' | string | null
  entry_price: number | null
  entry_time?: string | null
  exits_json?: unknown
}

/**
 * Favorable excursion per contract on the available position, in points.
 * `positionPts` = the position's best favorable move (from the anchored
 * high/low during the position, e.g. analytics.mfeMaePoints().mfe).
 * `scaled` is false when the trade had one exit — then pts === positionPts.
 */
export function availableMfePts(
  t: AvailableInput,
  positionPts: number,
  bars?: MinuteBar[] | null,
): { pts: number; scaled: boolean } {
  const best = Math.max(0, positionPts)
  const events = exitEvents(t.exits_json)
  if (events.length < 2 || t.entry_price == null || (t.direction !== 'long' && t.direction !== 'short')) {
    return { pts: best, scaled: false }
  }
  const isLong = t.direction === 'long'
  const entry = t.entry_price
  const entryMs = t.entry_time ? Date.parse(t.entry_time) : NaN
  const fav = (price: number) => (isLong ? price - entry : entry - price)

  let weighted = 0, contracts = 0
  events.forEach((e, i) => {
    let exc: number
    if (i === events.length - 1) {
      exc = best
    } else {
      const fill = fav(e.price)
      let seen = fill
      let barSeen = false
      if (bars && bars.length > 0 && Number.isFinite(entryMs)) {
        const exitMs = Date.parse(e.time)
        for (const b of bars) {
          const open = Date.parse(b.ts)
          if (!(open >= entryMs)) continue
          if (open + 60_000 > exitMs) break
          barSeen = true
          const v = fav(isLong ? b.high : b.low)
          if (v > seen) seen = v
        }
      }
      // No bar inside the window: the fill is the only evidence — unless the
      // contract came off at a loss, which means it sat through the peak.
      exc = barSeen ? seen : fill > 0 ? fill : best
    }
    weighted += Math.min(Math.max(exc, 0), best) * e.qty
    contracts += e.qty
  })
  return { pts: contracts > 0 ? weighted / contracts : best, scaled: true }
}

/** Contracts traded according to the exit fills (0 when there are none). */
export function exitContracts(raw: unknown): number {
  return exitEvents(raw).reduce((s, e) => s + e.qty, 0)
}

/**
 * Available-position MFE in DOLLARS for the store (`mfe_dollars_per_leg`), or
 * null for a trade with one exit (nothing to store — the position's best price
 * already is the answer) or an unknown instrument.
 */
export function availableMfeDollars(
  t: AvailableInput & { symbol: string | null; quantity?: number | null },
  positionPts: number,
  bars?: MinuteBar[] | null,
): number | null {
  const mult = symbolToMultiplier(t.symbol ?? '')
  if (!(mult > 0)) return null
  const { pts, scaled } = availableMfePts(t, positionPts, bars)
  if (!scaled) return null
  const qty = exitContracts(t.exits_json) || t.quantity || 0
  return qty > 0 ? pts * qty * mult : null
}

/**
 * Read side: points per contract for a trade, preferring the stored bar-refined
 * value (`mfe_dollars_per_leg`) on a scaled trade and the fill-only rule
 * otherwise. Capped at the position's best and never below 0.
 */
export function availableMfePtsStored(
  t: AvailableInput & { symbol: string | null; quantity?: number | null; mfe_dollars_per_leg?: number | null },
  positionPts: number,
): number {
  const best = Math.max(0, positionPts)
  const computed = availableMfePts(t, best)
  if (!computed.scaled) return best
  const stored = t.mfe_dollars_per_leg
  const mult = symbolToMultiplier(t.symbol ?? '')
  const qty = exitContracts(t.exits_json) || t.quantity || 0
  if (stored != null && stored > 0 && mult > 0 && qty > 0) {
    return Math.min(stored / (qty * mult), best)
  }
  return computed.pts
}
