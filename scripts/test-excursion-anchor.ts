/**
 * Unit tests for anchoring an excursion window to the trade's own fills
 * (src/lib/excursion-guard.ts) and the two readers that measure off it.
 *   npx tsx scripts/test-excursion-anchor.ts
 *
 * The case this exists for is real: 2026-08-13, a long filled at 7820.00 whose
 * stored high-during-position was 7819.75 — a window that excludes a price the
 * position demonstrably traded at.
 */
import { anchorExcursionToFills, EXCURSION_TOLERANCE_POINTS } from '../src/lib/excursion-guard.ts'
import { mfeMaePoints } from '../src/lib/analytics.ts'
import { interpretExcursion } from '../src/lib/trade-excursion.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('THE REAL CASE — a long whose recorded high sits below its entry')
{
  const r = anchorExcursionToFills(7819.75, 7817, 7820, 7817)
  check('high pulled up to the entry', r.high === 7820, JSON.stringify(r))
  check('low untouched', r.low === 7817)
}

console.log('\nBOTH FILLS BELONG INSIDE THE WINDOW')
{
  const r = anchorExcursionToFills(100, 99, 98, 101)
  check('entry widens the low', r.low === 98)
  check('exit widens the high', r.high === 101)
}
{
  const r = anchorExcursionToFills(100, 90, 95, 92)
  check('a window that already contains both fills is unchanged', r.high === 100 && r.low === 90)
}

console.log('\nA CONTRADICTORY WINDOW IS LEFT ALONE, NOT STRETCHED')
{
  // The wrong-contract case: a fill hundreds of points outside its window.
  // Swallowing it would manufacture a vast excursion AND hide the contradiction
  // the integrity guards look for.
  const r = anchorExcursionToFills(28000, 27990, 27700, 27710)
  check('range untouched beyond tolerance', r.high === 28000 && r.low === 27990, JSON.stringify(r))
}
{
  const justInside = anchorExcursionToFills(100, 99, 99 - EXCURSION_TOLERANCE_POINTS, null)
  check('a miss exactly at the tolerance still anchors', justInside.low === 99 - EXCURSION_TOLERANCE_POINTS)
  const justOutside = anchorExcursionToFills(100, 99, 99 - EXCURSION_TOLERANCE_POINTS - 0.25, null)
  check('one tick past it does not', justOutside.low === 99)
}

console.log('\nMISSING PRICES CANNOT CONTRADICT A WINDOW')
{
  const r = anchorExcursionToFills(100, 99, null, undefined)
  check('null fills leave the range as-is', r.high === 100 && r.low === 99)
}

console.log('\nBOTH READERS AGREE ON THE SAME TRADE')
{
  const trade = {
    id: 't1', direction: 'long' as const, entry_price: 7820, exit_price: 7817,
    stop_price: 7815, pnl: -150, quantity: 10, symbol: 'MESU6.CME',
    high_during_position: 7819.75, low_during_position: 7817,
  }
  const pts = mfeMaePoints(trade)
  const interp = interpretExcursion(trade)
  check('dashboard MFE is 0 (never traded above entry)', pts?.mfe === 0, String(pts?.mfe))
  check('dashboard MAE is the full 3 points', pts?.mae === 3, String(pts?.mae))
  check('coach agrees on MFE', interp.mfePts === 0, String(interp.mfePts))
  check('coach agrees on MAE', interp.maePts === 3, String(interp.maePts))
}
{
  // A winner whose exit printed past the recorded high: the exit IS a traded
  // price, so the favorable excursion must reach it.
  const trade = {
    id: 't2', direction: 'long' as const, entry_price: 100, exit_price: 105,
    stop_price: 98, pnl: 250, quantity: 10, symbol: 'MESU6.CME',
    high_during_position: 104, low_during_position: 99,
  }
  check('MFE reaches the exit, not the stale high', mfeMaePoints(trade)?.mfe === 5, String(mfeMaePoints(trade)?.mfe))
  check('coach agrees', interpretExcursion(trade).mfePts === 5)
}

console.log(failures === 0 ? '\nAll excursion-anchor tests pass.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
