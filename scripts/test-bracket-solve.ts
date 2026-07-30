/**
 * Unit tests for the screenshot bracket reconciler (src/lib/bracket-solve.ts).
 *   npx tsx scripts/test-bracket-solve.ts
 * Plain tsx asserts; exits non-zero if anything failed.
 *
 * The headline cases are REAL extractions that came back wrong.
 */
import { solveBracket } from '../src/lib/bracket-solve.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('THE BUG — TP1 came back empty on a real MES short')

// 2026-07-30 trade #4. Entry and stop extracted fine; the limit order read
// "(+12.50p)" but its axis price never came through, so TP1 was null even
// though 7415.50 - 12.50 = 7403.00 was fully determined.
const real = solveBracket({
  direction: 'short',
  entry_price: 7415.5,
  stop_price: 7419.5,
  tp1_price: null,
  stop_points: 4,
  tp1_points: 12.5,
})
check('TP1 is solved from entry and the label distance', real.tp1_price === 7403,
  `got ${real.tp1_price}`)
check('entry is left alone when it already agrees', real.entry_price === 7415.5)
check('stop is left alone', real.stop_price === 7419.5)
check('the solve is reported', real.solved.includes('tp1'))

console.log('completing either leg, both directions')

check('short: a missing STOP is solved',
  solveBracket({ direction: 'short', entry_price: 7415.5, stop_price: null, stop_points: 4 })
    .stop_price === 7419.5)
check('long: a missing TP1 is solved ABOVE entry',
  solveBracket({ direction: 'long', entry_price: 100, tp1_price: null, tp1_points: 10 })
    .tp1_price === 110)
check('long: a missing STOP is solved BELOW entry',
  solveBracket({ direction: 'long', entry_price: 100, stop_price: null, stop_points: 4 })
    .stop_price === 96)
check('short: a missing TP1 is solved BELOW entry',
  solveBracket({ direction: 'short', entry_price: 100, tp1_price: null, tp1_points: 10 })
    .tp1_price === 90)

console.log('entry derivation — the original guard, still intact')

// Sierra's "Trade: Qty@PRICE" readout is the last TAPE PRINT, not the fill. A
// real case read 27859 there while the orders put the fill at 27855.
const tape = solveBracket({
  direction: 'long',
  entry_price: 27859,
  stop_price: 27834, stop_points: 21,
  tp1_price: 27876, tp1_points: 21,
})
check('a mis-read entry is overridden by the two labels', tape.entry_price === 27855,
  `got ${tape.entry_price}`)
check('the override is reported', tape.solved.includes('entry'))

check('one leg alone can still derive entry',
  solveBracket({ direction: 'long', entry_price: null, stop_price: 96, stop_points: 4 })
    .entry_price === 100)

// If the two legs disagree, one of four inputs is wrong and there is no way to
// tell which. Guessing would silently mis-state R.
const conflict = solveBracket({
  direction: 'long',
  entry_price: 100,
  stop_price: 96, stop_points: 4,     // → 100
  tp1_price: 120, tp1_points: 15,     // → 105
})
check('disagreeing legs do NOT override entry', conflict.entry_price === 100)
check('...and nothing is marked solved', !conflict.solved.includes('entry'))

console.log('refusing to invent')

check('no direction → everything passes through untouched', (() => {
  const r = solveBracket({ direction: null, entry_price: 100, tp1_points: 10 })
  return r.tp1_price === null && r.entry_price === 100 && r.solved.length === 0
})())
check('no entry and no derivable entry → no fill',
  solveBracket({ direction: 'long', entry_price: null, tp1_points: 10 }).tp1_price === null)
check('a present TP1 is never overwritten by the points',
  solveBracket({ direction: 'long', entry_price: 100, tp1_price: 108, tp1_points: 10 })
    .tp1_price === 108)
check('zero/negative distances are ignored, not treated as 0-width levels', (() => {
  const r = solveBracket({ direction: 'long', entry_price: 100, tp1_points: 0, stop_points: -5 })
  return r.tp1_price === null && r.stop_price === null
})())
check('a NaN distance does not produce NaN prices',
  solveBracket({ direction: 'long', entry_price: 100, tp1_points: NaN }).tp1_price === null)
check('empty input yields nulls, not NaN', (() => {
  const r = solveBracket({})
  return r.entry_price === null && r.stop_price === null && r.tp1_price === null
})())

console.log('geometry is a consequence, not an assumption')

// long: stop < entry < tp1 · short: tp1 < entry < stop
const L = solveBracket({ direction: 'long', entry_price: 100, stop_points: 4, tp1_points: 12 })
check('long solves to stop < entry < TP1',
  (L.stop_price ?? 0) < (L.entry_price ?? 0) && (L.entry_price ?? 0) < (L.tp1_price ?? 0),
  `${L.stop_price}/${L.entry_price}/${L.tp1_price}`)
const S = solveBracket({ direction: 'short', entry_price: 100, stop_points: 4, tp1_points: 12 })
check('short solves to TP1 < entry < stop',
  (S.tp1_price ?? 0) < (S.entry_price ?? 0) && (S.entry_price ?? 0) < (S.stop_price ?? 0),
  `${S.tp1_price}/${S.entry_price}/${S.stop_price}`)

check('fractional ticks survive without float dust',
  solveBracket({ direction: 'long', entry_price: 7413.25, tp1_points: 20.25 }).tp1_price === 7433.5)

console.log(failures === 0 ? '\nAll bracket-solve tests passed.' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
