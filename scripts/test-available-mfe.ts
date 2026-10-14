/**
 * Unit tests for MFE on the available position (src/lib/available-mfe.ts) and
 * the places that read it (trade management, the Exit "profit kept" factor,
 * the importer's per-leg value, the coach's excursion read).
 *   npx tsx scripts/test-available-mfe.ts
 */
import { availableMfePts, availableMfeDollars, availableMfePtsStored, exitEvents } from '../src/lib/available-mfe.ts'
import { tradeFacts, tradeMgmt } from '../src/lib/trade-management.ts'
import { perLegMaxDollars } from '../src/lib/analytics.ts'
import { interpretExcursion } from '../src/lib/trade-excursion.ts'
import { exitTradeScores } from '../src/lib/exit-score.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const near = (a: number | null | undefined, b: number, eps = 0.01) => a != null && Math.abs(a - b) <= eps

// The founder's trade, 2026-10-14 08:19 PT: 3 MNQ short at 30428, TP1 30398,
// 2 off at 30392.5 / 30391 (beyond TP1), the runner out at 30351 = the low.
const oct14 = {
  id: 'oct14', pnl: 299, direction: 'short' as const, entry_price: 30428, stop_price: 30442, tp1_price: 30398,
  exit_price: 30378.17, quantity: 3, symbol: 'MNQZ6.CME', entry_time: '2026-10-14T15:19:16.09Z',
  high_during_position: 30431, low_during_position: 30351, entry_atr_1m: 20.1, mfe_dollars_per_leg: null,
  exits_json: [
    { qty: 1, time: '2026-10-14T15:29:22.614Z', price: 30392.5 },
    { qty: 1, time: '2026-10-14T15:29:24.594Z', price: 30391 },
    { qty: 1, time: '2026-10-14T15:37:04.410Z', price: 30351 },
  ],
}
// The real 1m bars (NQ) while it was on. The 15:29 bar printed 30382.25 —
// in the minute the TP1 contracts came off, so it can't count against them.
const bars = [
  ['15:19', 30437.75, 30422.75], ['15:20', 30426.25, 30410.25], ['15:21', 30427.25, 30403.25],
  ['15:22', 30413, 30401.25], ['15:23', 30421.25, 30404.75], ['15:24', 30420.5, 30410],
  ['15:25', 30417.75, 30399.25], ['15:26', 30416, 30404.5], ['15:27', 30423.5, 30403.75],
  ['15:28', 30416.75, 30391.75], ['15:29', 30404, 30382.25], ['15:30', 30401, 30380.5],
  ['15:31', 30401.75, 30390.5], ['15:32', 30398.5, 30375], ['15:33', 30382.5, 30371],
  ['15:34', 30384.5, 30373.25], ['15:35', 30387.25, 30374.25], ['15:36', 30382, 30362.75],
  ['15:37', 30363.25, 30348.75],
].map(([m, high, low]) => ({ ts: `2026-10-14T${m}:00Z`, high: high as number, low: low as number }))

console.log('the Oct 14 scale-out')
{
  const fillOnly = availableMfePts(oct14, 77)
  check('scaled', fillOnly.scaled)
  check('fill-only: (35.5 + 37 + 77) / 3 contracts', near(fillOnly.pts, (35.5 + 37 + 77) / 3), String(fillOnly.pts))
  const withBars = availableMfePts(oct14, 77, bars)
  // The two TP1 fills, 1.98 s apart, are one exit of 2 at 30391.75 (36.25).
  // The last minute that closed while they were on (15:28) reached the same
  // 30391.75; the 15:29 low of 30382.25 printed in the minute they came off.
  check('TP1 fills merge into one exit', exitEvents(oct14.exits_json).length === 2)
  check('with bars: the 15:29 low does not count against TP1', near(withBars.pts, (36.25 * 2 + 77) / 3), String(withBars.pts))
  check('dollars for the store = everything banked', near(availableMfeDollars(oct14, 77, bars), 299))
  const f = tradeFacts(oct14)!
  check('trade management MFE = $299 (was $462)', near(f.mfe.dollars, 299), String(f.mfe.dollars))
  check('peak still the low (77 pts) for "went your way"', near(f.peakPts, 77))
  const m = tradeMgmt(oct14)!
  check('kept 100%', near(m.kept, 1), String(m.kept))
  check('went your way', m.went)
  check('importer per-leg value no longer null when two exits share a minute', perLegMaxDollars(oct14 as never, bars) != null)
  check('importer per-leg value ≤ the old full-position $462', (perLegMaxDollars(oct14 as never, bars) ?? 999) < 462)
  check('coach excursion: captured 100%', near(interpretExcursion(oct14).capPct, 1), String(interpretExcursion(oct14).capPct))
  check('Exit "profit kept" factor = 1', exitTradeScores(oct14).kept === 1)
}

