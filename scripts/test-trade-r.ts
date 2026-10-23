/**
 * Tests for results in R (src/lib/trade-r.ts): the Recap card's Net $ / R /
 * Risk per trade with the usual over the last 20 sessions, and the header's
 * day in R. Pure: no network, no database.
 *
 *   npx tsx scripts/test-trade-r.ts   (also wired into `npm test`)
 */
import { dayR, fmtR, fmtUsd, lastSessions, perTrade, tradeR, USUAL_SESSIONS, type RTrade } from '../src/lib/trade-r.ts'

let failures = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`) }
}
const near = (a: number | null, b: number, tol = 0.005) => a != null && Math.abs(a - b) <= tol

// MNQ ($2 a point): entry 100, stop `stopPts` away → risk = stopPts × qty × 2.
const mnq = (pnl: number | null, qty: number, stopPts: number | null): RTrade => ({
  pnl, quantity: qty, entry_price: 100, stop_price: stopPts == null ? null : 100 - stopPts, direction: 'long', symbol: 'MNQZ6.CME',
})

console.log('one trade in R')
check('+$300 on $100 risked = +3R', near(tradeR(mnq(300, 5, 10)), 3))
check('−$50 on $100 risked = −0.5R', near(tradeR(mnq(-50, 5, 10)), -0.5))
check('no stop → no R', tradeR(mnq(100, 5, null)) === null)
check('no P&L (open) → no R', tradeR(mnq(null, 5, 10)) === null)

console.log('per trade')
{
  // a $100-risk loss of 1R, a $300-risk win of 2R, and a no-stop +$40
  const p = perTrade([mnq(-100, 5, 10), mnq(600, 15, 10), mnq(40, 1, null)])
  check('net $ per trade counts every trade: (−100 + 600 + 40) ÷ 3 = +$180', near(p.netPerTrade, 180) && p.trades === 3)
  check('R per trade is the AVERAGE R, not $ per $ risked: (−1 + 2) ÷ 2 = +0.5R', near(p.rPerTrade, 0.5), p.rPerTrade)
  check('risk per trade over the trades with a stop: ($100 + $300) ÷ 2 = $200', near(p.riskPerTrade, 200) && p.withStop === 2)
  check('an open trade is not counted', perTrade([mnq(null, 5, 10)]).trades === 0 && perTrade([]).netPerTrade === null)
}

console.log('the day in R (Oct 22 as it happened)')
{
  // founder's 11 trades: P&L and planned risk as the live code reads them
  const rows: [number, number][] = [[-97.5, 99], [-114, 114], [-88.5, 100], [-99, 300], [781.5, 280], [-305, 320], [-65, 320], [-162, 296], [830, 275], [36.5, 300], [579.5, 240]]
  // risk = stopPts × 10 lots × $2 → stopPts = risk ÷ 20
  const day = rows.map(([pnl, risk]) => mnq(pnl, 10, risk / 20))
  const r = dayR(day)
  check('day = +3.4R', near(r.totalR, 3.44, 0.01), r.totalR)
  check('avg win 2.1R, avg loss 0.7R, 3.0 : 1', near(r.avgWinR, 2.09, 0.01) && near(r.avgLossR, 0.70, 0.01) && near(r.ratio, 3.0, 0.05), r)
  const p = perTrade(day)
  check('card: +$118 · +0.31R · $240', near(p.netPerTrade, 117.9, 0.1) && near(p.rPerTrade, 0.31, 0.01) && near(p.riskPerTrade, 240, 1), p)
  check('no losses → no ratio', dayR([mnq(100, 5, 10)]).ratio === null)
  check('no stops at all → no day R', dayR([mnq(100, 5, null)]).totalR === null)
}

console.log('the usual: last 20 sessions')
{
  const byDate = new Map<string, RTrade[]>()
  for (let d = 1; d <= 25; d++) byDate.set(`2026-09-${String(d).padStart(2, '0')}`, [mnq(d, 1, 10)])
  byDate.set('2026-09-26', [mnq(null, 1, 10)]) // a day with only an open trade is not a session
  const pooled = lastSessions(byDate)
  check(`USUAL_SESSIONS is 20`, USUAL_SESSIONS === 20)
  check('takes the 20 newest sessions with trades (Sep 6–25)', pooled.length === 20 && pooled.every(t => (t.pnl as number) >= 6), pooled.map(t => t.pnl))
  check('fewer sessions → all of them', lastSessions(new Map([['2026-09-01', [mnq(5, 1, 10)]]])).length === 1)
}

console.log('formats')
check('fmtUsd', fmtUsd(117.9) === '+$118' && fmtUsd(-26.4) === '−$26' && fmtUsd(1297) === '+$1,297')
check('fmtR', fmtR(0.3127) === '+0.31R' && fmtR(-0.2) === '−0.20R' && fmtR(3.44, 1) === '+3.4R')

console.log(failures ? `\n${failures} FAILED` : '\nall trade-r checks passed')
process.exit(failures ? 1 : 0)
