/**
 * NinjaTrader "Executions" grid importer.
 *
 * The user exports the Executions/Trades grid to CSV. Unlike a Tradezella
 * "Trade Performance" export (one row per completed trade), this is FILL-level:
 * each row is a single execution (Entry or Exit leg). So — exactly like the
 * Sierra Chart log — we reconstruct round-trip trades by walking fills and
 * tracking position 0 → non-zero → 0.
 *
 * Header (comma-separated):
 *   Instrument, Action, Quantity, Price, Time, ID, E/X, Position, Order ID,
 *   Name, Commission, Rate, Account, Connection
 *
 * What the grid DOES give us: side, qty, price, time, exec id, commission —
 * enough to reconstruct entry/exit prices & times and COMPUTE P&L (the grid has
 * no P&L column). What it does NOT give us: MAE/MFE (no high/low during
 * position). Those are backfilled from the central `ohlcv_bars` feed in the
 * import route — the trade log is not the source of excursion data.
 *
 * Times are NAIVE wall-clock in the exporter's local zone (NinjaTrader's grid
 * has no timezone marker); the caller passes the browser IANA zone so a hosted
 * (UTC) server still lands them in the trader's clock — same handling as SC.
 */

import { naiveToUtc, type ParsedSCRow, type ParseOutcome } from './sc-importer'
import { symbolRoot, symbolToMultiplier } from './futures-symbols'

