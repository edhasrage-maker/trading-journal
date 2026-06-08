import { readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from 'fs'
import { join } from 'path'

const HEADER_SIZE = 56
const RECORD_SIZE = 40
const SCID_EPOCH_OFFSET_US = 25569 * 86400 * 1_000_000

const MONTH_LETTER_TO_IDX: Record<string, number> = { H: 2, M: 5, U: 8, Z: 11 } // 0-indexed (Mar/Jun/Sep/Dec)

export type ContractFile = {
  name: string
  path: string
  contract: string // e.g. "NQM6", "NQH26"
  expiryMonth: number // 0-indexed
  expiryYear: number
  activeStartMs: number // front-month window start (UTC ms)
  activeEndMs: number // front-month window end (exclusive)
  fileFirstMs: number | null
  fileLastMs: number | null
  sizeBytes: number
}

// Parses a Sierra contract code like "NQM6" or "NQH26" into expiry month/year.
// Two-digit years assumed 20xx. One-digit years use the next occurrence at or after 2020.
export function parseContractCode(code: string): { month: number; year: number } | null {
  const m = code.match(/^NQ([HMUZ])(\d{1,2})$/i)
  if (!m) return null
  const month = MONTH_LETTER_TO_IDX[m[1].toUpperCase()]
  const yr = parseInt(m[2], 10)
  let year: number
  if (m[2].length === 2) {
    year = yr >= 70 ? 1900 + yr : 2000 + yr
  } else {
    // Single-digit year — ambiguous. Resolve to the decade we're in (2020s).
    year = 2020 + yr
    // But if that's already past, bump to 2030+. Sierra single-digit codes are
    // typically near-term so just-past contracts are common; we don't want to
    // misread a 2024 contract as 2034.
    // No bump needed — past contracts are fine to backtest.
  }
  return { month, year }
}

// 14th of expiry month, UTC midnight — close enough to standard E-mini roll day.
function rollDateMs(year: number, month: number): number {
  return Date.UTC(year, month, 14)
}

// Reads SCID header + first & last records to learn the file's time span (cheap).
function scidFileSpan(path: string): { firstMs: number | null; lastMs: number | null; sizeBytes: number } {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < HEADER_SIZE + RECORD_SIZE) return { firstMs: null, lastMs: null, sizeBytes: size }
    const hdr = Buffer.alloc(HEADER_SIZE)
    readSync(fd, hdr, 0, HEADER_SIZE, 0)
    if (hdr.toString('ascii', 0, 4) !== 'SCID') return { firstMs: null, lastMs: null, sizeBytes: size }
    const recCount = Math.floor((size - HEADER_SIZE) / RECORD_SIZE)
    if (recCount === 0) return { firstMs: null, lastMs: null, sizeBytes: size }
    const buf = Buffer.alloc(8)
    readSync(fd, buf, 0, 8, HEADER_SIZE)
    const firstMicros = Number(buf.readBigInt64LE(0))
    readSync(fd, buf, 0, 8, HEADER_SIZE + (recCount - 1) * RECORD_SIZE)
    const lastMicros = Number(buf.readBigInt64LE(0))
    return {
      firstMs: (firstMicros - SCID_EPOCH_OFFSET_US) / 1000,
      lastMs: (lastMicros - SCID_EPOCH_OFFSET_US) / 1000,
      sizeBytes: size,
    }
  } finally {
    closeSync(fd)
  }
}

// Lists NQ quarterly contract .scid files in a directory, sorted chronologically
// by expiry. Each entry carries its "front-month" active window (prev roll → own roll)
// so callers can read only that contract's high-volume span and avoid rollover overlap.
export function listNqContracts(dir: string): ContractFile[] {
  const entries = readdirSync(dir).filter(f => /^NQ[HMUZ]\d{1,2}\.CME\.scid$/i.test(f))
  const out: ContractFile[] = []
  for (const name of entries) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.size <= HEADER_SIZE) continue
    const contract = name.replace(/\.CME\.scid$/i, '').toUpperCase()
    const parsed = parseContractCode(contract)
    if (!parsed) continue
    const { month, year } = parsed
    // Active window: [prev roll, own roll). Prev roll = roll day 3 months earlier.
    const ownRollMs = rollDateMs(year, month)
    const prevRollMs = rollDateMs(year, month - 3) // Date.UTC handles negative month
    const span = scidFileSpan(path)
    out.push({
      name,
      path,
      contract,
      expiryMonth: month,
      expiryYear: year,
      activeStartMs: prevRollMs,
      activeEndMs: ownRollMs,
      fileFirstMs: span.firstMs,
      fileLastMs: span.lastMs,
      sizeBytes: span.sizeBytes,
    })
  }
  out.sort((a, b) => a.activeStartMs - b.activeStartMs)
  return out
}
