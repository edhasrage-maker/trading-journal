/**
 * Shared NQ front-month tick access for the local research/backfill scripts.
 *
 * The roll table and the isNQ test were copy-pasted in
 * scripts/backfill-excursion-ticks.ts and scripts/backfill-structure-regime.ts;
 * this is the same table factored out so new scripts stop adding copies. Those
 * two still carry their own inline versions — adopting this module there is a
 * follow-up, not a drive-by (they're long-running backfills and the parallel
 * session touches that area).
 *
 * Method note (why NQ ticks serve MNQ trades too): distances are always measured
 * WITHIN the tick series and then anchored to the trade's own price, so any
 * MNQ/NQ or calendar-roll basis cancels out.
 */
import { makeTickReader } from '../src/lib/scid-reader.ts'

/** Sierra Chart data root on this machine. */
export const SC_DATA_DIR = 'D:/SierraCharts/Data'

/** Each file is front-month over [previous roll, this roll). */
const CONTRACTS: { roll: string; file: string }[] = [
  { roll: '2023-03-09', file: 'NQH3.CME.scid' }, { roll: '2023-06-08', file: 'NQM3.CME.scid' },
  { roll: '2023-09-07', file: 'NQU3.CME.scid' }, { roll: '2023-12-07', file: 'NQZ3.CME.scid' },
  { roll: '2024-03-07', file: 'NQH4.CME.scid' }, { roll: '2024-06-13', file: 'NQM4.CME.scid' },
  { roll: '2024-09-12', file: 'NQU4.CME.scid' }, { roll: '2024-12-12', file: 'NQZ4.CME.scid' },
  { roll: '2025-03-13', file: 'NQH5.CME.scid' }, { roll: '2025-06-12', file: 'NQM5.CME.scid' },
  { roll: '2025-09-11', file: 'NQU5.CME.scid' }, { roll: '2025-12-11', file: 'NQz5.CME.scid' },
  { roll: '2026-03-12', file: 'NQH6.CME.scid' }, { roll: '2026-06-11', file: 'NQM6.CME.scid' },
  { roll: '2026-09-11', file: 'NQU6.CME.scid' },
]

/** Front-month .scid filename for a trade date (YYYY-MM-DD), or null if past the table. */
export function contractFor(dateISO: string): string | null {
  for (const c of CONTRACTS) if (dateISO < c.roll) return c.file
  return null
}

/** NQ family (NQ / MNQ) — the only root with full local .scid coverage. */
export const isNQ = (sym: string | null | undefined): boolean => !!sym && /(^|[^A-Z])M?NQ/i.test(sym)

const readers = new Map<string, ReturnType<typeof makeTickReader>>()

/** Cached tick reader per contract file. */
export function tickReader(file: string) {
  let r = readers.get(file)
  if (!r) { r = makeTickReader(`${SC_DATA_DIR}/${file}`); readers.set(file, r) }
  return r
}

/** Ticks (chronological prices) in [startMs, endMs) for a trade date, or null when
 *  the date has no contract mapping / the file can't be read. */
export function ticksFor(dateISO: string, startMs: number, endMs: number): number[] | null {
  const file = contractFor(dateISO)
  if (!file) return null
  try { return tickReader(file).read(startMs, endMs) } catch { return null }
}
