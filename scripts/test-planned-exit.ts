/**
 * Unit tests for the After-exit read on planned exits (target hit / stopped)
 * and for measuring the post-exit window from the LAST fill.
 *   npx tsx scripts/test-planned-exit.ts
 */
import { plannedExitRead, type VerdictTrade } from '../src/lib/post-exit-verdict.ts'
import { postExitExtension } from '../src/lib/atr.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// The founder's Oct 14 short: 2 off at TP1, the runner out at 30351 at 15:37:04.
// exit_price is the AVERAGE of all three fills.
const oct14 = {
  direction: 'short' as const, entry_price: 30428, stop_price: 30442, exit_price: 30378.17,
  exit_time: '2026-10-14T15:37:04.41Z', entry_atr_1m: 20.1, pnl: 299, quantity: 3, symbol: 'MNQZ6.CME',
  high_during_position: 30431, low_during_position: 30351,
  exits_json: [
    { qty: 1, time: '2026-10-14T15:29:22.614Z', price: 30392.5 },
    { qty: 1, time: '2026-10-14T15:29:24.594Z', price: 30391 },
    { qty: 1, time: '2026-10-14T15:37:04.410Z', price: 30351 },
  ],
}
const bar = (m: string, high: number, low: number) => ({ ts: `2026-10-14T${m}:00Z`, open: high, high, low, close: low, volume: 0 })
const after = [bar('15:38', 30351, 30331), bar('15:45', 30355, 30340), bar('15:52', 30352, 30345)]

console.log('post-exit window starts at the last fill')
{
  const ext = postExitExtension(after as never, oct14)!
  check('measured from the runner (30351), not the average (30378.17)', Math.abs(ext.continued_favorable_pts - 20) < 1e-9, String(ext.continued_favorable_pts))
  check('reversal measured from the runner too', Math.abs(ext.continued_against_pts - 4) < 1e-9, String(ext.continued_against_pts))
  const noFills = postExitExtension(after as never, { ...oct14, exits_json: null })!
  check('without fills it falls back to exit_price', Math.abs(noFills.continued_favorable_pts - 47.17) < 1e-6)
}

const t = oct14 as unknown as VerdictTrade
const ext = (up: number, dn: number, full = true) => ({ continued_favorable_pts: up, continued_against_pts: dn, full_window: full })
console.log('target hit')
check('ran more', plannedExitRead(t, 'target', ext(40.2, 3)).label === 'target hit — ran 2.0×ATR more')
check('reversed', plannedExitRead(t, 'target', ext(5, 60.3)).label === 'target hit — reversed 3.0×ATR after')
check('flat', plannedExitRead(t, 'target', ext(5, 6)).label === 'target hit — flat after')
check('both material, the larger wins', plannedExitRead(t, 'target', ext(30, 45)).label === 'target hit — reversed 2.2×ATR after')
check('no data yet → just "target hit"', plannedExitRead(t, 'target', null).label === 'target hit')
console.log('stopped')
check('kept going', plannedExitRead(t, 'stopped', ext(3, 108.5)).label === 'stopped — kept going 5.4×ATR against')
check('came back', plannedExitRead(t, 'stopped', ext(74.4, 2)).label === 'stopped — came back 3.7×ATR')
check('flat', plannedExitRead(t, 'stopped', ext(10, 12)).label === 'stopped — flat after')
console.log('tooltip')
{
  const r = plannedExitRead(t, 'target', ext(40.2, 3, false))
  check('says it is the largest move each way, not the order', /not which came first/.test(r.title))
  check('flags a partial window', /partial window/.test(r.title))
}
console.log('units without ATR')
{
  const noAtr = { ...oct14, entry_atr_1m: null } as unknown as VerdictTrade
  check('falls back to R (14-pt stop → 7-pt bar)', plannedExitRead(noAtr, 'target', ext(28, 0)).label === 'target hit — ran 2.0R more')
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll planned-exit checks passed.')
