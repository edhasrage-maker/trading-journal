/**
 * Unit tests for the Days table's four numbers (src/lib/day-glance.ts).
 *   npx tsx scripts/test-day-glance.ts
 */
import { dayGlanceFacts, readDayGlance, type DayGlanceFacts, type GlanceDay, type GlanceTrade } from '../src/lib/day-glance.ts'
import { emptyMgmtTotals } from '../src/lib/trade-management.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── facts ────────────────────────────────────────────────────────────────────
console.log('dayGlanceFacts')
const t = (entry: string, exit: string, pnl: number, stopPts: number | null, qty = 1): GlanceTrade => ({
  pnl, entry_price: 20000, stop_price: stopPts == null ? null : 20000 - stopPts, quantity: qty,
  symbol: 'MNQ', direction: 'long', entry_time: `2026-10-09T${entry}:00Z`, exit_time: `2026-10-09T${exit}:00Z`,
})
{
  // Up 53 after two trades, then three more for −340 (Oct 9's shape).
  const f = dayGlanceFacts([
    t('14:00', '14:05', 80, 50), t('14:10', '14:15', -27, 100, 1),
    t('14:20', '14:25', -150, 40), t('14:30', '14:35', -100, 40), t('14:40', '14:45', -90, 40),
  ])
  check('risk_max is the biggest planned $ risk (100 pts × $2 MNQ)', f.risk_max === 200, String(f.risk_max))
  check('peak is the best realized point', f.peak === 80, String(f.peak))
  check('trades after the peak are counted with their P&L', f.after_peak_trades === 4 && f.after_peak_pnl === -367, `${f.after_peak_trades} ${f.after_peak_pnl}`)
  check('no entry rules → no checked trades', f.trades_checked === 0 && f.trades_passed === 0)
}
{
  const f = dayGlanceFacts([t('14:00', '14:05', -50, null), t('14:10', '14:15', -20, null)])
  check('never green → peak 0, nothing "after"', f.peak === 0 && f.after_peak_trades === 0)
  check('no planned stop → risk_max null', f.risk_max === null)
}
{
  const f = dayGlanceFacts([t('14:00', '14:05', 100, 50), t('14:10', '14:15', 200, 50)])
  check('closing at the high → nothing after it', f.peak === 300 && f.after_peak_trades === 0)
}

{
  // By trade: one failed rule fails the trade; unknown is left out; a trade with nothing known is not checked.
  const rules = [
    { id: 'a', name: 'L3', type: 'last_candle', from: '2026-01-01', on: true },
    { id: 'b', name: 'F6', type: 'ha_run', n: 2, from: '2026-01-01', on: true },
  ] as never
  const bar = (tm: string, o: number, c: number, ha: number) => ({ t: tm, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1, d: 0, ha })
  const ctx = (bars: ReturnType<typeof bar>[]) => ({ read_at: '07:05:00', bars }) as never
  const clean = { ...t('14:00', '14:05', 10, 20), entry_ctx: ctx([bar('07:03', 1, 2, -1), bar('07:04', 1, 2, 1)]) }  // last green, HA green 1 bar
  const late = { ...t('14:10', '14:15', 10, 20), entry_ctx: ctx([bar('07:03', 1, 2, 1), bar('07:04', 1, 2, 1)]) }   // HA green 2 bars: F6 fails
  const both = { ...t('14:20', '14:25', 10, 20), entry_ctx: ctx([bar('07:03', 1, 2, 1), bar('07:04', 2, 1, 1)]) }   // last red + HA green 2: both fail
  const none = { ...t('14:30', '14:35', 10, 20), entry_ctx: null }                                                     // no tape: not checked
  const f = dayGlanceFacts([clean, late, both, none], rules)
  check('trades checked = trades with a known rule', f.trades_checked === 3, String(f.trades_checked))
  check('only a trade that passed every rule counts as passed', f.trades_passed === 1, String(f.trades_passed))
  check('misses still count each failed rule', f.misses.F6 === 2 && f.misses.L3 === 1, JSON.stringify(f.misses))
}

