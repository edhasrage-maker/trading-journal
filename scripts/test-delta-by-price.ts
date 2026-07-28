/**
 * Unit tests for the PURE delta-by-price detector (src/lib/delta-by-price.ts).
 *   npx tsx scripts/test-delta-by-price.ts
 * Plain tsx asserts; exits non-zero if anything failed.
 *
 * Everything here runs on synthetic rows so the suite has no dependency on a
 * .scid file — tapescore.app has none, and `npm test` has to pass there.
 *
 * The GOLDEN FIXTURE below (real ESU6 ticks) is the one exception, and it
 * SKIPS when the file is absent rather than failing. It is the regression that
 * matters most: it pins the exact numbers the architecture was argued from, so
 * if the reader's binning or the percentile method ever drifts, the values that
 * settled "ticks over vision" stop matching and this says so.
 */
import { existsSync } from 'fs'
import {
  quantileLower, rowDeltaStats, zoneTotal, detectDeltaLevels, detectRevisitLevels,
  type DetectorConfig, type DetectedDeltaLevel,
} from '../src/lib/delta-by-price.ts'
import { readDeltaByPrice, type DeltaRow, type DeltaBar } from '../src/lib/scid-delta.ts'
import {
  matchTradeToLevels, matchTradesToLevels, type MatchConfig,
} from '../src/lib/delta-level-match.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** Build a row. `ms` is the row's last trade time. */
function row(price: number, delta: number, volume = 1000, ms = 0): DeltaRow {
  return {
    price, delta, volume, trades: 10, firstMs: ms, lastMs: ms,
    visits: [{ startMs: ms, endMs: ms, delta, volume }],
  }
}
/** A row whose delta arrived across explicit visits (for the revisit tests). */
function rowVisits(price: number, visits: { from: number; to: number; delta: number }[]): DeltaRow {
  const vs = visits.map(v => ({ startMs: v.from * MIN, endMs: v.to * MIN, delta: v.delta, volume: 1000 }))
  return {
    price,
    delta: vs.reduce((s, v) => s + v.delta, 0),
    volume: vs.length * 1000,
    trades: 10 * vs.length,
    firstMs: vs[0].startMs,
    lastMs: vs[vs.length - 1].endMs,
    visits: vs,
  }
}
/** A flat bar series at `price`, one per minute starting at `startMs`. */
function flatBars(startMs: number, count: number, price: number): DeltaBar[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: startMs + i * 60_000, high: price, low: price, close: price,
  }))
}

const MIN = 60_000

console.log('quantileLower')

check('empty array yields 0', quantileLower([], 0.99) === 0)
check('single element is every percentile', quantileLower([42], 0.99) === 42)
check('p=0 is the minimum', quantileLower([1, 2, 3, 4], 0) === 1)
check('p=1 is the maximum', quantileLower([1, 2, 3, 4], 1) === 4)
check('p is clamped above 1', quantileLower([1, 2, 3, 4], 5) === 4)
check('p is clamped below 0', quantileLower([1, 2, 3, 4], -5) === 1)
check('result is always an observed value', [0.13, 0.5, 0.77, 0.9].every(
  p => [1, 2, 3, 4].includes(quantileLower([1, 2, 3, 4], p))))

// THE degeneracy this method exists to avoid. With 69 rows (a normal session)
// textbook nearest-rank ceil(p*n) returns index 68 — the max — for p99. Any
// threshold equal to the max can only ever detect ONE level.
const sixtyNine = Array.from({ length: 69 }, (_, i) => i + 1)
check('p99 of 69 values is NOT the max (nearest-rank would be)',
  quantileLower(sixtyNine, 0.99) === 68 && sixtyNine[68] === 69)

console.log('rowDeltaStats')

const statRows = [row(1, -300), row(2, 100), row(3, -50), row(4, 900), row(5, 20)]
const st = rowDeltaStats(statRows)
check('stats use ABSOLUTE delta, so heavy selling counts', st.max === 900)
check('median of |{300,100,50,900,20}| is 100', st.median === 100)
check('count is the number of rows', st.count === 5)
check('empty rows give zeroed stats', rowDeltaStats([]).count === 0)

