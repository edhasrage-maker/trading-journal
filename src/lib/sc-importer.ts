import Papa from 'papaparse'

/**
 * Sierra Chart Trade Activity Log importer.
 *
 * The user exports the SC Trade Activity Log via right-click → "Export Window
 * Contents to Text File" (tab-delimited). The export has 29 columns; each row
 * is a single fill (partial or full). This module:
 *   1. Parses the tab-delimited file
 *   2. Filters out non-Fill rows and simulated/None accounts
 *   3. Walks fills in chronological order, accumulating per-(account, symbol)
 *      position. A trade is one round-trip: position transitions 0 → non-zero
 *      → 0.
 *   4. Aggregates each round-trip into a single ParsedSCRow with weighted-avg
 *      entry/exit prices and computed P&L using the symbol's multiplier.
 */

export interface ParsedSCRow {
  sierra_trade_id: string         // unique-per-trade ID stable across re-imports
  account: string
  symbol: string
  entry_time_iso: string          // ISO timestamp (first opening fill)
  entry_price: number             // weighted average of opening fills
  exit_time_iso?: string | null   // ISO timestamp (last closing fill)
  exit_price?: number | null      // weighted average of closing fills
  direction: 'long' | 'short'
  quantity: number                // peak position size during the trade
  pnl: number | null              // dollar P&L using contract multiplier
  // Tick-level extremes during the position. Sierra writes these on closing
  // fills (HighDuringPosition / LowDuringPosition columns). For MFE/MAE, the
  // display layer interprets these against the direction:
  //   long:  MFE = high - entry,    MAE = entry - low
  //   short: MFE = entry - low,     MAE = high - entry
  high_during_position: number | null
  low_during_position: number | null
  // Each individual closing fill, in chronological order. Multi-leg exits
  // (scale-outs) show up as multiple entries; single-exit trades have one
  // entry here too. The aggregated weighted-average lives in entry/exit_price
  // for PnL math and list-view display.
  exits: Array<{ time: string; price: number; qty: number }>
}

export interface ParseOutcome {
  rows: ParsedSCRow[]
  parseErrors: string[]
  skippedFiltered: number
}

/**
 * Sim/None account blacklist. Anything else is treated as live.
 * Original spec said "LFE/TEST only" but actual user data has LFF/PRO and other
 * prop formats — blacklisting is more robust than maintaining a regex of every
 * live prefix.
 */
const SIM_ACCOUNT_RE = /^(None|Sim\d*)$/i

export function isLiveAccount(account: string | undefined | null): boolean {
  if (!account) return false
  const a = account.trim()
  if (!a) return false
  return !SIM_ACCOUNT_RE.test(a)
}

/**
 * Common CME/CBOT/COMEX/NYMEX futures contract multipliers ($/point).
 * Extend as needed. Defaults to 1 if unknown (raw points P&L).
 */
const MULTIPLIERS: Record<string, number> = {
  // Equity index — E-mini
  ES: 50, NQ: 20, RTY: 50, YM: 5,
  // Equity index — Micro
  MES: 5, MNQ: 2, M2K: 5, MYM: 0.5,
  // Metals
  GC: 100, MGC: 10, SI: 5000, SIL: 1000, HG: 25000, MHG: 2500, PL: 50,
  // Energy
  CL: 1000, MCL: 100, NG: 10000, RB: 42000, HO: 42000,
  // Currencies (per full point)
  '6E': 125000, '6B': 62500, '6J': 12500000, '6A': 100000, '6C': 100000,
  // Interest rate / bonds
  ZN: 1000, ZB: 1000, ZF: 1000, ZT: 2000,
  // Grains
  ZC: 50, ZS: 50, ZW: 50,
}

/** Map "MNQM6.CME" → "MNQ", "ESM6.CME" → "ES", "6EM6.CME" → "6E". */
function symbolRoot(symbol: string): string {
  // Take the part before the first "." (drops .CME, .NYMEX, etc.)
  const noExchange = symbol.split('.')[0]
  // Strip the last contract month code (one letter + one or two digit year)
  // e.g. "MNQM6" → "MNQ", "ZNH26" → "ZN"
  return noExchange.replace(/[A-Z]\d{1,2}$/, '')
}

export function symbolToMultiplier(symbol: string): number {
  return MULTIPLIERS[symbolRoot(symbol)] ?? 1
}

/**
 * Parse a Sierra Chart DateTime string. Format: "YYYY-MM-DD  HH:MM:SS[.fraction]"
 * (two spaces between date and time, microsecond fraction optional). Interpreted
 * in the browser/server local timezone — SC writes fills in the trader's local TZ
 * with no offset marker.
 */
function parseDateTime(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d, h, min, s, frac] = m
  const ms = frac ? Math.floor(Number(`0.${frac.padEnd(6, '0').slice(0, 6)}`) * 1000) : 0
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(min), Number(s), ms)
  return Number.isNaN(dt.getTime()) ? null : dt
}

