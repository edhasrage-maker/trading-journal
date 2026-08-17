// Per-instrument market_context selection.
//
// A trading day holds ONE market_context row PER INSTRUMENT — the table is
// unique on (trading_day_id, symbol) and the writer stamps symbol =
// chartSeriesRoot(...) ('NQ' / 'ES' / …). So a day the trader touched in both
// ES and NQ carries two rows with wildly different scales (ES day_range ~20pts,
// NQ ~130pts; ES atr_1m ~2, NQ ~10).
//
// Every read that wants "the day's context" must therefore pick the row that
// matches what was actually TRADED that day. The old readers used
// `.order('symbol').limit(1)`, which picks 'ES' alphabetically before 'NQ' — so
// an NQ day silently read ES numbers (the bug behind a Game Winner claiming
// "127% of the day's range": an NQ capture measured against the ES range).

import { chartSeriesRoot } from '@/lib/futures-symbols'

/**
 * The instrument series root the day was mostly traded in (by trade count),
 * e.g. 'NQ' / 'ES'. Null when no trade carries a symbol. Applies the SAME
 * chartSeriesRoot() the writer stamps on market_context.symbol, so the result
 * lines up with the per-instrument context rows.
 */
export function dominantInstrument(trades: { symbol?: string | null }[]): string | null {
  const counts = new Map<string, number>()
  for (const t of trades) {
    if (!t.symbol) continue
    const root = chartSeriesRoot(t.symbol)
    counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  for (const [root, n] of counts) {
    if (n > bestN) {
      best = root
      bestN = n
    }
  }
  return best
}

/**
 * From a day's market_context rows (one per instrument), pick the one matching
 * the day's dominant traded instrument. Falls back to the sole row when there's
 * only one, then to the first row when nothing matches (e.g. context saved for a
 * symbol the day didn't end up trading), then null. Safe on 0/1-row days — the
 * common case — so callers can drop `.limit(1)` and select every row.
 */
export function pickMarketContext<T extends { symbol?: string | null }>(
  rows: T[] | null | undefined,
  trades: { symbol?: string | null }[],
): T | null {
  const list = rows ?? []
  if (list.length <= 1) return list[0] ?? null
  const dom = dominantInstrument(trades)
  if (dom) {
    const match = list.find(r => (r.symbol ?? '').toUpperCase() === dom.toUpperCase())
    if (match) return match
  }
  return list[0] ?? null
}
