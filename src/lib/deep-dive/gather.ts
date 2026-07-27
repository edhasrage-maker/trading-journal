// The one query behind the deep-dive registry. Kept apart from registry.ts so
// the registry (and every analyzer) stays pure and unit-testable, and so both
// coach trigger paths — the proactive opener and on-ask routing — read exactly
// the same rows.
//
// RLS scopes the select to the signed-in trader; no user_id filter needed.

import type { DiveRow } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

const COLS = 'id, entry_time, direction, entry_price, quantity, pnl, symbol, high_during_position, low_during_position, entry_atr_1m, exits_json'
const PAGE = 1000
/** Deep dives want depth, not recency — streak/session/scale-out stats need the
 *  long book. 12 pages ≈ 12k trades covers the heaviest account here (5.7k). */
const MAX_PAGES = 12

/**
 * Fetch the trade rows the dives read. `startDate`/`endDate` are optional — omit
 * them for the full book, which is what the dives want (a session-clock or
 * scale-out verdict off 90 days is mostly noise).
 */
export async function fetchDiveRows(
  supabase: AnyClient,
  opts: { startDate?: string; endDate?: string } = {},
): Promise<DiveRow[]> {
  const rows: DiveRow[] = []
  for (let p = 0; p < MAX_PAGES; p++) {
    let q = supabase.from('trades').select(COLS).order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    if (opts.startDate) q = q.gte('entry_time', `${opts.startDate}T00:00:00`)
    if (opts.endDate) q = q.lte('entry_time', `${opts.endDate}T23:59:59`)
    const { data, error } = await q
    if (error) break
    const batch = (data ?? []) as DiveRow[]
    rows.push(...batch)
    if (batch.length < PAGE) break
  }
  return rows
}