console.log('zoneTotal')

const zRows = [row(7465, -100, 10), row(7466, 500, 20), row(7467, -900, 30), row(7468, 40, 40)]
const z = zoneTotal(zRows, 7465, 7467)
check('zone bounds are inclusive on BOTH edges', z.rows === 3)
check('zone delta NETS opposing rows', z.delta === -500, `got ${z.delta}`)
check('zone volume sums', z.volume === 60)
check('a zone containing no rows is zero, not NaN', zoneTotal(zRows, 8000, 8100).delta === 0)
// A zone read is not its biggest row: -900 alone would overstate the lean.
check('zone total differs from its largest row', z.delta !== -900)

console.log('detectDeltaLevels — threshold is SESSION-RELATIVE')

// Same absolute delta (800), two different sessions. The point of the design:
// 800 is the standout of a quiet session and unremarkable in a heavy one.
const quiet = [...Array.from({ length: 20 }, (_, i) => row(7000 + i, (i % 2 ? 30 : -25))), row(7100, -800, 1000, 10 * MIN)]
const heavy = [...Array.from({ length: 20 }, (_, i) => row(7000 + i, (i % 2 ? 1500 : -1400))), row(7100, -800, 1000, 10 * MIN)]
const cfgBase: DetectorConfig = { rowHeight: 1, breakDistance: 1, holdWindowMs: 30 * MIN }
const bars = flatBars(10 * MIN + MIN, 10, 7100)

const quietRes = detectDeltaLevels(quiet, bars, cfgBase)
const heavyRes = detectDeltaLevels(heavy, bars, cfgBase)
check('-800 clears the bar in a quiet session',
  quietRes.levels.some(l => l.price === 7100), `threshold ${quietRes.threshold}`)
check('the SAME -800 does not clear it in a heavy session',
  !heavyRes.levels.some(l => l.price === 7100), `threshold ${heavyRes.threshold}`)
check('a fixed constant could not do this', quietRes.threshold !== heavyRes.threshold)

console.log('detectDeltaLevels — absorption vs continuation')

// Heavy SELLING at 7100 with price refusing to follow it down = absorption.
const sellRow = [row(7100, -2000, 5000, 10 * MIN), ...Array.from({ length: 20 }, (_, i) => row(7000 + i, 10))]
const held = detectDeltaLevels(sellRow, flatBars(11 * MIN, 10, 7100), cfgBase)
check('sellers with no follow-through = absorption',
  held.levels[0]?.kind === 'absorption', `got ${held.levels[0]?.kind}`)
check('side is read from the sign of delta', held.levels[0]?.side === 'sell')
check('followThrough is <= 0 when price never left the row',
  (held.levels[0]?.followThrough ?? 1) <= 0)

// Identical delta, price breaks down instead = continuation. Same number,
// opposite meaning — this is why the hold check is not optional.
const broke = detectDeltaLevels(sellRow, flatBars(11 * MIN, 10, 7090), cfgBase)
check('identical delta + price breaking = continuation',
  broke.levels[0]?.kind === 'continuation', `got ${broke.levels[0]?.kind}`)
check('followThrough measures the break distance',
  broke.levels[0]?.followThrough === 10, `got ${broke.levels[0]?.followThrough}`)

// A wick that does not clear breakDistance is NOT a break.
const wick = detectDeltaLevels(sellRow,
  flatBars(11 * MIN, 10, 7100).map((b, i) => (i === 2 ? { ...b, low: 7099.5 } : b)), cfgBase)
check('a wick inside breakDistance is still absorption',
  wick.levels[0]?.kind === 'absorption', `got ${wick.levels[0]?.kind}`)

console.log('detectDeltaLevels — buy rows measure from the row TOP')