interface RawRow {
  ActivityType?: string
  DateTime?: string
  Symbol?: string
  Quantity?: string
  BuySell?: string
  FillPrice?: string
  Price?: string
  TradeAccount?: string
  OpenClose?: string
  InternalOrderID?: string
  ParentInternalOrderID?: string
  PositionQuantity?: string
  OrderStatus?: string
  OrderType?: string
  HighDuringPosition?: string
  LowDuringPosition?: string
}

interface Fill {
  ts: Date
  symbol: string
  account: string
  qty: number
  side: 'Buy' | 'Sell'
  fillPrice: number
  internalOrderID: string
  rowIndex: number
  // Tick-level extremes Sierra recorded while the position was open. These
  // appear only on CLOSING fills (the open period precedes the close).
  // Null on opening fills and on closing fills where Sierra didn't write a
  // value (e.g., empty-string columns on some row variants).
  highDuringPosition: number | null
  lowDuringPosition: number | null
}

interface OpenGroup {
  account: string
  symbol: string
  direction: 'long' | 'short'
  fills: Fill[]
  firstOpenIOID: string
  peak: number
  pos: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function parseSierraChartLog(text: string): ParseOutcome {
  const parsed = Papa.parse<RawRow>(text, {
    delimiter: '\t',
    header: true,
    skipEmptyLines: true,
  })

  const parseErrors: string[] = []
  const fills: Fill[] = []
  let skippedFiltered = 0
  let skippedNonFill = 0
  let skippedZeroQty = 0

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i]
    if (!row || !row.ActivityType) continue
    const rowNumber = i + 2 // header is line 1

    if (row.ActivityType !== 'Fills') {
      skippedNonFill++
      continue
    }
    if (!isLiveAccount(row.TradeAccount)) {
      skippedFiltered++
      continue
    }

    const ts = parseDateTime(row.DateTime ?? '')
    if (!ts) {
      parseErrors.push(`Row ${rowNumber}: invalid DateTime "${row.DateTime}"`)
      continue
    }

    const qty = Number(row.Quantity ?? '')
    const fillPrice = Number(row.FillPrice ?? '')
    if (!Number.isFinite(qty) || qty <= 0) {
      skippedZeroQty++
      continue
    }
    if (!Number.isFinite(fillPrice)) {
      parseErrors.push(`Row ${rowNumber}: invalid FillPrice "${row.FillPrice}"`)
      continue
    }

    const sideRaw = (row.BuySell ?? '').trim()
    if (sideRaw !== 'Buy' && sideRaw !== 'Sell') {
      parseErrors.push(`Row ${rowNumber}: invalid BuySell "${row.BuySell}"`)
      continue
    }

    // High/Low During Position — Sierra writes these on closing fills with
    // tick-level precision over the open period. Treat blanks and zero as
    // "not written" (opening fills typically have blank columns here).
    const hdpRaw = row.HighDuringPosition?.trim() ?? ''
    const ldpRaw = row.LowDuringPosition?.trim() ?? ''
    const hdpNum = Number(hdpRaw)
    const ldpNum = Number(ldpRaw)
    const highDuringPosition = hdpRaw !== '' && Number.isFinite(hdpNum) && hdpNum > 0 ? hdpNum : null
    const lowDuringPosition = ldpRaw !== '' && Number.isFinite(ldpNum) && ldpNum > 0 ? ldpNum : null

