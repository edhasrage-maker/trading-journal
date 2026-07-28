/**
 * Derive the REAL front-month roll date per quarter, from local .scid volume.
 *
 * The roll table used to assume the textbook rule — 8 days before the quarterly
 * 3rd-Friday expiry. That is not when liquidity actually moves: measured against
 * the tick files, volume crosses over 4-5 sessions LATER. Using the early date
 * meant that for a few sessions each quarter the bar feed served the NEXT
 * contract's prices while trades were still filling in the old one, and the two
 * differ by the carry basis — ~295 NQ points in Dec 2024. Excursions computed in
 * those windows were nonsense (the high/low didn't even contain the fill price).
 *
 * Front month here = the contract with the greater session volume. The roll date
 * is the first session where the new contract wins and keeps winning (a single
 * crossover day that flips back doesn't count).
 *
 *   npx tsx scripts/derive-contract-rolls.ts          # NQ + ES
 *   npx tsx scripts/derive-contract-rolls.ts NQ       # one root
 *
 * Paste the printed table into src/lib/futures-contracts.ts. Re-run after adding
 * a new quarter's .scid, and re-feed any dates whose contract changed.
 */
import { readScidBars } from '../src/lib/scid-reader.ts'
import { sessionUtcWindow } from '../src/lib/pt-time.ts'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

const DIR = process.env.SIERRA_DATA_DIR || 'D:\\SierraCharts\\Data'
const CODES = ['H3', 'M3', 'U3', 'Z3', 'H4', 'M4', 'U4', 'Z4', 'H5', 'M5', 'U5', 'Z5', 'H6', 'M6', 'U6', 'Z6']
// Textbook roll (8 days before the quarterly 3rd-Friday expiry) — only used to
// centre the search window; the answer comes from volume.
const NOMINAL = ['2023-03-09', '2023-06-08', '2023-09-07', '2023-12-07', '2024-03-07', '2024-06-13',
  '2024-09-12', '2024-12-12', '2025-03-13', '2025-06-12', '2025-09-11', '2025-12-11',
  '2026-03-12', '2026-06-11', '2026-09-11', '2026-12-11']

function resolve(stem: string): string | null {
  const canonical = `${stem}.CME.scid`
  if (existsSync(join(DIR, canonical))) return canonical
  const want = canonical.toLowerCase()
  try { return readdirSync(DIR).find(n => n.toLowerCase() === want) ?? null } catch { return null }
}

function sessionVolume(file: string | null, date: string): number {
  if (!file) return 0
  const { startMs, endMs } = sessionUtcWindow(date)
  try {
    return readScidBars(join(DIR, file), startMs, endMs, { priceDivisor: 100 })
      .bars.reduce((a, b) => a + (b.volume || 0), 0)
  } catch { return 0 }
}

const addDays = (d: string, k: number) =>
  new Date(Date.parse(d + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10)
const isWeekday = (d: string) => { const k = new Date(d + 'T12:00:00Z').getUTCDay(); return k !== 0 && k !== 6 }

for (const root of (process.argv[2] ? [process.argv[2].toUpperCase()] : ['NQ', 'ES'])) {
  console.log(`\n// ${root} — measured volume crossover`)
  for (let i = 0; i < CODES.length; i++) {
    // Entry i's roll is when contract i STOPS being front-month (it is front
    // over [roll(i-1), roll(i))), so the handover to measure is i -> i+1.
    const oldFile = resolve(root + CODES[i])
    const newFile = i + 1 < CODES.length ? resolve(root + CODES[i + 1]) : null
    if (!oldFile || !newFile) {
      console.log(`  { roll: '${NOMINAL[i]}', code: '${CODES[i]}' },   // not measurable — no successor file yet`)
      continue
    }
    // Search from a week before the nominal roll to three weeks after. The roll
    // is dated to the FIRST of two consecutive sessions the new contract wins,
    // so a one-day blip can't move it but a real handover isn't delayed either.
    let found: string | null = null
    let firstWin: string | null = null
    let streak = 0
    for (let k = -7; k <= 21 && !found; k++) {
      const d = addDays(NOMINAL[i], k)
      if (!isWeekday(d)) continue
      const o = sessionVolume(oldFile, d), n = sessionVolume(newFile, d)
      // o === 0 means the OLD file simply stops carrying data (Sierra was no
      // longer charting it), not that volume moved — ESZ4 ends 2024-12-10, a
      // week before its real roll. Treating that as a crossover would date the
      // roll to the day the recording stopped.
      if (o === 0) continue
      if (o + n === 0) continue
      if (n > o) {
        streak++
        if (streak === 1) firstWin = d
        else if (streak === 2) found = firstWin
      } else {
        streak = 0
        firstWin = null
      }
    }
    const answer = found ?? NOMINAL[i]
    const drift = Math.round((Date.parse(answer) - Date.parse(NOMINAL[i])) / 86400000)
    console.log(`  { roll: '${answer}', code: '${CODES[i]}' },   // nominal ${NOMINAL[i]}${drift ? `, +${drift}d` : ''}`)
  }
}