// ── reads ────────────────────────────────────────────────────────────────────
console.log('readDayGlance')
const facts = (o: Partial<DayGlanceFacts> = {}): DayGlanceFacts => ({
  risk_max: 120, trades_passed: 8, trades_checked: 10, misses: {}, peak: 300, after_peak_trades: 0, after_peak_pnl: 0, ...o,
})
const day = (i: number, pnl: number, o: Partial<GlanceDay> = {}, f: Partial<DayGlanceFacts> = {}): GlanceDay => ({
  id: `d${i}`, date: `2026-09-${String(i).padStart(2, '0')}`, trade_count: 3, eod_pnl: pnl,
  glance: facts(f), mgmt: emptyMgmtTotals(), risk_usual: 120, ...o,
})
{
  // 20 prior days: 10 green at +300, 10 red; 80% of trades passed every rule.
  const prior = Array.from({ length: 20 }, (_, i) => day(i + 1, i % 2 === 0 ? 300 : -100))
  const reads = readDayGlance([
    ...prior,
    day(21, 400, {}, { risk_max: 250 }),                                                   // risk 2.08× → off
    day(22, -287, {}, { peak: 53, after_peak_trades: 3, after_peak_pnl: -340 }),            // small high → quiet
    day(23, 500, {}, { peak: 900, after_peak_trades: 2, after_peak_pnl: -400 }),            // real high, kept going → off
    day(24, 300, {}, { trades_passed: 6, trades_checked: 10, misses: { L2: 3, F6: 1 } }),   // 60% vs 80% → off
    day(25, 300, {}, { trades_passed: 7, trades_checked: 10 }),                             // 70% vs ~79% → quiet (under 10 pts)
  ])
  const r21 = reads.get('d21')!, r22 = reads.get('d22')!, r23 = reads.get('d23')!, r24 = reads.get('d24')!, r25 = reads.get('d25')!
  check('risk at 2× usual or more lights up', r21.risk?.off === true && Math.abs((r21.risk?.ratio ?? 0) - 250 / 120) < 1e-9)
  // d22's window is d2–d21: nine +300 days and d21's +400.
  check('a good day = the average green day in the rolling window', r22.high?.bar === 310, String(r22.high?.bar))
  check('a $53 high is not a high — no light', r22.high?.reached === false && r22.high?.off === false)
  check('a real high, then more trades → lights up', r23.high?.reached === true && r23.high?.off === true)
  check('playbook usual pools the window\'s trades', Math.abs((r24.playbook?.usual ?? 0) - 0.8) < 1e-9, String(r24.playbook?.usual))
  check('playbook 20 points under → off, most-missed named', r24.playbook?.off === true && r24.playbook?.mostMissed === 'L2')
  check('playbook under 10 points down → quiet', r25.playbook?.off === false)
  check('off counts the lit numbers', r21.off === 1 && r22.off === 0 && r23.off === 1)
}
{
  // Fewer than 5 green days → no bar; no yardstick → no risk light.
  const prior = Array.from({ length: 6 }, (_, i) => day(i + 1, i < 3 ? 300 : -100))
  const reads = readDayGlance([...prior, day(7, 400, { risk_usual: null }, { risk_max: 900, peak: 900, after_peak_trades: 4 })])
  const r = reads.get('d7')!
  check('no "good day" until 5 green days', r.high?.bar === null && r.high?.off === false)
  check('no usual risk → risk never lights', r.risk?.usual === null && r.risk?.off === false)
}
{
  // Days with no trades are not trading days; a day with no facts reads null.
  const reads = readDayGlance([day(1, 0, { trade_count: 0 }), day(2, 100, { glance: null })])
  check('no-trade days and fact-less days are skipped', reads.size === 0)
}

if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
