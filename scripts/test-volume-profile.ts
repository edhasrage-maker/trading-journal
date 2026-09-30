/**
 * Tests for the session volume profile (src/lib/volume-profile.ts and the
 * .scid reader in src/lib/scid-volume-profile.ts).
 *   npx tsx scripts/test-volume-profile.ts
 * Plain tsx asserts; exits non-zero if anything failed.
 *
 * The headline cases are REAL sessions: ES RTH and overnight ETH for
 * 2026-09-14, read tick by tick from Sierra, whose POCs match the ones Sierra
 * draws on that day.
 */
import { readFileSync, existsSync } from 'fs'
import {
  valueArea, fromTuples, profileWindowMs, deltaCells, pickDeltaGroup, formatDelta, PROFILE_RTH,
  type ProfileRow, type ProfileRowTuple,
} from '../src/lib/volume-profile.ts'
import { anchorSlot } from '../src/components/charts/VolumeProfilePrimitive.ts'
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

console.log('\nREAL SESSION — ES overnight ETH for 2026-09-14 (Sun 15:00 → 06:30 PT)')
const ethFixture = JSON.parse(readFileSync(new URL('./fixtures/es-2026-09-14-eth-vap.json', import.meta.url), 'utf8')) as {
  expect: { poc: number; vah: number; val: number; total: number; rows: number; low: number; high: number; trades: number }
  rows: ProfileRowTuple[]
}
const ethRows = fromTuples(ethFixture.rows)
const ethVa = valueArea(ethRows)
check('overnight POC is 7,607.50 — Sierra\'s left profile', ethVa?.poc === 7607.5, `got ${ethVa?.poc}`)
check('overnight VA is 7,596.00–7,617.25', ethVa?.val === 7596 && ethVa?.vah === 7617.25, `got ${ethVa?.val}–${ethVa?.vah}`)
// Top and bottom rows are the overnight extremes — Sierra's ONL / ONH lines that day.
check('overnight range is ONL 7,593.75 → ONH 7,634.50',
  ethRows[0].price === 7593.75 && ethRows[ethRows.length - 1].price === 7634.5,
  `got ${ethRows[0].price}–${ethRows[ethRows.length - 1].price}`)
check('overnight total is 164,559 contracts', ethVa?.total === 164559, `got ${ethVa?.total}`)

console.log('\nSESSION WINDOWS')
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16)
const rthW = profileWindowMs('rth', '2026-09-14')
check('RTH is 06:30–13:15 PDT', iso(rthW.startMs) === '2026-09-14T13:30' && iso(rthW.endMs) === '2026-09-14T20:15',
  `${iso(rthW.startMs)} → ${iso(rthW.endMs)}`)
const ethW = profileWindowMs('eth', '2026-09-14')
check('Monday\'s ETH opens Sunday 15:00 PDT and ends where RTH starts',
  iso(ethW.startMs) === '2026-09-13T22:00' && ethW.endMs === rthW.startMs, `${iso(ethW.startMs)} → ${iso(ethW.endMs)}`)
// DST ends 2026-11-01 02:00: the evening before is PDT, the 06:30 end is PST.
const dstW = profileWindowMs('eth', '2026-11-02')
check('across the fall-back weekend both ends stay on the PT clock',
  iso(dstW.startMs) === '2026-11-01T23:00' && iso(dstW.endMs) === '2026-11-02T14:30', `${iso(dstW.startMs)} → ${iso(dstW.endMs)}`)
const dstEdge = profileWindowMs('eth', '2026-11-01')
check('a window spanning the switch itself: 15:00 PDT → 06:30 PST',
  iso(dstEdge.startMs) === '2026-10-31T22:00' && iso(dstEdge.endMs) === '2026-11-01T14:30', `${iso(dstEdge.startMs)} → ${iso(dstEdge.endMs)}`)

