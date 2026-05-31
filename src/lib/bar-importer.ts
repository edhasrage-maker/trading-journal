import Papa from 'papaparse'

/**
 * Generic OHLCV CSV parser for the bar-import flow.
 *
 * Accepts the canonical format:
 *   timestamp,open,high,low,close,volume
 *
 * Tolerant of common header-name variants (`Date Time`, `ts`, `o/h/l/c/v`,
 * `Close/Last`, etc.) and timestamp formats (ISO-8601, Sierra Chart's
 * `YYYY-MM-DD HH:MM:SS[.fraction]`, and epoch milliseconds). Also tolerant
 * of CSVs that split timestamp into separate `Date` and `Time` columns
 * (Sierra's default chart-data export format) — they're concatenated before
 * timestamp parsing.
 *
 * Volume is optional. Header row is required.
 */

export interface ParsedBar {
  ts: string   // ISO-8601 string, suitable for direct insert into timestamptz
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface BarParseResult {
  rows: ParsedBar[]
  parseErrors: string[]
  dateRangeStart: string | null  // YYYY-MM-DD from earliest ts
  dateRangeEnd: string | null    // YYYY-MM-DD from latest ts
}

const ALIASES = {
  // Combined-column timestamp variants. Order matters — we look for these
  // first; if none found, fall back to separate Date + Time columns.
  timestamp: ['timestamp', 'ts', 'datetime', 'date time', 'date+time', 'date_time'],
  date: ['date'],
  time: ['time'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c', 'last'],
  volume: ['volume', 'v', 'vol', 'total volume'],
}

function findColumn(header: string[], aliases: string[]): string | null {
  const lowered = header.map(h => h.toLowerCase().trim())
  for (const alias of aliases) {
    const idx = lowered.indexOf(alias.toLowerCase())
    if (idx !== -1) return header[idx]
  }
  return null
}

function parseTimestamp(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // ISO-8601 (with timezone or Z suffix)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const d = new Date(trimmed)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }

  // Sierra Chart format: "YYYY-MM-DD HH:MM:SS[.fraction]" (one or more spaces)
  const scMatch = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(trimmed)
  if (scMatch) {
    const [, y, mo, d, h, m, s] = scMatch
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(m), Number(s))
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  // Date only ("YYYY-MM-DD") — useful for daily-granularity imports
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(trimmed)
  if (dateOnly) {
    const d = new Date(`${trimmed}T00:00:00`)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }

  // Epoch (seconds or milliseconds)
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed)
    const d = new Date(n < 10_000_000_000 ? n * 1000 : n)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }

  return null
}

export function parseBarCsv(text: string): BarParseResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  })

  const errors: string[] = []
  const rows: ParsedBar[] = []

  if (!parsed.meta.fields || parsed.meta.fields.length === 0) {
    return { rows, parseErrors: ['CSV has no header row'], dateRangeStart: null, dateRangeEnd: null }
  }

  const header = parsed.meta.fields
  const tsCol = findColumn(header, ALIASES.timestamp)
  const dateCol = findColumn(header, ALIASES.date)
  const timeCol = findColumn(header, ALIASES.time)
  const openCol = findColumn(header, ALIASES.open)
  const highCol = findColumn(header, ALIASES.high)
  const lowCol = findColumn(header, ALIASES.low)
  const closeCol = findColumn(header, ALIASES.close)
  const volumeCol = findColumn(header, ALIASES.volume)

  const useSplitDateTime = !tsCol && dateCol && timeCol

  const missing: string[] = []
  if (!tsCol && !useSplitDateTime) missing.push('timestamp (or separate Date + Time columns)')
  if (!openCol) missing.push('open')
  if (!highCol) missing.push('high')
  if (!lowCol) missing.push('low')
  if (!closeCol) missing.push('close')
  if (missing.length > 0) {
    return {
      rows,
      parseErrors: [`Missing required column(s): ${missing.join(', ')}. Found headers: ${header.join(', ')}`],
      dateRangeStart: null,
      dateRangeEnd: null,
    }
  }

  let minTs: string | null = null
  let maxTs: string | null = null

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i]
    const rowNum = i + 2 // header is line 1

    const rawTs = useSplitDateTime
      ? `${row[dateCol!] ?? ''} ${row[timeCol!] ?? ''}`
      : row[tsCol!] ?? ''
    const tsIso = parseTimestamp(rawTs)
    if (!tsIso) {
      errors.push(`Row ${rowNum}: invalid timestamp "${rawTs}"`)
      continue
    }

    const open = Number(row[openCol!])
    const high = Number(row[highCol!])
    const low = Number(row[lowCol!])
    const close = Number(row[closeCol!])
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      errors.push(`Row ${rowNum}: non-numeric OHLC values`)
      continue
    }
    // Sanity check: high should be the max, low should be the min
    if (high < low) {
      errors.push(`Row ${rowNum}: high (${high}) < low (${low})`)
      continue
    }

    let volume: number | null = null
    if (volumeCol) {
      const v = Number(row[volumeCol])
      if (Number.isFinite(v) && v >= 0) volume = v
    }

    rows.push({ ts: tsIso, open, high, low, close, volume })
    if (!minTs || tsIso < minTs) minTs = tsIso
    if (!maxTs || tsIso > maxTs) maxTs = tsIso
  }

  // Cap error reporting to avoid bloated responses
  if (errors.length > 50) {
    const truncated = errors.length - 50
    errors.splice(50)
    errors.push(`...and ${truncated} more errors (showing first 50)`)
  }

  return {
    rows,
    parseErrors: errors,
    dateRangeStart: minTs ? minTs.slice(0, 10) : null,
    dateRangeEnd: maxTs ? maxTs.slice(0, 10) : null,
  }
}
