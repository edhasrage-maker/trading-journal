/**
 * The planned stop (src/lib/planned-stop.ts) and what reads it: R, heat /
 * "past stop", Stop respected, how a trade ended, the checklist's stop checks.
 * Pure, no data needed. The first case is the founder's real 2026-10-16 09:16:37
 * MNQ short, its stop history as Sierra logged it.
 *
 *   npx tsx scripts/test-planned-stop.ts
 */
import { stopPlan, plannedStopPrice } from '../src/lib/planned-stop.ts'
import { STOPS_VERSION } from '../src/lib/sc-stops.ts'
import { exitTradeScores, stopCheck } from '../src/lib/exit-score.ts'
import { exitKind, tradeFacts } from '../src/lib/trade-management.ts'
import { maeHeatRatio, rMultiple } from '../src/lib/analytics.ts'
import { computeCoachScore } from '../src/lib/coach-score.ts'
import type { TradeStopOrder, TradeStops, TradeTags } from '../src/lib/supabase/types.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }
const near = (name: string, got: number | null | undefined, want: number, tol = 0.005) => check(name, got != null && Math.abs(got - want) <= tol, got)

const PT = (hms: string) => new Date(`2026-10-16T${hms}-07:00`).toISOString()
const stops = (orders: TradeStopOrder[]): TradeStops => ({ v: STOPS_VERSION, src: '', orders, at: '' })
const order = (start: [string, number], ...moves: [string, number, ('you' | 'auto')?][]): TradeStopOrder =>
  ({ start: { t: PT(start[0]), px: start[1] }, moves: moves.map(([t, px, by]) => ({ t: PT(t), px, by: by ?? 'you' })) })

// The 09:16:37 short: stop moved out to 29709 before the fill, tightened to 29702 and 29697.
const oct16Orders = [0, 1, 2].map(() => order(['09:16:37.888', 29709], ['09:22:23.113', 29702], ['09:27:11.933', 29697]))
const oct16 = {
  id: 'oct16', direction: 'short' as const, symbol: 'MNQZ6.CME', quantity: 3, pnl: 182,
  entry_price: 29687, stop_price: 29697, tp1_price: 29643, exit_price: 29656.67,
  high_during_position: 29699.75, low_during_position: 29649, entry_atr_1m: 21.47,
  entry_time: PT('09:16:37.888'), exit_time: PT('09:30:59.162'),
  exits_json: [{ qty: 2, time: PT('09:30:59.161'), price: 29656.75 }, { qty: 1, time: PT('09:30:59.162'), price: 29656.5 }],
  tags_json: {} as TradeTags, trading_day_id: 'd',
  review_json: { stops: stops(oct16Orders) },
}

console.log('a stop tightened during the trade (2026-10-16 09:16:37 short)')
{
  const p = stopPlan(oct16)
  check('planned = the stop it was entered with (29709), from Sierra', p.price === 29709 && p.source === 'sierra', p)
  check('the stop at the end = the tightened one (29697)', p.final === 29697, p.final)
  check('tightening is not "moved away"', p.movedAway == null, p.movedAway)
  near('R reads the planned stop: +1.38R (was +3.03R on the logged stop)', rMultiple(oct16), 182 / (22 * 3 * 2))
  near('heat 12.75 of 22 pts = 0.58: no "past stop"', maeHeatRatio(oct16), 12.75 / 22)
  check('planned risk 22 pts', tradeFacts(oct16)?.riskPts === 22, tradeFacts(oct16)?.riskPts)
  const ex = exitTradeScores(oct16)
  check('Stop respected not judged: the planned stop never came into play', ex.stopRespected === undefined, ex)
  const logged = exitTradeScores({ ...oct16, review_json: null })
  check('without the history it still reads the logged stop (and fails, as before)', logged.stopRespected === 0, logged)
  const cs = computeCoachScore(oct16)
  const band = cs.criteria.find(c => c.key === 'stop_in_atr_band'), tp = cs.criteria.find(c => c.key === 'tp1_at_2r')
  check('checklist: stop 1.02× ATR passes the band (0.47× on the logged stop failed)', band?.status === 'pass' && band.reason === '1.02× ATR', band)
  check('checklist: TP1 2.0R on the planned stop', tp?.status === 'pass' && tp.reason === '2.0R', tp)
}

console.log('\nsetting the stop in the first minute')
{
  const t = { direction: 'long', entry_price: 100, stop_price: 90, review_json: { stops: stops([order(['09:00:00', 90], ['09:00:04', 83])]) } }
  const p = stopPlan(t)
  check('bracket default dragged out at +4 s: planned = where it was set (83)', p.price === 83 && p.movedAway == null, p)
  const late = { ...t, review_json: { stops: stops([order(['09:00:00', 90], ['09:00:04', 83], ['09:05:00', 80])]) } }
  const q = stopPlan(late)
  check('moved further away after the minute: planned stays 83, "moved away" 83 → 80', q.price === 83 && q.movedAway?.from === 83 && q.movedAway?.to === 80, q)
  const auto = { ...t, review_json: { stops: stops([order(['09:00:00', 90], ['09:05:00', 80, 'auto'])]) } }
  check('Sierra moving it by itself is not the trader moving it away', stopPlan(auto).movedAway == null)
  const tight = { ...t, review_json: { stops: stops([order(['09:00:00', 90], ['09:00:30', 95])]) } }
  check('tightened inside the minute: planned = 95', plannedStopPrice(tight) === 95)
  const be = { ...t, review_json: { stops: stops([order(['09:00:00', 90], ['09:00:30', 100])]) } }
  check('to breakeven inside the minute: planned = the last stop still risking something (90)', plannedStopPrice(be) === 90)
  const two = { ...t, review_json: { stops: stops([order(['09:00:00', 90]), order(['09:00:00', 86])]) } }
  check('two stop orders at different prices average (88)', plannedStopPrice(two) === 88)
  const added = { ...t, review_json: { stops: stops([order(['09:00:00', 90]), order(['09:03:00', 92], ['09:03:40', 89])]) } }
  check('a scale-in\'s stop gets its own minute: (90 + 89) / 2', plannedStopPrice(added) === 89.5)
}

