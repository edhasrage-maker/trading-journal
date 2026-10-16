/**
 * Stop orders from a Sierra trade-activity export with orders included
 * (src/lib/sc-stops.ts through parseSierraChartLog). The rows follow what Sierra
 * really writes (traced from the founder's 2024 exports and 2026 daily files):
 * a bracket's stop is a child of the entry order, its working price shows on
 * Pending Child / Open rows, a drag is "User order modification" then
 * "Cancel/Replace complete", a refused drag comes back Open at the old price.
 *
 *   npx tsx scripts/test-sc-stops.ts
 */
import { parseSierraChartLog } from '../src/lib/sc-importer.ts'
import { combineSierraLog } from '../src/lib/sc-combine.ts'
import { readStopOrders, storedStops, makeTradeStops, sameStopHistory, STOPS_VERSION } from '../src/lib/sc-stops.ts'
import { evaluateRunnerRules, newRunnerRule } from '../src/lib/runner-rules.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }

const HEAD = ['ActivityType', 'DateTime', 'Symbol', 'OrderActionSource', 'InternalOrderID', 'OrderType', 'Quantity', 'BuySell', 'Price', 'OrderStatus', 'FillPrice', 'TradeAccount', 'OpenClose', 'ParentInternalOrderID', 'HighDuringPosition', 'LowDuringPosition']
const ACCT = 'LFF050-6PB602HQ-PRO015'
const SYM = 'MNQU6.CME'
type R = Partial<Record<(typeof HEAD)[number], string>>
const row = (r: R) => HEAD.map(h => r[h] ?? '').join('\t')
const D = (hms: string) => `2026-07-01  ${hms}`
const ord = (hms: string, id: string, type: string, side: string, price: string, status: string, source: string, parent = '', oc = 'Close', qty = '') =>
  row({ ActivityType: 'Orders', DateTime: D(hms), Symbol: SYM, OrderActionSource: source, InternalOrderID: id, OrderType: type, Quantity: qty, BuySell: side, Price: price, OrderStatus: status, TradeAccount: ACCT, OpenClose: oc, ParentInternalOrderID: parent })
const fill = (hms: string, id: string, type: string, side: string, qty: string, price: string, oc: string, parent = '') =>
  row({ ActivityType: 'Fills', DateTime: D(hms), Symbol: SYM, InternalOrderID: id, OrderType: type, Quantity: qty, BuySell: side, Price: price, OrderStatus: 'Filled', FillPrice: price, TradeAccount: ACCT, OpenClose: oc, ParentInternalOrderID: parent })

