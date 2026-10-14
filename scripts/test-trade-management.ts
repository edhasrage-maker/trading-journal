/**
 * Tests for src/lib/trade-management — the one "went your way / never got going
 * / kept" definition every surface shares.
 *
 *   npx tsx scripts/test-trade-management.ts   (also wired into `npm test`)
 *
 * The fixture is the real session that exposed the problem (2026-10-12): two
 * MNQ shorts that the app showed as 0%, 50%, 54%, 80% and 100% "capture"
 * depending on the page. They must now read the same everywhere.
 */
import {
  tradeMgmt, tradeFacts, exitKind, mgmtTotals, mergeMgmtTotals, mgmtView, mgmtBarGeometry, formatKept,
  type MgmtTradeInput,
} from '../src/lib/trade-management'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const near = (name: string, actual: number | null | undefined, expected: number, tol = 0.005) =>
  check(name, actual != null && Math.abs(actual - expected) <= tol, `got ${actual}, expected ${expected}`)

// 2026-10-12 — T1 stopped out, T2 full target.
const T1: MgmtTradeInput = {
  id: 't1', direction: 'short', entry_price: 30961, stop_price: 30972, exit_price: 30971,
  high_during_position: 30971, low_during_position: 30953.5, quantity: 5, pnl: -100,
  symbol: 'MNQZ6.CME', entry_atr_1m: 11.2, exits_json: [{ qty: 5, price: 30971 }],
}
const T2: MgmtTradeInput = {
  id: 't2', direction: 'short', entry_price: 30956, stop_price: 30966, exit_price: 30926,
  high_during_position: 30962.75, low_during_position: 30926, quantity: 5, pnl: 300,
  symbol: 'MNQZ6.CME', entry_atr_1m: 8.94, exits_json: [{ qty: 5, price: 30926 }],
}

console.log('per trade')
{
  const a = tradeMgmt(T1)!, b = tradeMgmt(T2)!
  check('T1 never got going (best point 7.5 pts < 1×ATR 11.2)', a.went === false)
  near('T1 MFE pts', a.mfe.pts, 7.5)
  near('T1 MAE pts', a.mae.pts, 10)
  near('T1 result pts', a.result.pts, -10)
  near('T1 result $', a.result.dollars, -100)
  near('T1 MFE ×ATR', a.mfe.atr, 0.67)
  check('T1 has no kept % (nothing to grade)', a.kept === null)
  check('T2 went your way', b.went === true)
  near('T2 MFE ×ATR', b.mfe.atr, 3.356)
  near('T2 MAE ×ATR', b.mae.atr, 0.755)
  near('T2 kept', b.kept, 1)
}

console.log('the day, in each unit')
{
  const tot = mgmtTotals([T1, T2])
  check('1 went, 1 never, 0 unsorted', tot.went.count === 1 && tot.never.count === 1 && tot.unclassified === 0)
  const atr = mgmtView(tot, 'atr'), usd = mgmtView(tot, 'dollars'), pts = mgmtView(tot, 'pts')
  near('kept % (ATR)', atr.went.keptPct, 1)
  near('never result (ATR)', atr.never.result, -0.893)
  near('net per trade (ATR)', atr.net, 1.232)
  near('kept % ($)', usd.went.keptPct, 1)
  near('went MFE ($)', usd.went.mfe, 300)
  near('never MAE ($)', usd.never.mae, 100)
  near('net per trade ($) ties to the day P&L ÷ trades', usd.net, 100)
  near('net per trade (pts)', pts.net, 10)
  // The card's last line names what it averages: both trades, +$200 in all —
  // not the two rows subtracted (+$300 − $100 would read +$200 "per trade").
  check('net averages over both trades', usd.netCount === 2 && atr.netCount === 2)
  near('net total ($) is the day P&L', usd.netTotal, 200)
}

console.log('pooling is addition, not an average of averages')
{
  const dayA = mgmtTotals([T1]), dayB = mgmtTotals([T2])
  const pooled = mergeMgmtTotals([dayA, dayB, null, undefined])
  const direct = mgmtTotals([T1, T2])
  check('merge(dayA, dayB) equals totals of all trades', JSON.stringify(pooled) === JSON.stringify(direct))
  // a JSON round-trip (stats_json) must survive
  const revived = mergeMgmtTotals([JSON.parse(JSON.stringify(direct))])
  check('survives a JSON round-trip', JSON.stringify(revived) === JSON.stringify(direct))
}

console.log('kept is net of losses and never above 100%')
{
  // went 2×ATR your way, then closed for a loss
  const gaveBack: MgmtTradeInput = {
    id: 'g', direction: 'long', entry_price: 100, stop_price: 90, exit_price: 92,
    high_during_position: 120, low_during_position: 91, quantity: 1, pnl: -16, symbol: 'MNQ', entry_atr_1m: 10,
  }
  const winner: MgmtTradeInput = {
    id: 'w', direction: 'long', entry_price: 100, stop_price: 90, exit_price: 118,
    high_during_position: 120, low_during_position: 98, quantity: 1, pnl: 36, symbol: 'MNQ', entry_atr_1m: 10,
  }
  const g = tradeMgmt(gaveBack)!
  check('a give-back went your way', g.went === true)
  near('…and kept 0% on its own', g.kept, 0)
  const v = mgmtView(mgmtTotals([gaveBack, winner]), 'pts')
  near('pooled kept = (18 − 8) ÷ (20 + 20)', v.went.keptPct, 0.25)
  check('one of the two finished red', v.went.red === 1)
  // result above the recorded best point (fill rounding) cannot exceed 100%
  const overshoot: MgmtTradeInput = { ...winner, id: 'o', pnl: 44 }
  near('kept is capped at 100%', tradeMgmt(overshoot)!.kept, 1)
  near('pooled kept capped too', mgmtView(mgmtTotals([overshoot]), 'dollars').went.keptPct, 1)
}