// At row heights well above the tick this matters: measuring a buy row's break
// from its low edge would call it broken while price is still inside the row.
const buyRow = [row(7100, 2000, 5000, 10 * MIN), ...Array.from({ length: 20 }, (_, i) => row(7000 + i, -10))]
const cfg5: DetectorConfig = { rowHeight: 5, breakDistance: 1, holdWindowMs: 30 * MIN }
const insideRow = detectDeltaLevels(buyRow, flatBars(11 * MIN, 10, 7104), cfg5)
check('price still INSIDE a 5pt row is not a break',
  insideRow.levels[0]?.kind === 'absorption', `got ${insideRow.levels[0]?.kind}`)
const aboveRow = detectDeltaLevels(buyRow, flatBars(11 * MIN, 10, 7107), cfg5)
check('price clear of the row top IS a break',
  aboveRow.levels[0]?.kind === 'continuation', `got ${aboveRow.levels[0]?.kind}`)

console.log('detectDeltaLevels — refuses to guess')

// A row that trades at the very end of the window has nothing to be judged
// against. This is the real 7474.00 case in the golden fixture.
const lateBars = flatBars(11 * MIN, 2, 7100)  // fewer than minBarsAfter (3)
const late = detectDeltaLevels(sellRow, lateBars, cfgBase)
check('too little history after the row = unresolved',
  late.levels[0]?.kind === 'unresolved', `got ${late.levels[0]?.kind}`)
check('unresolved reports no followThrough', late.levels[0]?.followThrough === 0)
check('no bars at all = unresolved, never absorption',
  detectDeltaLevels(sellRow, [], cfgBase).levels[0]?.kind === 'unresolved')

console.log('detectDeltaLevels — edges')

check('a zero-delta row is never a level',
  detectDeltaLevels([row(7100, 0), row(7101, 0)], bars, cfgBase).levels.length === 0)
check('levels are ranked by |delta|, so sellers can outrank buyers',
  detectDeltaLevels(
    [row(7100, 900, 1000, MIN), row(7101, -2000, 1000, MIN), row(7102, 1500, 1000, MIN)],
    flatBars(2 * MIN, 10, 7100), { ...cfgBase, thresholdPercentile: 0 },
  ).levels.map(l => l.price).join(',') === '7101,7102,7100')
check('minDelta floors a thin session that would otherwise fire',
  detectDeltaLevels(
    Array.from({ length: 20 }, (_, i) => row(7000 + i, i % 2 ? 12 : -9)),
    bars, { ...cfgBase, minDelta: 500 },
  ).levels.length === 0)
check('strength is |delta| over the threshold',
  Math.abs((quietRes.levels[0]?.strength ?? 0) - 800 / quietRes.threshold) < 1e-9)
check('volumeShare is a fraction of session volume, not a percent',
  (held.levels[0]?.volumeShare ?? 0) <= 1)
check('empty input yields no levels and no NaN',
  detectDeltaLevels([], [], cfgBase).levels.length === 0 &&
  detectDeltaLevels([], [], cfgBase).sessionDelta === 0)

console.log('detectRevisitLevels — the trader is revisiting, not watching it print')

/** One bar per minute over [fromMin, toMin), at prices from `priceAt`. */
function barSeries(fromMin: number, toMin: number, priceAt: (m: number) => number): DeltaBar[] {
  const out: DeltaBar[] = []
  for (let m = fromMin; m < toMin; m++) {
    const p = priceAt(m)
    out.push({ ts: m * MIN, high: p, low: p, close: p })
  }
  return out
}
const rcfg = { rowHeight: 5, breakDistance: 5, minDeparture: 5, thresholdPercentile: 0 }
/** Filler rows so the percentile has a population to sit in. */
const filler = Array.from({ length: 20 }, (_, i) => rowVisits(7000 + i * 5, [{ from: 0, to: 5, delta: 10 }]))