console.log('\nCHART ANCHOR — where 06:30 lands on the candle axis')
const at0630 = ethW.endMs / 1000
const bars = (fromSec: number, stepSec: number, n: number) => Array.from({ length: n }, (_, k) => fromSec + k * stepSec)
const five = bars(at0630 - 30 * 60, 300, 13)                    // 06:00 … 07:00, 5m
const s5 = anchorSlot(five, at0630, 300)
check('5m: the 06:30 candle\'s left edge', s5?.i === 6 && s5.frac === 0, JSON.stringify(s5))
const hourly = bars(at0630 - 90 * 60, 3600, 4)                  // 05:00, 06:00, 07:00, 08:00
const s60 = anchorSlot(hourly, at0630, 3600)
check('60m: halfway across the 06:00 candle', s60?.i === 1 && s60.frac === 0.5, JSON.stringify(s60))
const gapped = [at0630 - 600, at0630 + 600]                     // 06:20, then 06:40
const sGap = anchorSlot(gapped, at0630, 300)
check('a gap at 06:30 snaps to the next candle\'s left edge', sGap?.i === 1 && sGap.frac === 0, JSON.stringify(sGap))
const preOpen = bars(at0630 - 3600, 300, 7)                     // 05:30 … 06:00, still overnight
const sPre = anchorSlot(preOpen, at0630, 300)
check('before the open: extrapolated past the last candle', sPre?.i === 6 && sPre.frac === 6, JSON.stringify(sPre))
check('no candles → no anchor', anchorSlot([], at0630, 300) === null)

console.log('\nDELTA COLUMN — against the numbers in Sierra\'s own delta column (ES RTH 2026-09-14)')
// Read off the founder's Sierra screenshot, one point (4 ticks) per cell. 24 of
// the 25 legible numbers match; the 25th (7,623) sits where price was still
// trading when the screenshot was taken, so it is left out rather than forced.
const SIERRA_DELTA: Record<number, number> = {
  7651: 210, 7650: 166, 7649: -168, 7648: -110, 7643: -289, 7642: 488, 7641: 458, 7640: 515,
  7639: 751, 7638: -94, 7629: 408, 7620: 573, 7619: -145, 7618: -109, 7616: -258, 7615: 162,
  7614: 643, 7611: 237, 7608: 152, 7606: 227, 7603: -146, 7602: -161, 7601: 784, 7595: -197,
}
const pointCells = new Map(deltaCells(fixture.rows, 0.25, 4).map(c => [c.price, c]))
const misses = Object.entries(SIERRA_DELTA).filter(([p, d]) => pointCells.get(Number(p))?.delta !== d)
check(`all ${Object.keys(SIERRA_DELTA).length} Sierra delta numbers reproduced`, misses.length === 0,
  misses.map(([p, d]) => `${p}: Sierra ${d}, ours ${pointCells.get(Number(p))?.delta}`).join('; '))
const c7651 = pointCells.get(7651)
check('a 1-point cell runs x.50 → x+1.25 (7,651 holds 7,650.50–7,651.25)', c7651?.lo === 7650.5 && c7651?.hi === 7651.25,
  `${c7651?.lo}–${c7651?.hi}`)
const allTicks = deltaCells(fixture.rows, 0.25, 1)
const sum = (cs: { delta: number }[]) => cs.reduce((a, c) => a + c.delta, 0)
check('grouping never gains or loses a contract', sum(allTicks) === sum([...pointCells.values()]) && sum(allTicks) === sum(deltaCells(fixture.rows, 0.25, 40)))
check('one cell per row at 1 tick', allTicks.length === fixture.rows.length)
check('cell size: 3.5px ticks → 4 ticks for a 13px cell', pickDeltaGroup(3.5, 13) === 4, String(pickDeltaGroup(3.5, 13)))
check('cell size: tall ticks stay 1 per cell', pickDeltaGroup(20, 13) === 1)
check('cell size: zoomed far out caps at 100 points', pickDeltaGroup(0.001, 13) === 400)
check('numbers: 784 / -1959 / 12.3k / -123k', formatDelta(784) === '784' && formatDelta(-1959) === '-1959' &&
  formatDelta(12345) === '12.3k' && formatDelta(-123456) === '-123k')

if (failures > 0) { console.error(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
