/**
 * Quarterly index-futures contract calendar + local `.scid` file resolution.
 *
 * ONE source of truth for "which contract was front-month on date X", shared by
 * every path that reads Sierra tick files: the live SC import (structure / ATR /
 * RVOL tagging via nq-front-month), the public bar feed, and the offline
 * backfills. Each of those used to carry its own copy of the NQ table under a
 * "keep in sync" comment — and ES had no table at all, so the shared bar feed
 * was pinned to a single ES contract and could never reach further back than
 * whenever that one file started filling.
 *
 * Roll convention: 8 days before the quarterly 3rd-Friday expiry. A contract is
 * front-month over [previous roll, its own roll). Prices are index level, so NQ
 * stands in for MNQ and ES for MES — the same collapsing chartSeriesRoot() does.
 *
 * FILE CASE. Sierra names its files from the exchange symbol and the casing is
 * not always what you'd expect — `NQz5.CME.scid` and `ESm3.CME.scid` are both
 * genuinely lower-case on disk. Windows doesn't care, but a case-sensitive
 * filesystem would, so the table stores the canonical upper-case name and
 * resolveFile() falls back to a directory scan when that name doesn't resolve.
 */
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { SIERRA_DATA_DIR } from './import-scid-day'

export type ContractRoot = 'NQ' | 'ES'

/**
 * Quarterly roll dates, oldest first. Month codes H=Mar M=Jun U=Sep Z=Dec.
 * The first entry has no predecessor, so it also stands in for any date before
 * its roll — in practice that contract only holds data back a few months, and
 * a date with no ticks reports "no data" rather than returning wrong bars.
 */
const ROLLS: ReadonlyArray<{ roll: string; code: string }> = [
  { roll: '2023-03-09', code: 'H3' },
  { roll: '2023-06-08', code: 'M3' },
  { roll: '2023-09-07', code: 'U3' },
  { roll: '2023-12-07', code: 'Z3' },
  { roll: '2024-03-07', code: 'H4' },
  { roll: '2024-06-13', code: 'M4' },
  { roll: '2024-09-12', code: 'U4' },
  { roll: '2024-12-12', code: 'Z4' },
  { roll: '2025-03-13', code: 'H5' },
  { roll: '2025-06-12', code: 'M5' },
  { roll: '2025-09-11', code: 'U5' },
  { roll: '2025-12-11', code: 'Z5' },
  { roll: '2026-03-12', code: 'H6' },
  { roll: '2026-06-11', code: 'M6' },
  { roll: '2026-09-11', code: 'U6' },
  { roll: '2026-12-11', code: 'Z6' },
]

export interface Contract {
  /** Front-month through the day before this date. */
  roll: string
  /** Filename as it actually exists in the data dir (case resolved). */
  file: string
}

// Resolved names are stable for the life of a process; a scheduled feed run is
// a fresh process each time, so a contract file appearing mid-quarter is picked
// up on the next run.
const fileCache = new Map<string, string>()

/** Canonical `<ROOT><CODE>.CME.scid`, swapped for the real on-disk spelling if
 *  the canonical one doesn't resolve. Falls back to canonical when the data dir
 *  is unreadable (e.g. a cloud build that never touches .scid at all). */
function resolveFile(dataDir: string, root: ContractRoot, code: string): string {
  const canonical = `${root}${code}.CME.scid`
  const key = `${dataDir}|${canonical}`
  const hit = fileCache.get(key)
  if (hit) return hit
  let name = canonical
  try {
    if (!existsSync(join(dataDir, canonical))) {
      const want = canonical.toLowerCase()
      const match = readdirSync(dataDir).find(n => n.toLowerCase() === want)
      if (match) name = match
    }
  } catch {
    // Data dir missing/unreadable — keep the canonical name.
  }
  fileCache.set(key, name)
  return name
}

/** The full roll table for a root, files resolved against `dataDir`. */
export function contractsForRoot(root: ContractRoot, dataDir: string = SIERRA_DATA_DIR): Contract[] {
  return ROLLS.map(r => ({ roll: r.roll, file: resolveFile(dataDir, root, r.code) }))
}

/** Front-month `.scid` filename for a YYYY-MM-DD date, or null past the end of
 *  the table. */
export function contractFileForRoot(
  root: ContractRoot,
  date: string,
  dataDir: string = SIERRA_DATA_DIR,
): string | null {
  for (const r of ROLLS) if (r.roll > date) return resolveFile(dataDir, root, r.code)
  return null
}

/** The roll date that brought `date`'s contract in, or null for the first
 *  contract in the table (nothing precedes it) / past the end. */
export function rollInForRoot(root: ContractRoot, date: string): string | null {
  for (let i = 0; i < ROLLS.length; i++) {
    if (ROLLS[i].roll > date) return i === 0 ? null : ROLLS[i - 1].roll
  }
  return null
}