// Aggression at 10-20, price leaves UP to 7130, comes back, entry at 60.
const sellThenUp = [rowVisits(7100, [{ from: 10, to: 20, delta: -2000 }, { from: 55, to: 60, delta: -50 }]), ...filler]
const upBars = barSeries(0, 60, m => (m < 20 ? 7102 : m < 45 ? 7130 : 7102))
const upRes = detectRevisitLevels(sellThenUp, upBars, 58 * MIN, rcfg)
check('a revisited level is detected', upRes.levels.some(l => l.price === 7100))
check('sellers that price refused to follow = absorption',
  upRes.levels.find(l => l.price === 7100)?.kind === 'absorption')
check('delta EXCLUDES the visit in progress',
  upRes.levels.find(l => l.price === 7100)?.delta === -2000, 'the -50 revisit leg must not count')
check('lastMs is when the AGGRESSION ended, not the revisit',
  upRes.levels.find(l => l.price === 7100)?.lastMs === 20 * MIN)
// Measured from the row INTERVAL, so from the 7105 top edge, not the 7100 low.
check('departure records how far price left the row',
  (upRes.levels.find(l => l.price === 7100)?.departure ?? 0) === 25)

// Identical aggression, price breaks DOWN instead.
const downBars = barSeries(0, 60, m => (m < 20 ? 7102 : m < 45 ? 7070 : 7102))
check('sellers that price followed = continuation',
  detectRevisitLevels(sellThenUp, downBars, 58 * MIN, rcfg)
    .levels.find(l => l.price === 7100)?.kind === 'continuation')

// Price never leaves the level: that is continuous trading, not a revisit.
const stuckBars = barSeries(0, 60, () => 7102)
check('no departure means no revisit level',
  detectRevisitLevels(sellThenUp, stuckBars, 58 * MIN, rcfg)
    .levels.find(l => l.price === 7100) === undefined)

// THE no-hindsight guarantee: bars at or after the entry are ignored, so a
// verdict can never be built from what happened once the trade was on.
const futureBars = [...barSeries(0, 25, m => (m < 20 ? 7102 : 7130)), ...barSeries(25, 60, () => 7000)]
check('bars at/after asOfMs are ignored',
  detectRevisitLevels(sellThenUp, futureBars, 25 * MIN, rcfg)
    .levels.find(l => l.price === 7100)?.kind === 'absorption',
  'the 7000 print is after asOfMs and must not flip this to continuation')

// A level whose aggression is still the current visit has nothing banked.
check('a level still printing has no banked delta',
  detectRevisitLevels(
    [rowVisits(7100, [{ from: 10, to: 60, delta: -2000 }]), ...filler],
    upBars, 30 * MIN, rcfg).levels.find(l => l.price === 7100) === undefined)

console.log('matchTradeToLevels')

/** A detected level, spelled out so the match gates can be driven directly. */
function lvl(price: number, delta: number, firstMin: number, lastMin = firstMin + 5): DetectedDeltaLevel {
  return {
    price, delta, volume: 5000,
    side: delta < 0 ? 'sell' : 'buy',
    kind: 'absorption',
    strength: 1.5, volumeShare: 0.03, followThrough: -1,
    firstMs: firstMin * MIN, lastMs: lastMin * MIN,
  }
}
const anchor = (price: number, min: number, direction: 'long' | 'short' | null = 'long') =>
  ({ id: 't1', entryMs: min * MIN, entryPrice: price, direction })
const mcfg: MatchConfig = { tickSize: 0.25, rowHeight: 1, maxTicks: 8, maxMinutes: 30 }

check('a level at the entry price matches',
  matchTradeToLevels(anchor(7100, 20), [lvl(7100, -2000, 10)], mcfg).length === 1)
check('distance is measured in TICKS, not points',
  matchTradeToLevels(anchor(7102, 20), [lvl(7100, -2000, 10)], mcfg)[0]?.distanceTicks === 4)
check('beyond maxTicks does not match',
  matchTradeToLevels(anchor(7104, 20), [lvl(7100, -2000, 10)], mcfg).length === 0)

