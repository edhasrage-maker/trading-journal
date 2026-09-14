/**
 * Tests for the session volume profile (src/lib/volume-profile.ts and the
 * .scid reader in src/lib/scid-volume-profile.ts).
 *   npx tsx scripts/test-volume-profile.ts
 * Plain tsx asserts; exits non-zero if anything failed.
 *
 * The headline case is a REAL session: ES RTH 2026-09-14, read tick by tick
 * from Sierra, whose POC matches the one Sierra draws on that day.
 */
import { readFileSync, existsSync } from 'fs'
import { valueArea, fromTuples, PROFILE_RTH, type ProfileRow, type ProfileRowTuple } from '../src/lib/volume-profile.ts'
import { readScidVolumeAtPrice } from '../src/lib/scid-volume-profile.ts'
import { ptDateSodToUtcMs } from '../src/lib/pt-time.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/es-2026-09-14-rth-vap.json', import.meta.url), 'utf8')) as {
  expect: { poc: number; vah: number; val: number; total: number; rows: number }
  rows: ProfileRowTuple[]
}
const esRows = fromTuples(fixture.rows)

console.log('REAL SESSION — ES RTH 2026-09-14, tick-true')
const va = valueArea(esRows)
check('POC is 7,625 — the level Sierra draws', va?.poc === fixture.expect.poc, `got ${va?.poc}`)
check('VAH is 7,644.75', va?.vah === fixture.expect.vah, `got ${va?.vah}`)
check('VAL is 7,612.25', va?.val === fixture.expect.val, `got ${va?.val}`)
check('total volume is every contract, 562,124', va?.total === fixture.expect.total, `got ${va?.total}`)

// The 7,634 row is where a 1-minute-bar approximation put the POC that day.
// Pin the true ranking so nobody "simplifies" this back to smeared bars.
const at = (p: number) => esRows.find(r => r.price === p)?.volume ?? -1
check('true POC out-trades the approximation\'s POC by a clear margin', at(7625) > at(7634) * 1.3,
  `7625=${at(7625)} vs 7634=${at(7634)}`)

console.log('\nVALUE AREA MECHANICS')
const row = (price: number, volume: number): ProfileRow => ({ price, volume, ask: 0, bid: 0 })
check('no rows → null', valueArea([]) === null)
check('all-zero volume → null', valueArea([row(1, 0), row(2, 0)]) === null)
const single = valueArea([row(100, 50)])
check('one row is its own POC, VAH and VAL', single?.poc === 100 && single.vah === 100 && single.val === 100)
// POC 10 in the middle; the side above wins ties.
const tie = valueArea([row(9, 10), row(10, 80), row(11, 10)], 0.85)
check('a tie expands upward first', tie?.vah === 11 && tie?.val === 10, `got ${tie?.val}-${tie?.vah}`)
// Heavier side below should be taken first.
const skew = valueArea([row(8, 30), row(9, 40), row(10, 100), row(11, 5), row(12, 5)])
check('expands toward the heavier neighbour', skew?.val === 9 && skew?.vah === 10, `got ${skew?.val}-${skew?.vah}`)

console.log('\nSCID READER — against the real file (skipped where absent)')
const scid = 'D:\\SierraCharts\\Data\\ESU6.CME.scid'
if (!existsSync(scid)) {
  console.log('  – ESU6.CME.scid not on this machine; reader not exercised')
} else {
  const start = ptDateSodToUtcMs('2026-09-14', PROFILE_RTH.startSec)
  const end = ptDateSodToUtcMs('2026-09-14', PROFILE_RTH.endSec)
  const { rows, trades } = readScidVolumeAtPrice(scid, start, end)
  const same = rows.length === esRows.length && rows.every((r, i) =>
    r.price === esRows[i].price && r.volume === esRows[i].volume && r.ask === esRows[i].ask && r.bid === esRows[i].bid)
  check(`reader reproduces the fixture row-for-row (${rows.length} rows, ${trades.toLocaleString()} trades)`, same,
    `rows=${rows.length} first=${JSON.stringify(rows[0])}`)
}

if (failures > 0) { console.error(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
