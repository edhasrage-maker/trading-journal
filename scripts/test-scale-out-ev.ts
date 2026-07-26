/**
 * Unit tests for the scale-out EV deep dive + the fill-fragment grouper
 * (src/lib/deep-dive/scale-out-ev.ts, exit-events.ts).
 *   npx tsx scripts/test-scale-out-ev.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import { groupExitEvents } from '../src/lib/deep-dive/exit-events.ts'
import { analyzeScaleOutEv, type ScaleOutTrade } from '../src/lib/deep-dive/scale-out-ev.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('exit-events (fill-fragment grouping)')

// The real prod row: one market exit filled in four pieces at the same ms.
const fragments = [
  { qty: 3, time: '2026-02-04T17:12:02.872Z', price: 25005.25 },
  { qty: 7, time: '2026-02-04T17:12:02.872Z', price: 25005 },
  { qty: 9, time: '2026-02-04T17:12:02.872Z', price: 25004.75 },
  { qty: 1, time: '2026-02-04T17:12:02.872Z', price: 25004.5 },
]
const oneEvent = groupExitEvents(fragments)
check('same-timestamp fills collapse to ONE event', oneEvent.length === 1)
check('event qty is the sum', oneEvent[0]?.qty === 20)
check('event price is qty-weighted', Math.abs(oneEvent[0]!.price - (3 * 25005.25 + 7 * 25005 + 9 * 25004.75 + 1 * 25004.5) / 20) < 1e-9)
check('records how many fills merged', oneEvent[0]?.fills === 4)

// Two real scale-outs, each split into fills (the 8-leg prod row's shape).
const twoClusters = groupExitEvents([
  { qty: 3, time: '2026-04-16T15:35:16.376Z', price: 26497 },
  { qty: 5, time: '2026-04-16T15:35:16.376Z', price: 26497 },
  { qty: 2, time: '2026-04-16T15:42:28.040Z', price: 26483.5 },
  { qty: 4, time: '2026-04-16T15:42:28.042Z', price: 26483.5 },
])
check('separate exits stay separate', twoClusters.length === 2)
check('first event totals its fills', twoClusters[0]?.qty === 8)
check('second event totals its fills', twoClusters[1]?.qty === 6)
check('drops unusable fills', groupExitEvents([{ qty: 0, time: 'nope', price: 1 }]).length === 0)

console.log('scale-out-ev')

// 20 identical trades per shape. MNQ ⇒ $2/point, entry 100, long.
const build = (events: { qty: number; price: number; minute: number }[], n = 20): ScaleOutTrade[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    direction: 'long' as const,
    entryPrice: 100,
    symbol: 'MNQM6.CME',
    fills: events.map(e => ({ qty: e.qty, price: e.price, time: `2026-06-0${(i % 9) + 1}T16:${String(e.minute).padStart(2, '0')}:00Z` })),
  }))

// Runner gives it all back: 3 lots +10, then 2 lots back at entry.
// actual = 3×10×2 = 60 | all-out-at-TP1 = 5×10×2 = 100 | all-ride = 0
const badRunner = analyzeScaleOutEv(build([{ qty: 3, price: 110, minute: 10 }, { qty: 2, price: 100, minute: 20 }]))
check('detects a -EV scale-out', badRunner !== null)
check('proposes taking the full size at the first target', !!badRunner?.test && /full position off at your first target/.test(badRunner.test.rule))
check('impact = 20 × ($100 − $60) = $800', badRunner?.test?.impactUsd === 800)
check('segments order: TP1 / actual / ride', badRunner?.segments.map(s => s.value).join(',') === '2000,1200,0')
check('reports 0% runner conversion', !!badRunner?.detail.some(d => /runner paid on 0 of 20 \(0%\)/.test(d)))
check('severity is meaningful', (badRunner?.severity ?? 0) > 0.3)

// Runners convert: 3 lots +10, 2 lots +30. all-ride (5×30×2 = 300) wins.
const goodRunner = analyzeScaleOutEv(build([{ qty: 3, price: 110, minute: 10 }, { qty: 2, price: 130, minute: 25 }]))
check('detects converting runners', !!goodRunner && /runners DO convert/.test(goodRunner.headline))
check('impact = 20 × ($300 − $180) = $2,400', goodRunner?.test?.impactUsd === 2400)
check('reports 100% conversion', !!goodRunner?.detail.some(d => /runner paid on 20 of 20 \(100%\)/.test(d)))

// Actual scale-out beats BOTH alternatives (the bulk came off at the peak).
const scalingWins = analyzeScaleOutEv(build([
  { qty: 1, price: 110, minute: 10 }, { qty: 5, price: 130, minute: 20 }, { qty: 1, price: 105, minute: 30 },
]))
check('confirms a +EV scale-out', !!scalingWins && /best of the three exits/.test(scalingWins.headline))
check('confirmation carries no test', scalingWins?.test === undefined)
check('confirmation is low severity', scalingWins?.severity === 0.08)

// GUARD: fill fragments of a single exit are NOT a scale-out.
const fragmentsOnly = analyzeScaleOutEv(Array.from({ length: 20 }, (_, i) => ({
  id: `f${i}`, direction: 'long' as const, entryPrice: 100, symbol: 'MNQM6.CME',
  fills: [
    { qty: 3, price: 110, time: `2026-06-0${(i % 9) + 1}T16:10:02.872Z` },
    { qty: 7, price: 110.25, time: `2026-06-0${(i % 9) + 1}T16:10:02.872Z` },
    { qty: 5, price: 109.75, time: `2026-06-0${(i % 9) + 1}T16:10:03.100Z` },
  ],
})))
check('same-order fill fragments are not scored as scaling', fragmentsOnly === null)

// A first exit taken at a LOSS is bailing in pieces, not scaling out.
check('excludes trades whose first exit was underwater',
  analyzeScaleOutEv(build([{ qty: 3, price: 95, minute: 10 }, { qty: 2, price: 90, minute: 20 }])) === null)

check('null under the sample floor', analyzeScaleOutEv(build([{ qty: 3, price: 110, minute: 10 }, { qty: 2, price: 100, minute: 20 }], 14)) === null)

// Shorts mirror longs: entry 100, 3 lots out at 90 (+10), 2 back at 100 (flat).
const shortBad = analyzeScaleOutEv(build([{ qty: 3, price: 90, minute: 10 }, { qty: 2, price: 100, minute: 20 }]).map(t => ({ ...t, direction: 'short' as const })))
check('shorts are scored in the trade\'s own direction', shortBad?.test?.impactUsd === 800)

// ATR-normalized "room beyond your first exit" line, when bars are present.
const withRoom = analyzeScaleOutEv(build([{ qty: 3, price: 110, minute: 10 }, { qty: 2, price: 100, minute: 20 }])
  .map(t => ({ ...t, favorableExtreme: 112, atrPts: 20 })))
check('adds the beyond-target room line (0.10×ATR)', !!withRoom?.detail.some(d => /0\.10×ATR more/.test(d)))
check('and calls out exhaustion under 0.25×ATR', !!withRoom?.detail.some(d => /exhaustion point/.test(d)))

console.log(failures === 0 ? '\nAll scale-out-ev tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
