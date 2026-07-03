/**
 * Flexible CSV importer for broker/platform trade exports
 * (NinjaTrader "Trade Performance", Tradovate "Performance", and generic CSVs).
 *
 * It maps a wide set of header-name variants onto our `trades` shape, so one
 * parser handles multiple platforms and degrades gracefully (rows missing
 * required fields are skipped and counted, not silently dropped).
 *
 * ⚠️ VALIDATE AGAINST REAL EXPORTS. The header aliases and the MAE/MFE
 * unit handling below are best-effort and must be checked against actual
 * NinjaTrader / Tradovate export files. In particular: MAE/MFE are assumed to
 * be in PRICE POINTS (so high/low-during-position = entry ± MAE/MFE per
 * direction). If a platform exports them in ticks or dollars, that conversion
 * needs adjusting. See the A1 note in the deploy plan.
 */

export interface ParsedTrade {
  trade_date: string // YYYY-MM-DD (local trading day)
  entry_time: string | null // ISO
  exit_time: string | null
  entry_price: number | null
  exit_price: number | null
  stop_price: number | null
  direction: 'long' | 'short' | null
  quantity: number | null
  pnl: number | null
  symbol: string | null
  high_during_position: number | null
  low_during_position: number | null
  dedup_key: string // stable per row → idempotent re-import
}

export interface ImportParseResult {
  trades: ParsedTrade[]
  total: number
  skipped: number
  warnings: string[]
}

/** Normalize a header cell to an alias key: lowercase, strip non-alphanumerics. */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Header aliases per field (already normalized).
const ALIASES: Record<string, string[]> = {
  symbol: ['symbol', 'instrument', 'contract', 'ticker', 'market'],
  side: ['side', 'bs', 'action', 'marketpos', 'marketposition', 'position', 'direction', 'longshort', 'type'],
  quantity: ['qty', 'quantity', 'filledqty', 'size', 'contracts', 'amount'],
  entryPrice: ['entryprice', 'avgentryprice', 'priceentry', 'entry', 'openprice', 'avgopenprice'],
  exitPrice: ['exitprice', 'avgexitprice', 'priceexit', 'exit', 'closeprice', 'avgcloseprice'],
  buyPrice: ['buyprice', 'avgbuyprice'],
  sellPrice: ['sellprice', 'avgsellprice'],
  entryTime: ['entrytime', 'entrytimestamp', 'opentime', 'entrydatetime', 'timeentered', 'opened'],
  exitTime: ['exittime', 'exittimestamp', 'closetime', 'exitdatetime', 'timeexited', 'closed'],
  boughtTime: ['boughttimestamp', 'boughttime'],
  soldTime: ['soldtimestamp', 'soldtime'],
  pnl: ['pnl', 'profit', 'profitloss', 'netpnl', 'realizedpnl', 'pl', 'grosspl', 'netprofit', 'grossp', 'plcurrency'],
  // Prefer NET P&L (after commissions) when a platform exports both (Tradezella).
  netPnl: ['netpnl', 'netpl', 'netprofit'],
  mae: ['mae', 'maxadverseexcursion', 'maeprice'],
  mfe: ['mfe', 'maxfavorableexcursion', 'mfeprice'],
  // Tradezella exports the actual worst/best PRICE reached during the position.
  priceMae: ['pricemae'],
  priceMfe: ['pricemfe'],
  stop: ['stop', 'stopprice', 'stoploss'],
  high: ['highduringposition', 'high'],
  low: ['lowduringposition', 'low'],
  date: ['date', 'tradedate'],
  // Split date/time columns (Tradezella: Open Date + Open Time, Close Date + Close Time).
  openDate: ['opendate'],
  openTime: ['opentime'],
  closeDate: ['closedate'],
  closeTime: ['closetime'],
}

/** Minimal RFC-4180-ish CSV line splitter (handles quoted fields w/ commas). */
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