    fills.push({
      ts,
      symbol: row.Symbol ?? '',
      account: (row.TradeAccount ?? '').trim(),
      qty,
      side: sideRaw,
      fillPrice,
      internalOrderID: row.InternalOrderID ?? '',
      rowIndex: rowNumber,
      highDuringPosition,
      lowDuringPosition,
    })
  }

  // Sort by timestamp, then by row order for ties (microsecond fills come in order)
  fills.sort((a, b) => {
    const dt = a.ts.getTime() - b.ts.getTime()
    return dt !== 0 ? dt : a.rowIndex - b.rowIndex
  })

  // Walk fills, tracking per-(account|symbol) position. A trade starts when
  // position goes 0 → non-zero and ends when it returns to 0.
  const open = new Map<string, OpenGroup>()
  const completed: OpenGroup[] = []

  for (const f of fills) {
    const key = `${f.account}|${f.symbol}`
    const sign = f.side === 'Buy' ? 1 : -1
    const delta = sign * f.qty

    let g = open.get(key)
    if (!g) {
      // Position starts here — direction defined by first fill
      g = {
        account: f.account,
        symbol: f.symbol,
        direction: sign > 0 ? 'long' : 'short',
        fills: [],
        firstOpenIOID: f.internalOrderID,
        peak: 0,
        pos: 0,
      }
      open.set(key, g)
    }

    g.fills.push(f)
    g.pos += delta
    g.peak = Math.max(g.peak, Math.abs(g.pos))

    if (g.pos === 0) {
      completed.push(g)
      open.delete(key)
    }
  }

  // Warn about unclosed positions (open at end of file)
  for (const g of open.values()) {
    parseErrors.push(
      `Unclosed position at end of file: ${g.account} ${g.symbol} (net ${g.pos}). ` +
        'Re-export after the position closes.',
    )
  }

  // Aggregate each completed round-trip into a ParsedSCRow
  const rows: ParsedSCRow[] = []
  for (const g of completed) {
    const isLong = g.direction === 'long'
    const opens = g.fills.filter(f => (isLong ? f.side === 'Buy' : f.side === 'Sell'))
    const closes = g.fills.filter(f => (isLong ? f.side === 'Sell' : f.side === 'Buy'))
    if (opens.length === 0 || closes.length === 0) continue

    const totalOpenQty = opens.reduce((s, f) => s + f.qty, 0)
    const totalCloseQty = closes.reduce((s, f) => s + f.qty, 0)
    const openValue = opens.reduce((s, f) => s + f.qty * f.fillPrice, 0)
    const closeValue = closes.reduce((s, f) => s + f.qty * f.fillPrice, 0)
    const entryAvg = openValue / totalOpenQty
    const exitAvg = closeValue / totalCloseQty
    const points = isLong ? exitAvg - entryAvg : entryAvg - exitAvg
    const matchedQty = Math.min(totalOpenQty, totalCloseQty)
    const multiplier = symbolToMultiplier(g.symbol)
    const pnl = points * matchedQty * multiplier

    // Aggregate High/Low across the position's lifetime. Sierra writes these
    // on closing fills; for a multi-leg exit, each close records the extreme
    // up to that fill. Max of highs / min of lows gives the most extreme
    // values seen, which is what MFE/MAE should reflect.
    const allHighs = g.fills.map(f => f.highDuringPosition).filter((v): v is number => v != null)
    const allLows = g.fills.map(f => f.lowDuringPosition).filter((v): v is number => v != null)
    const high_during_position = allHighs.length > 0 ? Math.max(...allHighs) : null
    const low_during_position = allLows.length > 0 ? Math.min(...allLows) : null

    // Each individual closing fill becomes one element in the exits array.
    // Sorted ascending by time so chart renderers can iterate in order.
    const exits = closes
      .slice()
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .map(c => ({
        time: c.ts.toISOString(),
        price: round2(c.fillPrice),
        qty: c.qty,
      }))

    rows.push({
      sierra_trade_id: `${g.account}:${g.firstOpenIOID}`,
      account: g.account,
      symbol: g.symbol,
      entry_time_iso: opens[0].ts.toISOString(),
      entry_price: round2(entryAvg),
      exit_time_iso: closes[closes.length - 1].ts.toISOString(),
      exit_price: round2(exitAvg),
      direction: g.direction,
      quantity: g.peak,
      pnl: round2(pnl),
      high_during_position: high_during_position != null ? round2(high_during_position) : null,
      low_during_position: low_during_position != null ? round2(low_during_position) : null,
      exits,
    })
  }

  if (skippedNonFill > 0) parseErrors.push(`Skipped ${skippedNonFill} non-Fill rows`)
  if (skippedZeroQty > 0) parseErrors.push(`Skipped ${skippedZeroQty} rows with zero/missing quantity`)

  return { rows, parseErrors, skippedFiltered }
}

/**
 * Map a parsed row into a `trades` table upsert payload.
 *
 * The caller attaches `trading_day_id` (already attached by this function) and
 * runs the upsert with `onConflict: 'sierra_trade_id'` and `ignoreDuplicates:
 * false` so existing rows get their SC-owned fields refreshed on re-import
 * (e.g., when a new column is added and old trades need backfill, or when a
 * fill correction is written to the log after the fact).
 *
 * The payload deliberately includes ONLY fields that the SC log is the
 * authoritative source for. User-owned fields (tags_json, notes,
 * screenshot_url, stop_price, tp1_price, *_pin_*) are NEVER included — that
 * way an UPDATE-on-conflict touches only the SC-owned columns and leaves
 * everything the user has manually edited (tags, screenshots, plan levels)
 * intact. `tags_json` has a `default '{}'` at the column level so new INSERTs
 * still get the empty-object default.
 */
export function mapRowToTrade(r: ParsedSCRow, tradingDayId: string) {
  return {
    trading_day_id: tradingDayId,
    sierra_trade_id: r.sierra_trade_id,
    symbol: r.symbol,
    entry_time: r.entry_time_iso,
    entry_price: r.entry_price,
    exit_time: r.exit_time_iso ?? null,
    exit_price: r.exit_price ?? null,
    direction: r.direction,
    quantity: r.quantity,
    pnl: r.pnl,
    high_during_position: r.high_during_position,
    low_during_position: r.low_during_position,
    exits_json: r.exits,
  }
}