// Jul 1: long 5 at 30,214 with a two-target bracket (3 at 30,240 + 2 runner), stops at 30,201.
const lines = [
  HEAD.join('\t'),
  ord('09:45:05.100000', '213936', 'Limit', 'Sell', '30240.00', 'Pending Child-Client', 'NQU6.CME/MNQU6.CME | User order entry. Attached Order', '213935'),
  ord('09:45:05.100100', '213937', 'Stop', 'Sell', '30199.00', 'Pending Child-Client', 'NQU6.CME/MNQU6.CME | User order entry. Attached Order', '213935'),
  ord('09:45:05.100200', '213940', 'Limit', 'Sell', '30290.00', 'Pending Child-Client', 'NQU6.CME/MNQU6.CME | User order entry. Attached Order', '213938'),
  ord('09:45:05.100300', '213941', 'Stop', 'Sell', '30199.00', 'Pending Child-Client', 'NQU6.CME/MNQU6.CME | User order entry. Attached Order', '213938'),
  ord('09:45:05.100400', '213935', 'Limit', 'Buy', '30214.00', 'Order Sent', 'NQU6.CME/MNQU6.CME | User order entry', '', 'Open', '3'),
  ord('09:45:05.100500', '213938', 'Limit', 'Buy', '30214.00', 'Order Sent', 'NQU6.CME/MNQU6.CME | User order entry', '', 'Open', '2'),
  // a drag before the entry fills: the pending child moves at once
  ord('09:45:06.000000', '213937', 'Stop', 'Sell', '30199.00', 'Pending Modify', 'NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30201.00', '213935'),
  ord('09:45:06.000100', '213937', 'Stop', 'Sell', '30201.00', 'Pending Child-Client', 'Order modified internally. NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30201.00', '213935'),
  ord('09:45:06.000200', '213941', 'Stop', 'Sell', '30199.00', 'Pending Modify', 'NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30201.00', '213938'),
  ord('09:45:06.000300', '213941', 'Stop', 'Sell', '30201.00', 'Pending Child-Client', 'Order modified internally. NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30201.00', '213938'),
  fill('09:45:07.625000', '213935', 'Limit', 'Buy', '3', '30214.00', 'Open'),
  fill('09:45:07.625100', '213938', 'Limit', 'Buy', '2', '30214.00', 'Open'),
  ord('09:45:07.626000', '213937', 'Stop', 'Sell', '30201.00', 'Order Sent', 'Auto-sent child from parent fill', '213935'),
  ord('09:45:07.626100', '213941', 'Stop', 'Sell', '30201.00', 'Order Sent', 'Auto-sent child from parent fill', '213938'),
  ord('09:45:07.700000', '213941', 'Stop', 'Sell', '30201.00', 'Open', 'Rithmic Direct - DTC (New)', '213938'),
  row({ ActivityType: 'Positions', DateTime: D('09:45:07.700100'), Symbol: SYM, TradeAccount: ACCT, OrderActionSource: 'Position update' }),
  // a refused drag: comes back Open at the old price
  ord('09:46:00.000000', '213941', 'Stop', 'Sell', '30201.00', 'Pending Modify', 'NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30190.00', '213938'),
  ord('09:46:00.090000', '213941', 'Stop', 'Sell', '30201.00', 'Open', 'Order modification failed | Rithmic Direct - DTC (Order cancel/replace reject)', '213938'),
  // TP1 fills; its stop is cancelled with it
  fill('09:47:31.779000', '213936', 'Limit', 'Sell', '3', '30240.00', 'Close', '213935'),
  ord('09:47:31.780000', '213937', 'Stop', 'Sell', '30201.00', 'Canceled', 'Rithmic Direct - DTC (Canceled)', '213935'),
  // the runner's stop dragged to breakeven + 1 point
  ord('09:47:39.000000', '213941', 'Stop', 'Sell', '30201.00', 'Pending Modify', 'NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30215.00', '213938'),
  ord('09:47:39.080000', '213941', 'Stop', 'Sell', '30201.00', 'Pending Modify', 'Rithmic Direct - DTC (Order update)', '213938'),
  ord('09:47:39.090000', '213941', 'Stop', 'Sell', '30215.00', 'Open', 'Rithmic Direct - DTC (Cancel/Replace complete)', '213938'),
  ord('09:49:52.467000', '213941', 'Stop', 'Sell', '30215.00', 'Filled', 'Rithmic Direct - DTC (Filled)', '213938'),
  fill('09:49:52.467100', '213941', 'Stop', 'Sell', '2', '30215.00', 'Close', '213938'),
  ord('09:49:52.470000', '213940', 'Limit', 'Sell', '30290.00', 'Canceled', 'Rithmic Direct - DTC (Canceled)', '213938'),
]
const text = lines.join('\n')
// Real sub-second times, read in the trader's zone as the hosted import does.
const TZ = 'America/Los_Angeles'

