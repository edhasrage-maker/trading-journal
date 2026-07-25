import { parseSierraChartLog } from './sc-importer'

/**
 * Combine a multi-account Sierra log into ONE set of trades — the trader's
 * portfolio view. Copy-trading / prop-firm setups spread the same decision
 * across several accounts at different sizes; this reconstructs each account's
 * trades (the pure server parser, run in the browser), then merges the ones that
 * are the SAME decision — identical symbol, direction, entry price, and entry
 * second — into a single trade whose quantity and P&L are the totals across
 * accounts. Trades taken on only one account (the majority) pass through as-is.
 *
 * Runs entirely client-side so the 6.6 MB raw log never uploads — only the
 * merged trade rows (a few hundred KB) go to the server, under the request-body
 * limit and with no per-account duplication.
 */

/** Row shape the /api/import-trades-csv `{ trades }` path expects (DB columns). */
export interface CombinedTradeRow {
  sierra_trade_id: string
  symbol: string
  entry_time: string
  entry_price: number
  exit_time: string | null
  exit_price: number | null
  direction: 'long' | 'short'
  quantity: number
  pnl: number | null
  high_during_position: number | null
  low_during_position: number | null
  exits_json: Array<{ time: string; price: number; qty: number }> | null
}

export interface CombineResult {
  trades: CombinedTradeRow[]
  /** Per-account trades before merging (what a raw import would create). */
  sourceTrades: number
  /** Decisions that were spread across >1 account and got merged. */
  merged: number
  accounts: number
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp

export function combineSierraLog(text: string, timezone?: string): CombineResult {
  const { rows } = parseSierraChartLog(text, timezone)
  const accounts = new Set(rows.map(r => r.account))

  // Group by the exact decision: same instrument, side, entry price, entry
  // second. Copies share all four; genuinely distinct trades don't collide.
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.symbol}|${r.direction}|${r.entry_price}|${r.entry_time_iso.slice(0, 19)}`
    const g = groups.get(key)
    if (g) g.push(r); else groups.set(key, [r])
  }

  let merged = 0
  const trades: CombinedTradeRow[] = []
  for (const [key, g] of groups) {
    if (g.length > 1) merged++
    const totalQty = g.reduce((s, r) => s + r.quantity, 0)
    // Size-weighted average prices (identical across copies for entry; may drift
    // slightly on exits from copy lag, so weight by each leg's contracts).
    const wEntry = totalQty > 0 ? g.reduce((s, r) => s + r.entry_price * r.quantity, 0) / totalQty : g[0].entry_price
    const withExit = g.filter(r => r.exit_price != null && r.exit_time_iso)
    const exitQty = withExit.reduce((s, r) => s + r.quantity, 0)
    const wExit = exitQty > 0 ? withExit.reduce((s, r) => s + (r.exit_price as number) * r.quantity, 0) / exitQty : null

    const pnls = g.map(r => r.pnl).filter((p): p is number => p != null)
    const highs = g.map(r => r.high_during_position).filter((h): h is number => h != null)
    const lows = g.map(r => r.low_during_position).filter((l): l is number => l != null)
    const exits = g.flatMap(r => r.exits ?? []).sort((a, b) => a.time.localeCompare(b.time))

    trades.push({
      // Deterministic id from the decision itself → re-imports dedupe cleanly.
      sierra_trade_id: `combined:${key}`,
      symbol: g[0].symbol,
      direction: g[0].direction,
      entry_time: g.reduce((min, r) => (r.entry_time_iso < min ? r.entry_time_iso : min), g[0].entry_time_iso),
      entry_price: round(wEntry),
      exit_time: withExit.length ? withExit.reduce((max, r) => ((r.exit_time_iso as string) > max ? (r.exit_time_iso as string) : max), withExit[0].exit_time_iso as string) : null,
      exit_price: wExit != null ? round(wExit) : null,
      quantity: totalQty,
      pnl: pnls.length ? round(pnls.reduce((s, p) => s + p, 0)) : null,
      high_during_position: highs.length ? round(Math.max(...highs)) : null,
      low_during_position: lows.length ? round(Math.min(...lows)) : null,
      exits_json: exits.length ? exits : null,
    })
  }

  // Chronological, matching a normal import's ordering.
  trades.sort((a, b) => a.entry_time.localeCompare(b.entry_time))
  return { trades, sourceTrades: rows.length, merged, accounts: accounts.size }
}
