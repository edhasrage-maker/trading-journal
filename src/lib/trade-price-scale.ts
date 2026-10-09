import type { Trade } from '@/lib/supabase/types'

/**
 * Off-scale price check for the trade form.
 *
 * An entry, stop or target typed onto a trade can come from the wrong chart:
 * 2026-10-08 an MES copy trade was saved with the MNQ chart's levels (entry
 * 31,230 against its own MES exit of 7,821.75) and its MAE came out at
 * 9,216×ATR. The form asks once before saving a price like that.
 */

/** A typed price more than this share away from the trade's own fills is on a
 *  different scale (NQ vs ES ≈ 4×). No intraday entry, stop or target sits 5%
 *  from where the same position traded. */
const OFF_SCALE_PCT = 0.05

/**
 * Entry / stop / target values that cannot belong to this trade, judged against
 * the prices it actually traded at (exit, else the middle of its high/low).
 * Only for a saved trade with fills — a new manual trade has nothing to compare
 * against. Returns the warning to show, or null when everything is in scale.
 */
export function offScalePrices(
  trade: Pick<Trade, 'exit_price' | 'high_during_position' | 'low_during_position' | 'symbol'> | null | undefined,
  form: { entry_price: string; stop_price: string; tp1_price: string },
): { message: string; signature: string } | null {
  if (!trade) return null
  const ref = trade.exit_price ?? (
    trade.high_during_position != null && trade.low_during_position != null
      ? (trade.high_during_position + trade.low_during_position) / 2
      : null
  )
  if (ref == null || !(ref > 0)) return null
  const fields: Array<[string, string]> = [['Entry', form.entry_price], ['Stop', form.stop_price], ['Target', form.tp1_price]]
  const bad = fields
    .map(([label, raw]) => [label, parseFloat(raw)] as const)
    .filter(([, v]) => Number.isFinite(v) && Math.abs(v - ref) / ref > OFF_SCALE_PCT)
  if (bad.length === 0) return null
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const list = bad.map(([label, v]) => `${label} ${fmt(v)}`).join(', ')
  return {
    signature: bad.map(([label, v]) => `${label}:${v}`).join('|'),
    message: `${list} ${bad.length === 1 ? 'is' : 'are'} nowhere near this trade's own fills ` +
      `(${trade.exit_price != null ? 'exit' : 'traded around'} ${fmt(ref)}${trade.symbol ? `, ${trade.symbol}` : ''}) — ` +
      `that looks like another instrument's price. Fix it, or press Save again to keep it.`,
  }
}