console.log('reading the stops')
{
  const { rows, parseErrors } = parseSierraChartLog(text, TZ)
  check('one trade, built from the fills as before', rows.length === 1 && rows[0].sierra_trade_id === `${ACCT}:213935` && rows[0].quantity === 5 && rows[0].exits.length === 2, rows)
  check('order and position rows are not "skipped" warnings', !parseErrors.some(e => /non-Fill/.test(e)), parseErrors)
  const so = rows[0].stop_orders!
  check('both bracket stops found', so?.length === 2, so)
  check('stops start at the price in force when the entry filled (the pre-fill drag folded in)', so.every(o => o.start.px === 30201 && o.start.t === '2026-07-01T16:45:07.625Z'), so)
  check('the cancelled TP1 stop never moved', so[0].moves.length === 0, so[0])
  check('the refused drag is not a move; the breakeven drag is, by you, at Cancel/Replace complete',
    so[1].moves.length === 1 && so[1].moves[0].px === 30215 && so[1].moves[0].by === 'you' && so[1].moves[0].t === '2026-07-01T16:47:39.090Z', so[1])
  const t3 = evaluateRunnerRules([newRunnerRule('scale_out', 'T1', '2026-01-01', 't1'), newRunnerRule('be_after_tp1', 'T3', '2026-01-01', 't3')], {
    direction: rows[0].direction, symbol: rows[0].symbol, entry_time: rows[0].entry_time_iso, entry_price: rows[0].entry_price, tp1_price: 30240,
    exits_json: rows[0].exits, stops: makeTradeStops(so, { entry_time: rows[0].entry_time_iso, entry_price: rows[0].entry_price, direction: rows[0].direction, symbol: rows[0].symbol }),
  })![1]
  check('graded end to end: pass, 7 s after TP1', t3.status === 'pass' && t3.reason === 'Stop to breakeven (30,215) at 09:47:39, 7 s after TP1 filled (09:47:31).', t3)
}
console.log('fills-only and other cases')
{
  const fillsOnly = [lines[0], ...lines.slice(1).filter(l => l.startsWith('Fills\t'))].join('\n')
  const { rows } = parseSierraChartLog(fillsOnly, TZ)
  check('a fills-only export carries no stop history (never overwrites one)', rows.length === 1 && rows[0].stop_orders === undefined, rows[0])
  const auto = text.replace('NQU6.CME/MNQU6.CME | User order modification. Requested Price: 30215.00', 'Modifying Attached Order from parent modification. New price: 30215.00')
  check('a change Sierra made itself is "auto"', parseSierraChartLog(auto, TZ).rows[0].stop_orders![1].moves[0].by === 'auto')
  const other = text.replace(`${ACCT}\tClose\t213938`, `OTHER-ACCT\tClose\t213938`)
  check('stops are matched within the trade\'s own account', parseSierraChartLog(other, TZ).rows[0].stop_orders!.length >= 1)
  const combined = combineSierraLog(text, TZ)
  check('combine-all-accounts keeps the stop orders', combined.trades.length === 1 && combined.trades[0].stop_orders?.length === 2, combined.trades[0])
}
console.log('untrusted input')
{
  const so = parseSierraChartLog(text, TZ).rows[0].stop_orders!
  check('a round trip through JSON survives', JSON.stringify(readStopOrders(JSON.parse(JSON.stringify(so)))) === JSON.stringify(so))
  check('junk is dropped', JSON.stringify(readStopOrders([{ start: { t: 'x', px: 1 } }, { start: { t: '2026-07-01T16:45:07Z', px: 'a' } }, null, 5])) === '[]')
  check('not an array = nothing', readStopOrders({ orders: [] }) === null)
  const fresh = makeTradeStops(so, { entry_time: '2026-07-01T16:45:07.625Z', entry_price: 30214, direction: 'long', symbol: 'MNQU6.CME' })
  // what the database hands back: same data, jsonb's own key order
  const stored = JSON.parse(JSON.stringify({ ...fresh, orders: fresh.orders.map(o => ({ moves: o.moves.map(m => ({ t: m.t, by: m.by, px: m.px })), start: { px: o.start.px, t: o.start.t } })) }))
  check('a stored history in another key order is the same history', sameStopHistory(stored, fresh))
  check('a moved stop is not', !sameStopHistory({ ...stored, orders: [{ ...stored.orders[0], start: { ...stored.orders[0].start, px: 1 } }, stored.orders[1]] }, fresh))
  check('a stored history of another version is ignored', storedStops({ v: 'stops-0', orders: [] }) === null && storedStops({ v: STOPS_VERSION, orders: [] })?.orders.length === 0)
}

console.log(failed ? `\n${failed} FAILED` : '\nall sc-stops checks passed')
if (failed) process.exit(1)