function toNumber(v: string | undefined): number | null {
  if (v == null) return null
  // strip currency symbols, thousands separators, parentheses-as-negative
  let s = v.replace(/[$,]/g, '').trim()
  if (s === '' || s === '-' || s.toLowerCase() === 'n/a') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  const n = parseFloat(s)
  if (Number.isNaN(n)) return null
  return neg ? -n : n
}

function toIso(v: string | undefined): string | null {
  if (!v || v.trim() === '') return null
  const d = new Date(v.trim())
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

// North-American trading timezone abbreviations → UTC offsets. Tradezella writes
// times like "08:13:25 PDT"; JS Date can't parse the abbreviation reliably, so
// we map it ourselves.
const TZ_OFFSETS: Record<string, string> = {
  UTC: '+00:00', GMT: '+00:00',
  EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00',
  MST: '-07:00', MDT: '-06:00', PST: '-08:00', PDT: '-07:00',
}

/** Combine a separate date ("YYYY-MM-DD") and time ("HH:MM:SS [TZ]") into an ISO
 *  string. A trailing timezone abbreviation is mapped to an offset; without one
 *  the time is read in the server's zone. For exports (Tradezella) that split
 *  date and time into separate columns. */
function combineDateTime(dateRaw?: string, timeRaw?: string): string | null {
  if (!dateRaw) return null
  const d = dateRaw.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toIso(dateRaw) // maybe already a full datetime
  if (!timeRaw || !timeRaw.trim()) return `${d}T00:00:00.000Z`
  let t = timeRaw.trim()
  let offset = ''
  const m = t.match(/\s([A-Za-z]{2,4})$/)
  if (m) {
    if (TZ_OFFSETS[m[1].toUpperCase()]) offset = TZ_OFFSETS[m[1].toUpperCase()]
    t = t.slice(0, m.index).trim()
  }
  const parsed = new Date(`${d}T${t}${offset}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function localDate(iso: string | null): string | null {
  if (!iso) return null
  return iso.slice(0, 10) // YYYY-MM-DD from the ISO string
}

function detectDirection(raw: string | undefined): 'long' | 'short' | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (/(^|[^a-z])(buy|long|b)([^a-z]|$)/.test(s) || s === 'l') return 'long'
  if (/(^|[^a-z])(sell|short|s)([^a-z]|$)/.test(s)) return 'short'
  return null
}

/**
 * Parse a CSV export into ParsedTrade rows. Returns the rows plus counts of
 * skipped/total and any warnings.
 */
export function parseTradeCsv(csvText: string): ImportParseResult {
  const warnings: string[] = []
  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) {
    return { trades: [], total: 0, skipped: 0, warnings: ['Empty or header-only file.'] }
  }
  const header = splitCsvLine(lines[0]).map(normKey)

  // Build field → column-index map from aliases (first match wins).
  const col: Record<string, number> = {}
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const idx = header.findIndex(h => aliases.includes(h))
    if (idx >= 0) col[field] = idx
  }
  const get = (cells: string[], field: string): string | undefined =>
    col[field] != null ? cells[col[field]] : undefined

  const trades: ParsedTrade[] = []
  let skipped = 0
  const total = lines.length - 1

  for (let r = 1; r < lines.length; r++) {
    const cells = splitCsvLine(lines[r])

    const symbol = get(cells, 'symbol')?.trim() || null
    let direction = detectDirection(get(cells, 'side'))
    let entryPrice = toNumber(get(cells, 'entryPrice'))
    let exitPrice = toNumber(get(cells, 'exitPrice'))
    let entryTime = toIso(get(cells, 'entryTime'))
    let exitTime = toIso(get(cells, 'exitTime'))
    // Split date/time columns (Tradezella: Open Date + Open Time "HH:MM:SS PDT").
    if (!entryTime) entryTime = combineDateTime(get(cells, 'openDate'), get(cells, 'openTime'))
    if (!exitTime) exitTime = combineDateTime(get(cells, 'closeDate'), get(cells, 'closeTime'))

    // Tradovate-style buy/sell columns: derive entry/exit + direction from
    // whichever fill came first.
    if (entryPrice == null && exitPrice == null) {
      const buyP = toNumber(get(cells, 'buyPrice'))
      const sellP = toNumber(get(cells, 'sellPrice'))
      const boughtT = toIso(get(cells, 'boughtTime'))
      const soldT = toIso(get(cells, 'soldTime'))
      if (buyP != null && sellP != null) {
        const longFirst = boughtT && soldT ? boughtT <= soldT : (direction !== 'short')
        if (longFirst) {
          direction = direction ?? 'long'
          entryPrice = buyP; exitPrice = sellP; entryTime = entryTime ?? boughtT; exitTime = exitTime ?? soldT
        } else {
          direction = direction ?? 'short'
          entryPrice = sellP; exitPrice = buyP; entryTime = entryTime ?? soldT; exitTime = exitTime ?? boughtT
        }
      }
    }

    const quantity = toNumber(get(cells, 'quantity'))
    const pnl = toNumber(get(cells, 'netPnl')) ?? toNumber(get(cells, 'pnl'))
    const stop = toNumber(get(cells, 'stop'))

    // high/low during position: prefer explicit high/low columns; then the
    // actual worst/best PRICE (Tradezella Price MAE/MFE — the two are the low
    // and high regardless of direction); else derive from MAE/MFE price points.
    let high = toNumber(get(cells, 'high'))
    let low = toNumber(get(cells, 'low'))
    if (high == null || low == null) {
      const pMae = toNumber(get(cells, 'priceMae'))
      const pMfe = toNumber(get(cells, 'priceMfe'))
      if (pMae != null && pMfe != null) {
        high = high ?? Math.max(pMae, pMfe)
        low = low ?? Math.min(pMae, pMfe)
      }
    }
    if ((high == null || low == null) && entryPrice != null && direction != null) {
      const mae = toNumber(get(cells, 'mae'))
      const mfe = toNumber(get(cells, 'mfe'))
      if (mae != null || mfe != null) {
        const m = Math.abs(mae ?? 0)
        const f = Math.abs(mfe ?? 0)
        if (direction === 'long') {
          high = high ?? (mfe != null ? entryPrice + f : null)
          low = low ?? (mae != null ? entryPrice - m : null)
        } else {
          high = high ?? (mae != null ? entryPrice + m : null)
          low = low ?? (mfe != null ? entryPrice - f : null)
        }
      }
    }

    // Prefer the platform's own trading-day column (Tradezella "Open Date") —
    // it's the trader's session date, independent of any timezone shift.
    const openDateCol = get(cells, 'openDate')?.trim().slice(0, 10)
    const tradeDate =
      (openDateCol && /^\d{4}-\d{2}-\d{2}$/.test(openDateCol) ? openDateCol : null) ||
      localDate(exitTime) || localDate(entryTime) ||
      (get(cells, 'date') ? localDate(toIso(get(cells, 'date'))) : null)

    // Require enough to be a real trade: a date + (entry & exit prices OR a pnl).
    if (!tradeDate || ((entryPrice == null || exitPrice == null) && pnl == null)) {
      skipped++
      continue
    }

    const dedup_key = `csv:${symbol ?? ''}:${entryTime ?? ''}:${entryPrice ?? ''}:${exitPrice ?? ''}:${pnl ?? ''}`

    trades.push({
      trade_date: tradeDate,
      entry_time: entryTime,
      exit_time: exitTime,
      entry_price: entryPrice,
      exit_price: exitPrice,
      stop_price: stop,
      direction,
      quantity,
      pnl,
      symbol,
      high_during_position: high,
      low_during_position: low,
      dedup_key,
    })
  }

  if (trades.length === 0 && skipped > 0) {
    warnings.push(
      `No rows matched the expected columns. Detected headers: ${header.join(', ')}. ` +
      `This export format may need a mapping tweak.`,
    )
  }
  return { trades, total, skipped, warnings }
}