/** Normalize a header cell: lowercase, strip non-alphanumerics. "E/X" → "ex". */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Minimal CSV line splitter (handles quoted fields with commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map(s => s.trim())
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * A NinjaTrader executions grid is comma-separated and carries the `Action`
 * (Buy/Sell) + `E/X` (Entry/Exit) + `ID` columns alongside `Instrument`. That
 * combination is what distinguishes it from a Tradezella/Tradovate trade CSV
 * (which is one row per completed trade and has no per-fill E/X column).
 */
export function isNinjaTraderGrid(text: string): boolean {
  const nl = text.indexOf('\n')
  const first = (nl === -1 ? text : text.slice(0, nl))
  if (first.includes('\t')) return false // tab-delimited → Sierra log, not NT grid
  const cols = new Set(splitCsvLine(first).map(normKey))
  return cols.has('instrument') && cols.has('action') && cols.has('ex') && cols.has('id')
}

/** "NQ SEP26" → "NQ" (root symbol, before the contract-month token). Falls back
 *  to symbolRoot for dotted forms like "MNQU6.CME". */
function ntSymbolRoot(instrument: string): string {
  const token = instrument.trim().split(/\s+/)[0] || instrument.trim()
  return symbolRoot(token)
}

/** Parse "7/2/2026 7:29:46 AM" (M/D/YYYY h:mm:ss AM/PM) as naive local, → UTC. */
function parseNtTime(raw: string, tz?: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*([AaPp][Mm])$/.exec(raw.trim())
  if (!m) return null
  const [, mo, d, y, hRaw, mi, s, frac, ap] = m
  let h = Number(hRaw) % 12
  if (/p/i.test(ap)) h += 12
  const ms = frac ? Math.floor(Number(`0.${frac.padEnd(3, '0').slice(0, 3)}`) * 1000) : 0
  const dt = naiveToUtc(Number(y), Number(mo), Number(d), h, Number(mi), Number(s), ms, tz)
  return Number.isNaN(dt.getTime()) ? null : dt
}

interface Fill {
  ts: Date
  symbol: string          // root, e.g. "NQ"
  account: string
  qty: number
  side: 'Buy' | 'Sell'
  price: number
  id: string
  commission: number
  rowIndex: number
}

interface OpenGroup {
  account: string
  symbol: string
  direction: 'long' | 'short'
  fills: Fill[]
  firstId: string
  pos: number
}

/**
 * Parse a NinjaTrader executions grid into reconstructed round-trip trades.
 * Returns the same ParsedSCRow shape the Sierra importer emits, so the import
 * route maps both through one code path. `high/low_during_position` come back
 * null (the grid has no excursion data) — the route fills them from bars.
 */
export function parseNinjaTraderGrid(text: string, tz?: string): ParseOutcome {
  const parseErrors: string[] = []
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) return { rows: [], parseErrors: ['Empty or header-only file.'], skippedFiltered: 0 }

  const header = splitCsvLine(lines[0]).map(normKey)
  const col: Record<string, number> = {}
  const want: Record<string, string[]> = {
    instrument: ['instrument'], action: ['action'], quantity: ['quantity', 'qty'],
    price: ['price'], time: ['time'], id: ['id'], commission: ['commission'],
    account: ['account'],
  }
  for (const [field, aliases] of Object.entries(want)) {
    const idx = header.findIndex(h => aliases.includes(h))
    if (idx >= 0) col[field] = idx
  }
  const get = (cells: string[], f: string): string | undefined =>
    col[f] != null ? cells[col[f]] : undefined

  const fills: Fill[] = []
  let skippedZeroQty = 0

  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r])
    const rowNumber = r + 1

    const actionRaw = (get(cells, 'action') ?? '').trim()
    const side: 'Buy' | 'Sell' | null =
      /buy/i.test(actionRaw) ? 'Buy' : /sell/i.test(actionRaw) ? 'Sell' : null
    if (!side) { parseErrors.push(`Row ${rowNumber}: unrecognized Action "${actionRaw}"`); continue }

    const qty = Number((get(cells, 'quantity') ?? '').replace(/[,]/g, ''))
    if (!Number.isFinite(qty) || qty <= 0) { skippedZeroQty++; continue }

    const price = Number((get(cells, 'price') ?? '').replace(/[$,]/g, ''))
    if (!Number.isFinite(price)) { parseErrors.push(`Row ${rowNumber}: invalid Price "${get(cells, 'price')}"`); continue }

    const ts = parseNtTime(get(cells, 'time') ?? '', tz)
    if (!ts) { parseErrors.push(`Row ${rowNumber}: invalid Time "${get(cells, 'time')}"`); continue }

    const instrument = (get(cells, 'instrument') ?? '').trim()
    const commission = Number((get(cells, 'commission') ?? '0').replace(/[$,]/g, '')) || 0

    fills.push({
      ts,
      symbol: ntSymbolRoot(instrument),
      account: (get(cells, 'account') ?? '').trim() || 'NT',
      qty,
      side,
      price,
      id: (get(cells, 'id') ?? '').trim() || String(rowNumber),
      commission,
      rowIndex: rowNumber,
    })
  }

  // Chronological, ties broken by grid row order.
  fills.sort((a, b) => {
    const dt = a.ts.getTime() - b.ts.getTime()
    return dt !== 0 ? dt : a.rowIndex - b.rowIndex
  })

  // Walk fills tracking per-(account|symbol) position: a trade is 0 → non-zero → 0.
  // (Same proven model as the Sierra importer; assumes the account flattens
  //  before reversing, which NinjaTrader scale-in/scale-out fills do.)
  const open = new Map<string, OpenGroup>()
  const completed: OpenGroup[] = []
  for (const f of fills) {
    const key = `${f.account}|${f.symbol}`
    const delta = (f.side === 'Buy' ? 1 : -1) * f.qty
    let g = open.get(key)
    if (!g) {
      g = { account: f.account, symbol: f.symbol, direction: delta > 0 ? 'long' : 'short', fills: [], firstId: f.id, pos: 0 }
      open.set(key, g)
    }
    g.fills.push(f)
    g.pos += delta
    if (g.pos === 0) { completed.push(g); open.delete(key) }
  }
  for (const g of open.values()) {
    parseErrors.push(`Unclosed position at end of file: ${g.account} ${g.symbol} (net ${g.pos}).`)
  }

  const rows: ParsedSCRow[] = []
  for (const g of completed) {
    const isLong = g.direction === 'long'
    const opens = g.fills.filter(f => (isLong ? f.side === 'Buy' : f.side === 'Sell'))
    const closes = g.fills.filter(f => (isLong ? f.side === 'Sell' : f.side === 'Buy'))
    if (opens.length === 0 || closes.length === 0) continue

    const totalOpenQty = opens.reduce((s, f) => s + f.qty, 0)
    const totalCloseQty = closes.reduce((s, f) => s + f.qty, 0)
    const entryAvg = opens.reduce((s, f) => s + f.qty * f.price, 0) / totalOpenQty
    const exitAvg = closes.reduce((s, f) => s + f.qty * f.price, 0) / totalCloseQty
    const points = isLong ? exitAvg - entryAvg : entryAvg - exitAvg
    const matchedQty = Math.min(totalOpenQty, totalCloseQty)
    const multiplier = symbolToMultiplier(g.symbol)
    const commissionTotal = g.fills.reduce((s, f) => s + f.commission, 0)
    // Net P&L — the grid gives per-fill commission, so subtract it (unlike the
    // Sierra log, which carries no commission and yields gross P&L).
    const pnl = points * matchedQty * multiplier - commissionTotal

    // Group closing fills into exits (one per price+second), like the SC importer.
    const exitGroups = new Map<string, { ts: Date; totalQty: number; totalValue: number }>()
    for (const c of closes) {
      const k = `${Math.floor(c.ts.getTime() / 1000)}:${round2(c.price)}`
      const ex = exitGroups.get(k)
      if (ex) {
        ex.totalQty += c.qty; ex.totalValue += c.qty * c.price
        if (c.ts.getTime() < ex.ts.getTime()) ex.ts = c.ts
      } else {
        exitGroups.set(k, { ts: c.ts, totalQty: c.qty, totalValue: c.qty * c.price })
      }
    }
    const exits = Array.from(exitGroups.values())
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .map(e => ({ time: e.ts.toISOString(), price: round2(e.totalValue / e.totalQty), qty: e.totalQty }))

    rows.push({
      sierra_trade_id: `nt:${g.account}:${g.firstId}`,
      account: g.account,
      symbol: g.symbol,
      entry_time_iso: opens[0].ts.toISOString(),
      entry_price: round2(entryAvg),
      exit_time_iso: closes[closes.length - 1].ts.toISOString(),
      exit_price: round2(exitAvg),
      direction: g.direction,
      quantity: matchedQty,
      pnl: round2(pnl),
      high_during_position: null, // backfilled from bars in the route
      low_during_position: null,
      exits,
    })
  }

  if (skippedZeroQty > 0) parseErrors.push(`Skipped ${skippedZeroQty} rows with zero/missing quantity`)
  return { rows, parseErrors, skippedFiltered: 0 }
}