// A level is an INTERVAL. On a 5pt row an entry near the top is 19 ticks from
// the low edge but is inside the level, and must read as distance 0.
const mcfg5: MatchConfig = { ...mcfg, rowHeight: 5 }
check('an entry INSIDE the row is distance 0',
  matchTradeToLevels(anchor(7104.75, 20), [lvl(7100, -2000, 10)], mcfg5)[0]?.distanceTicks === 0)
check('distance is measured to the NEAREST row edge',
  matchTradeToLevels(anchor(7106, 20), [lvl(7100, -2000, 10)], mcfg5)[0]?.distanceTicks === 4)
check('below the row measures off the LOW edge',
  matchTradeToLevels(anchor(7099, 20), [lvl(7100, -2000, 10)], mcfg5)[0]?.distanceTicks === 4)
check('a zero rowHeight throws', (() => {
  try { matchTradeToLevels(anchor(7100, 20), [lvl(7100, -2000, 10)], { ...mcfg, rowHeight: 0 }); return false }
  catch { return true }
})())

// Recency is anchored on the level's LAST print. A row aggregates the whole
// session and price revisits levels, so its first print is usually near the
// open and says nothing about whether the level was still live.
check('recency is measured from the level\'s LAST print',
  matchTradeToLevels(anchor(7100, 25), [lvl(7100, -2000, 10, 20)], mcfg)[0]?.ageMinutes === 5)
check('a level that last printed long ago is stale',
  matchTradeToLevels(anchor(7100, 200), [lvl(7100, -2000, 10, 20)], mcfg).length === 0)
check('a level forming since the open is still live if it JUST printed',
  matchTradeToLevels(anchor(7100, 200), [lvl(7100, -2000, 5, 195)], mcfg).length === 1)
check('formingMinutes still reports the full age of the level',
  matchTradeToLevels(anchor(7100, 200), [lvl(7100, -2000, 5, 195)], mcfg)[0]?.formingMinutes === 195)

// THE honesty gate. A row that only started printing after the entry cannot
// have informed it; matching on lastMs instead would credit hindsight, and
// these tags feed Entry scoring.
check('a level that STARTS after the entry is rejected',
  matchTradeToLevels(anchor(7100, 20), [lvl(7100, -2000, 25)], mcfg).length === 0)
check('...even though its lastMs is comfortably in range',
  lvl(7100, -2000, 25).lastMs / MIN === 30)
check('requireEstablished:false is the only way to see it',
  matchTradeToLevels(anchor(7100, 20), [lvl(7100, -2000, 25)],
    { ...mcfg, requireEstablished: false }).length === 1)

check('a LONG into a big SELL row is fading the aggressor',
  matchTradeToLevels(anchor(7100, 20, 'long'), [lvl(7100, -2000, 10)], mcfg)[0]?.againstAggressor === true)
check('a LONG into a big BUY row is following it',
  matchTradeToLevels(anchor(7100, 20, 'long'), [lvl(7100, 2000, 10)], mcfg)[0]?.againstAggressor === false)
check('a SHORT into a big BUY row is fading the aggressor',
  matchTradeToLevels(anchor(7100, 20, 'short'), [lvl(7100, 2000, 10)], mcfg)[0]?.againstAggressor === true)
check('no direction yields null, not a guess',
  matchTradeToLevels(anchor(7100, 20, null), [lvl(7100, -2000, 10)], mcfg)[0]?.againstAggressor === null)

const many = matchTradeToLevels(anchor(7100, 20),
  [lvl(7101, -900, 10), lvl(7100.25, -800, 10), lvl(7100.5, -1500, 10)], mcfg)
check('matches come back CLOSEST first', many[0]?.level.price === 7100.25)
check('all qualifying levels are returned', many.length === 3)
// 1pt rows: [7098,7099) and [7101,7102) are both exactly 1 point (4 ticks)
// from an entry at 7100, so only the tie-break can order them.
check('equal distance breaks toward the larger |delta|',
  matchTradeToLevels(anchor(7100, 20), [lvl(7098, -700, 10), lvl(7101, -1500, 10)], mcfg)[0]
    ?.level.delta === -1500)