console.log('\nStop respected on the planned stop')
{
  const base = {
    direction: 'long' as const, symbol: 'MNQ', quantity: 1, entry_price: 100, stop_price: null, tp1_price: 130,
    high_during_position: 104, low_during_position: 98, exit_price: 103, pnl: 6, exits_json: [{ qty: 1, price: 103 }],
  }
  const moved = { ...base, review_json: { stops: stops([order(['09:00:00', 90], ['09:05:00', 80])]) } }
  check('moved away after the minute = fail, even though price never neared it', exitTradeScores(moved).stopRespected === 0, exitTradeScores(moved))
  const kept = { ...base, low_during_position: 91, review_json: { stops: stops([order(['09:00:00', 90], ['09:05:00', 95])]) } }
  check('in play (9 of 10 pts) and only tightened = pass', exitTradeScores(kept).stopRespected === 1, exitTradeScores(kept))
  const pulled = { ...base, low_during_position: 85, review_json: { stops: stops([order(['09:00:00', 90])]) } }
  check('price 5 pts through the planned stop with no move logged (stop pulled) = fail', exitTradeScores(pulled).stopRespected === 0)
  check('no logged stop: the history still gives the trade a stop', plannedStopPrice(kept) === 90 && tradeFacts(kept)?.riskPts === 10)
  // 2026-06-24 09:42 long: stopped exactly at its stop (29614), the recorded low 3.25 pts past it
  const jun24 = {
    direction: 'long' as const, symbol: 'MNQ', quantity: 3, entry_price: 29634, stop_price: 29612, tp1_price: null, pnl: -120,
    high_during_position: 29640, low_during_position: 29610.75, exit_price: 29614, exits_json: [{ qty: 3, price: 29614 }],
    review_json: { stops: stops([order(['09:42:02', 29624], ['09:42:05.5', 29614])]) },
  }
  const j = stopCheck(jun24)
  check('filled at the working stop, ticks printing past it around the fill: respected, not "past stop"', j?.judged === true && j.respected && !j.past, j)
  const tightHit = { ...base, pnl: -5, exit_price: 95, low_during_position: 94.5, exits_json: [{ qty: 1, price: 95 }], review_json: { stops: stops([order(['09:00:00', 90], ['09:04:00', 95])]) } }
  check('a tightened stop that was hit: judged, respected', exitTradeScores(tightHit).stopRespected === 1, stopCheck(tightHit))
  const widenedHit = { ...base, pnl: -15, exit_price: 85, low_during_position: 84.75, exits_json: [{ qty: 1, price: 85 }], review_json: { stops: stops([order(['09:00:00', 90], ['09:04:00', 85])]) } }
  const w = stopCheck(widenedHit)
  check('moved away and hit at the wider stop: fail, and "past stop" (past the planned 90)', w?.respected === false && w.past, w)
  const loggedOnly = { ...base, stop_price: 90, low_during_position: 89.5 }
  const l = stopCheck(loggedOnly)
  check('no history: the logged stop exactly as before (heat over 1 = "past", within slippage = respected)', l?.past === true && l.respected && l.judged, l)
}

console.log('\nhow the trade ended reads the stop working at the exit')
{
  const t = {
    direction: 'long' as const, symbol: 'MNQ', quantity: 1, entry_price: 100, stop_price: 90, tp1_price: 130, pnl: -10,
    high_during_position: 102, low_during_position: 94.75, exit_price: 95, exits_json: [{ qty: 1, price: 95 }],
    review_json: { stops: stops([order(['09:00:00', 90], ['09:04:00', 95])]) },
  }
  check('stopped at the tightened stop = "stopped" (5 pts of a 10-pt plan)', exitKind(t) === 'stopped', exitKind(t))
  check('… where the logged-stop-only read called it a hand exit', exitKind({ ...t, review_json: null }) === 'manual')
}

console.log('\nwhat it never trusts')
{
  const t = { direction: 'short', entry_price: 100, stop_price: 110 }
  check('no history: the logged stop', stopPlan(t).price === 110 && stopPlan(t).source === 'logged')
  check('another version of the history: the logged stop', plannedStopPrice({ ...t, review_json: { stops: { v: 'stops-0', orders: [order(['09:00:00', 120])] } } }) === 110)
  check('a history with no stop order: the logged stop', plannedStopPrice({ ...t, review_json: { stops: stops([]) } }) === 110)
  check('a stop on the wrong side all minute: the logged stop', plannedStopPrice({ ...t, review_json: { stops: stops([order(['09:00:00', 95])]) } }) === 110)
  check('selected on its own (stops:review_json->stops) reads the same', plannedStopPrice({ ...t, stops: stops([order(['09:00:00', 115])]) }) === 115)
  check('nothing at all: null', plannedStopPrice({ direction: 'short', entry_price: 100 }) === null)
}

console.log(failed ? `\n${failed} FAILED` : '\nall planned-stop checks passed')
process.exit(failed ? 1 : 0)
