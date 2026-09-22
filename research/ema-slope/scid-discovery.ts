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

const CONTRACT_RE = /^NQ([HMUZ])(\d{1,2})[.\-]CME\.scid$/i

// Parses a Sierra contract filename like "NQM6.CME.scid" or "NQZ23-CME.scid".
export function parseContractFile(filename: string): { letter: string; month: number; year: number } | null {
  const m = filename.match(CONTRACT_RE)
  if (!m) return null
  const letter = m[1].toUpperCase()
  const month = MONTH_LETTER_TO_IDX[letter]
  const yr = parseInt(m[2], 10)
  let year: number
  if (m[2].length === 2) {
    year = yr >= 70 ? 1900 + yr : 2000 + yr
  } else {
    year = 2020 + yr
  }
  return { letter, month, year }
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

// Fraction of sampled mid-file trade prices that show genuine 0.25-tick granularity.
// Genuine NQ data (either ×100-scaled ints ending 25/50/75, or unscaled floats with
// fractional parts) scores ~0.7; files whose prices were rounded to whole points
// (the degraded 2026-06-25 copies, e.g. NQZ25-CME.scid) score ~0.03.
function tickQualityScore(path: string): number {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const recCount = Math.floor((size - HEADER_SIZE) / RECORD_SIZE)
    if (recCount < 64) return 0
    const N = Math.min(512, recCount)
    const startIdx = Math.floor((recCount - N) / 2)
    const buf = Buffer.alloc(N * RECORD_SIZE)
    readSync(fd, buf, 0, N * RECORD_SIZE, HEADER_SIZE + startIdx * RECORD_SIZE)
    let sampled = 0
    let fine = 0
    for (let i = 0; i < N; i++) {
      const close = buf.readFloatLE(i * RECORD_SIZE + 20)
      if (!Number.isFinite(close) || close <= 0) continue
      sampled++
      const hasFraction = close !== Math.floor(close)
      const sub = Math.round(close) % 100
      if (hasFraction || sub === 25 || sub === 50 || sub === 75) fine++
    }
    return sampled > 0 ? fine / sampled : 0
  } finally {
    closeSync(fd)
  }
}

// Lists NQ quarterly contract .scid files in a directory, sorted chronologically
// by expiry. Handles both naming conventions (NQM6.CME.scid and NQH23-CME.scid).
// Where the same expiry month/year has multiple files (legacy + current naming),
// prefer genuine tick granularity (see tickQualityScore), then the larger file.
export function listNqContracts(dir: string): ContractFile[] {
  const entries = readdirSync(dir).filter(f => CONTRACT_RE.test(f))
  const candidates: ContractFile[] = []
  for (const name of entries) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.size <= HEADER_SIZE) continue
    const parsed = parseContractFile(name)
    if (!parsed) continue
    const { letter, month, year } = parsed
    const ownRollMs = rollDateMs(year, month)
    const prevRollMs = rollDateMs(year, month - 3) // Date.UTC handles negative month
    const span = scidFileSpan(path)
    candidates.push({
      name,
      path,
      contract: `NQ${letter}${year % 100}`.padEnd(5, '_').slice(0, 5),
      expiryMonth: month,
      expiryYear: year,
      activeStartMs: prevRollMs,
      activeEndMs: ownRollMs,
      fileFirstMs: span.firstMs,
      fileLastMs: span.lastMs,
      sizeBytes: span.sizeBytes,
    })
  }

  // Dedupe by (year, month) — genuine tick granularity first, then the largest file.
  // (Score computed lazily, only for expiries that actually have duplicates.)
  const byExpiry = new Map<string, ContractFile>()
  const dropped: Array<{ kept: string; dropped: string }> = []
  const scores = new Map<string, number>()
  const scoreOf = (cf: ContractFile): number => {
    let s = scores.get(cf.path)
    if (s == null) { s = tickQualityScore(cf.path); scores.set(cf.path, s) }
    return s
  }
  for (const cf of candidates) {
    const key = `${cf.expiryYear}-${cf.expiryMonth}`
    const existing = byExpiry.get(key)
    if (!existing) {
      byExpiry.set(key, cf)
      continue
    }
    const exGenuine = scoreOf(existing) >= 0.2
    const cfGenuine = scoreOf(cf) >= 0.2
    const cfWins = cfGenuine !== exGenuine ? cfGenuine : cf.sizeBytes > existing.sizeBytes
    if (cfWins) {
      dropped.push({ kept: cf.name, dropped: existing.name })
      byExpiry.set(key, cf)
    } else {
      dropped.push({ kept: existing.name, dropped: cf.name })
    }
  }
  if (dropped.length > 0) {
    console.log(`Deduped ${dropped.length} duplicate contract file(s):`)
    for (const d of dropped) console.log(`  kept ${d.kept}, dropped ${d.dropped}`)
  }

  const out = [...byExpiry.values()]
  out.sort((a, b) => a.activeStartMs - b.activeStartMs)
  return out
}