check('tickSize scales the gate across instruments',
  matchTradeToLevels(anchor(7108, 20), [lvl(7100, -2000, 10)], { ...mcfg, tickSize: 1 }).length === 1)
check('a zero tickSize throws rather than dividing by zero', (() => {
  try { matchTradeToLevels(anchor(7100, 20), [lvl(7100, -2000, 10)], { ...mcfg, tickSize: 0 }); return false }
  catch { return true }
})())

const batch = matchTradesToLevels(
  [{ ...anchor(7100, 20), id: 'hit' }, { ...anchor(9999, 20), id: 'miss' }],
  [lvl(7100, -2000, 10)], mcfg)
check('unmatched trades are absent, not empty-arrayed',
  batch.has('hit') && !batch.has('miss') && batch.size === 1)

console.log('GOLDEN FIXTURE — ESU6 2026-07-28 13:30-17:30Z, 1pt rows')

const FIXTURE = 'D:/SierraCharts/Data/ESU6.CME.scid'
if (!existsSync(FIXTURE)) {
  console.log('  … skipped (no local .scid — expected off the trading machine)')
} else {
  const s = Date.parse('2026-07-28T13:30:00Z')
  const e = Date.parse('2026-07-28T17:30:00Z')
  const r = readDeltaByPrice(FIXTURE, s, e, { rowHeight: 1 })
  const stats = rowDeltaStats(r.rows)
  const at = (p: number) => r.rows.find(x => x.price === p)?.delta

  check('session delta +6,316', r.sessionDelta === 6316, `got ${r.sessionDelta}`)
  check('session volume 731,052', r.sessionVolume === 731052, `got ${r.sessionVolume}`)
  check('row |delta| median 276', stats.median === 276, `got ${stats.median}`)
  check('row |delta| p90 879', stats.p90 === 879, `got ${stats.p90}`)
  check('row |delta| p99 1,209', stats.p99 === 1209, `got ${stats.p99}`)
  check('7477.00 = +1,949', at(7477) === 1949, `got ${at(7477)}`)
  check('7474.00 = -1,209', at(7474) === -1209, `got ${at(7474)}`)
  check('7467.00 = -1,154', at(7467) === -1154, `got ${at(7467)}`)
  check('7468.00 = -1,152', at(7468) === -1152, `got ${at(7468)}`)

  // The absorption read the whole architecture was argued from.
  const zone = zoneTotal(r.rows, 7465, 7476)
  check('zone 7465-7476 delta = -1,465', zone.delta === -1465, `got ${zone.delta}`)
  check('zone is 27.2% of session volume',
    (zone.volume / r.sessionVolume * 100).toFixed(1) === '27.2',
    `got ${(zone.volume / r.sessionVolume * 100).toFixed(1)}%`)

  // Bin size IS the measurement: at the 0.25 tick the same selling fragments
  // across four rows and the largest print of the day shrinks by a third.
  const quarter = readDeltaByPrice(FIXTURE, s, e, { rowHeight: 0.25 })
  check('finer bins fragment the same flow into more rows',
    quarter.rows.length > r.rows.length * 3,
    `${quarter.rows.length} vs ${r.rows.length}`)
  check('finer bins SHRINK the largest row — the vision trap',
    rowDeltaStats(quarter.rows).max < stats.max,
    `0.25pt max ${rowDeltaStats(quarter.rows).max} vs 1pt max ${stats.max}`)
  check('total delta is identical regardless of bin size',
    quarter.sessionDelta === r.sessionDelta)

  // 7474 traded at 17:28:31, ~90s before the window closes.
  const det = detectDeltaLevels(r.rows, r.bars, { rowHeight: 1, breakDistance: 1 })
  check('7474 is unresolved, not guessed',
    det.levels.find(l => l.price === 7474)?.kind === 'unresolved')
  check('the session-relative threshold is p99, not the max',
    det.threshold === 1209 && det.threshold < stats.max)
}

console.log(failures === 0 ? '\nAll delta-by-price tests passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