console.log('exit events')
{
  const ev = exitEvents([
    { qty: 2, time: '2026-01-01T15:00:00.000Z', price: 100 },
    { qty: 1, time: '2026-01-01T15:00:01.200Z', price: 101 },
    { qty: 3, time: '2026-01-01T15:05:00.000Z', price: 110 },
  ])
  check('fragments within 2 s merge into one exit', ev.length === 2 && ev[0].qty === 3)
  check('merged price is quantity-weighted', near(ev[0].price, (2 * 100 + 101) / 3))
  check('junk legs are dropped', exitEvents([{ qty: 0, time: 'x', price: 1 }, null]).length === 0)
}

console.log('one exit — unchanged')
{
  const single = { ...oct14, pnl: 3 * 2 * 40, exits_json: [{ qty: 3, time: '2026-10-14T15:37:04Z', price: 30388 }] }
  const r = availableMfePts(single, 77)
  check('not scaled, the position best', !r.scaled && r.pts === 77)
  check('runner split into fragments is still one exit', !availableMfePts({ ...oct14, exits_json: [
    { qty: 2, time: '2026-10-14T15:37:04.100Z', price: 30360 }, { qty: 1, time: '2026-10-14T15:37:04.900Z', price: 30360 },
  ] }, 77).scaled)
  check('no exits_json → the position best', availableMfePts({ ...oct14, exits_json: null }, 77).pts === 77)
}

console.log('earlier contracts that came off at a loss')
{
  // Long 2 at 100; 1 out at 98 (loss) then 1 out at 104; the best price 110.
  const t = { direction: 'long', entry_price: 100, entry_time: '2026-01-01T15:00:00Z', exits_json: [
    { qty: 1, time: '2026-01-01T15:10:00Z', price: 98 }, { qty: 1, time: '2026-01-01T15:20:00Z', price: 104 },
  ] }
  check('without bars it sat through the peak', near(availableMfePts(t, 10).pts, 10))
  const b = [{ ts: '2026-01-01T15:01:00Z', high: 103, low: 99 }, { ts: '2026-01-01T15:12:00Z', high: 110, low: 104 }]
  check('with bars: only what printed while it was on (3 pts)', near(availableMfePts(t, 10, b).pts, (3 + 10) / 2))
}

console.log('bars only count minutes fully inside the hold')
{
  const t = { direction: 'long', entry_price: 100, entry_time: '2026-01-01T15:00:30Z', exits_json: [
    { qty: 1, time: '2026-01-01T15:05:20Z', price: 105 }, { qty: 1, time: '2026-01-01T15:20:00Z', price: 108 },
  ] }
  const b = [
    { ts: '2026-01-01T15:00:00Z', high: 120, low: 99 },  // opened before the entry
    { ts: '2026-01-01T15:03:00Z', high: 106, low: 102 }, // fully inside → counts
    { ts: '2026-01-01T15:05:00Z', high: 130, low: 104 }, // the exit minute
  ]
  check('entry-minute and exit-minute bars ignored', near(availableMfePts(t, 30, b).pts, (6 + 30) / 2), String(availableMfePts(t, 30, b).pts))
}

console.log('caps')
{
  const t = { direction: 'short', entry_price: 100, entry_time: '2026-01-01T15:00:00Z', exits_json: [
    { qty: 1, time: '2026-01-01T15:10:00Z', price: 90 }, { qty: 1, time: '2026-01-01T15:20:00Z', price: 95 },
  ] }
  const wild = [{ ts: '2026-01-01T15:02:00Z', high: 100, low: 50 }] // a bad print / wrong contract
  check('a contract never exceeds the position best', near(availableMfePts(t, 12, wild).pts, 12))
  check('stored value capped at the position best', near(availableMfePtsStored({ ...t, symbol: 'MNQ', quantity: 2, mfe_dollars_per_leg: 9999 }, 12), 12))
  check('stored value used when present', near(availableMfePtsStored({ ...t, symbol: 'MNQ', quantity: 2, mfe_dollars_per_leg: 40 }, 12), 10))
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll available-MFE checks passed.')