console.log('what can and cannot be sorted')
{
  const base: MgmtTradeInput = {
    direction: 'long', entry_price: 100, high_during_position: 108, low_during_position: 97,
    quantity: 2, pnl: 10, symbol: 'MNQ',
  }
  check('no ATR and no stop → unsorted', tradeMgmt(base) === null)
  const withStop = tradeMgmt({ ...base, stop_price: 95 })!
  check('no ATR but a stop → 1R is the unit (8 pts ≥ 5 pts risk)', withStop.went === true)
  check('…and it has no ×ATR values', withStop.mfe.atr === null && withStop.result.atr === null)
  check('no price range → unsorted', tradeMgmt({ ...base, entry_atr_1m: 5, high_during_position: null }) === null)
  check('no P&L → unsorted', tradeMgmt({ ...base, entry_atr_1m: 5, pnl: null }) === null)
  const tot = mgmtTotals([base, { ...base, stop_price: 95 }])
  check('unsorted trades are counted, not dropped silently', tot.unclassified === 1 && tot.went.count === 1)
  const v = mgmtView(tot, 'atr')
  check('a unit no trade carries reads as null, not zero', v.went.mfe === null && v.went.keptPct === null && v.net === null)
  // the trader's own "was up" multiple and live ATR
  check('threshold multiple is honoured (needs 2×ATR=10 → 8 pts is not enough)', tradeMgmt({ ...base, entry_atr_1m: 5 }, { thresholdAtr: 2 })!.went === false)
  check('live ATR overrides the stored one', tradeMgmt({ ...base, entry_atr_1m: 5 }, { atr: 20 })!.went === false)
  // quantity field disagreeing with the fills: P&L follows the fills
  const mismatch = tradeMgmt({ ...base, entry_atr_1m: 5, quantity: 1, pnl: 40, exits_json: [{ qty: 4 }, { qty: 6 }] })!
  near('result uses the contracts actually traded', mismatch.result.pts, 2)
}

console.log('bar geometry shares one entry line')
{
  const scale = { maxMae: 1, maxMfe: 3 }
  const kept = mgmtBarGeometry({ mfe: 3, mae: 0.5, result: 1.5 }, scale)!
  const lost = mgmtBarGeometry({ mfe: 0.5, mae: 1, result: -0.9 }, scale)!
  near('entry line at 25%', kept.zero, 25)
  check('both rows share it', kept.zero === lost.zero)
  check('kept is solid right of entry', kept.solidSide === 'kept' && kept.solidLeft === kept.zero)
  near('kept width', kept.solidWidth, 37.5)
  check('lost is solid left of entry', lost.solidSide === 'lost' && Math.abs(lost.solidLeft + lost.solidWidth - lost.zero) < 1e-9)
  check('nothing fits outside the bar', kept.zero + kept.mfeWidth <= 100.0001 && lost.maeLeft >= -0.0001)
  check('no range → no bar', mgmtBarGeometry({ mfe: null, mae: null, result: null }, scale) === null)
}

console.log('raw facts without sorting, and how the trade ended')
{
  const bare: MgmtTradeInput = {
    direction: 'long', entry_price: 100, high_during_position: 108, low_during_position: 97,
    quantity: 2, pnl: 10, symbol: 'MNQ',
  }
  const f = tradeFacts(bare)!
  check('facts exist with no ATR and no stop', f != null && f.atr === null && f.riskPts === null)
  near('…MFE pts', f.mfe.pts, 8)
  check('…but it cannot be sorted', tradeMgmt(bare) === null)
  check('T1 was stopped (closed a point inside the logged stop)', exitKind({ ...T1, tp1_price: 30930 }) === 'stopped')
  check('T2 hit its target', exitKind({ ...T2, tp1_price: 30926 }) === 'target')
  check('a small loss well inside the stop is a manual exit', exitKind({ ...T1, tp1_price: 30930, exit_price: 30964, exits_json: [{ qty: 5, price: 30964 }], pnl: -30 }) === 'manual')
  check('a profit short of target is a manual exit', exitKind({ ...T2, tp1_price: 30926, exit_price: 30940, exits_json: [{ qty: 5, price: 30940 }], pnl: 160 }) === 'manual')
  check('partial at target, rest elsewhere → target', exitKind({ ...T2, tp1_price: 30926, exits_json: [{ qty: 3, price: 30926 }, { qty: 2, price: 30955 }] }) === 'target')
  check('no stop or target logged → manual', exitKind({ ...T2, stop_price: null }) === 'manual')
  check('no fills → null', exitKind({ ...T2, exit_price: null, exits_json: null }) === null)
}

console.log('formatting')
{
  check('45%', formatKept(0.45) === '45%')
  check('dash when empty', formatKept(null) === '—')
  check('clamped', formatKept(1.4) === '100%' && formatKept(-0.2) === '0%')
}

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall trade-management checks passed')
