/**
 * Runner rules — the pure parts (src/lib/runner-rules.ts) and how Exit uses them.
 * The three founder trades from the approved mockup (docs/runner-rules-mockup.html)
 * must read exactly as the mockup shows them.
 *
 *   npx tsx scripts/test-runner-rules.ts
 */
import {
  evaluateRunnerRules, readRunner, readRunnerRules, runnerRulesScore, runnerRulesSig, tradeRunnerPart, runnerRuleTally,
  newRunnerRule, type RunnerRuleConfig, type RunnerTrade,
} from '../src/lib/runner-rules.ts'
import { dayTradeInputs, traderRulesSig } from '../src/lib/exit-rollup.ts'
import { FOUNDER_ENTRY_RULES } from '../src/lib/entry-rules.ts'
import { axisTooltip } from '../src/lib/tapescore-axes.ts'
import { STOPS_VERSION } from '../src/lib/sc-stops.ts'
import { ruleMistakeTagsFor } from '../src/lib/rule-tags.ts'
import type { TradeStops } from '../src/lib/supabase/types.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }

const RULES: RunnerRuleConfig[] = [
  newRunnerRule('scale_out', 'T1', '2026-01-01', 't1'),
  newRunnerRule('runner_exit', 'T2', '2026-01-01', 't2'),
  newRunnerRule('be_after_tp1', 'T3', '2026-01-01', 't3'),
]
const PT = (date: string, hms: string) => new Date(`${date}T${hms}-07:00`).toISOString()   // PDT
const legs = (date: string, xs: [string, number, number][]) => xs.map(([hms, qty, price]) => ({ time: PT(date, hms), qty, price }))

// ── the mockup's three trades ──
const oct14: RunnerTrade = {
  direction: 'short', symbol: 'MNQZ6.CME', entry_time: PT('2026-10-14', '08:19:16'), entry_price: 30428, tp1_price: 30398, entry_atr_1m: 20.1,
  exits_json: legs('2026-10-14', [['08:29:22', 1, 30392.5], ['08:29:24', 1, 30391], ['08:37:04', 1, 30351]]),
}
const sep18: RunnerTrade = {
  direction: 'long', symbol: 'MESZ6.CME', entry_time: PT('2026-09-18', '09:48:10'), entry_price: 7685.25, tp1_price: 7691.25, entry_atr_1m: 2.13,
  exits_json: legs('2026-09-18', [['09:53:47', 3, 7691.25], ['10:38:26', 2, 7692.25]]),
}
const jul1: RunnerTrade = {
  direction: 'long', symbol: 'MNQU6.CME', entry_time: PT('2026-07-01', '09:45:00'), entry_price: 30214, tp1_price: 30240, entry_atr_1m: 16.33,
  exits_json: legs('2026-07-01', [['09:47:31', 3, 30240], ['09:49:52', 2, 30215]]),
}
console.log('the mockup\'s trades')
{
  const a = evaluateRunnerRules(RULES, oct14)!
  check('Oct 14 T1', a[0].status === 'pass' && a[0].reason === '2 of 3 contracts (67%) came off at 30,392.50 and 30,391.00 (08:29), at TP1 30,398.00 or better.', a[0])
  check('Oct 14 T2', a[1].status === 'pass' && a[1].reason === 'The last contract left at 30,351.00 (08:37), 3.83× ATR from entry: the 4× ATR target.', a[1])
  check('Oct 14 T3 without stop history', a[2].status === 'unknown' && a[2].reason === 'No stop history for this trade: import your Sierra log with orders included.', a[2])
  const b = evaluateRunnerRules(RULES, sep18)!
  check('Sep 18 T1', b[0].status === 'pass' && b[0].reason === '3 of 5 contracts (60%) came off at 7,691.25 (09:53), at TP1 7,691.25.', b[0])
  check('Sep 18 T2', b[1].status === 'fail' && b[1].reason === 'The last 2 contracts left at 7,692.25 (10:38), 3.29× ATR from entry: not breakeven, the 4× ATR target or 13:00, so closed by hand.', b[1])
  const c = evaluateRunnerRules(RULES, jul1)!
  check('Jul 1 T1', c[0].status === 'pass' && c[0].reason === '3 of 5 contracts (60%) came off at 30,240.00 (09:47), at TP1 30,240.00.', c[0])
  check('Jul 1 T2 (2-tick window)', c[1].status === 'fail' && c[1].reason === 'The last 2 contracts left at 30,215.00 (09:49), 4 ticks past entry: outside your breakeven window (2 ticks), so closed by hand.', c[1])
  const wide = evaluateRunnerRules(RULES.map(r => (r.type === 'runner_exit' ? { ...r, be_ticks: 5 } : r)), jul1)!
  check('Jul 1 T2 passes with a 5-tick window', wide[1].status === 'pass' && /breakeven/.test(wide[1].reason), wide[1])
  check('scores: Oct 14 = 1, Sep 18 = 0.5 (T3 unknown left out)', runnerRulesScore(a) === 1 && runnerRulesScore(b) === 0.5)
}
console.log('breakeven only after TP1, from the stop orders')
{
  // [time, price] for where each stop order started and every later price
  const stops = (date: string, orders: { start: [string, number]; moves?: [string, number][] }[]): TradeStops => ({
    v: STOPS_VERSION, src: '', at: '',
    orders: orders.map(o => ({ start: { t: PT(date, o.start[0]), px: o.start[1] }, moves: (o.moves ?? []).map(([h, px]) => ({ t: PT(date, h), px, by: 'you' as const })) })),
  })
  const T3 = (t: RunnerTrade) => evaluateRunnerRules(RULES, t)![2]
  // Jul 1 long 30,214; TP1 filled 09:47:31. Two stops (one per target), the runner's dragged to 30,215 at 09:47:39.
  const real = stops('2026-07-01', [{ start: ['09:45:07', 30201] }, { start: ['09:45:07', 30201], moves: [['09:47:39', 30215]] }])
  const pass = T3({ ...jul1, stops: real })
  check('Jul 1: stop to breakeven 8 s after TP1 = pass, mockup wording', pass.status === 'pass' && pass.reason === 'Stop to breakeven (30,215) at 09:47:39, 8 s after TP1 filled (09:47:31).', pass)
  check('read inside review_json too', T3({ ...jul1, review_json: { stops: real, score: null } }).reason === pass.reason)
  const fail = T3({ ...jul1, stops: stops('2026-07-01', [{ start: ['09:45:07', 30201], moves: [['09:46:50', 30214], ['09:48:00', 30220]] }]) })
  check('at entry before TP1 = fail', fail.status === 'fail' && fail.reason === 'Stop to breakeven (30,214) at 09:46:50, 41 s before TP1 filled (09:47:31).', fail)
  const tighter = T3({ ...jul1, stops: stops('2026-07-01', [{ start: ['09:45:07', 30201], moves: [['09:46:50', 30213], ['09:48:33', 30215]] }]) })
  check('still in loss before TP1 is just a tighter stop; breakeven after = pass', tighter.status === 'pass' && tighter.reason === 'Stop to breakeven (30,215) at 09:48:33, 1 min 2 s after TP1 filled (09:47:31).', tighter)
  const same = T3({ ...jul1, stops: stops('2026-07-01', [{ start: ['09:45:07', 30201], moves: [['09:47:31', 30215]] }]) })
  check('the same instant as the TP1 fill counts as after', same.status === 'pass', same)
  const never = T3({ ...jul1, stops: stops('2026-07-01', [{ start: ['09:45:07', 30201], moves: [['09:46:10', 30205], ['09:48:00', 30210]] }]) })
  check('never at breakeven = pass (founder 2026-10-15)', never.status === 'pass' && never.reason === 'The stop never went to breakeven (30,214); it was last at 30,210.', never)
  const none = T3({ ...jul1, stops: { v: STOPS_VERSION, src: '', at: '', orders: [] } })
  check('a log with orders but no stop on the trade = unknown', none.status === 'unknown' && none.reason === 'Your log shows no stop order on this trade.', none)
  check('an unknown stop-history version = no history', T3({ ...jul1, stops: { ...real, v: 'stops-0' } }).status === 'unknown')
  // a short: Oct 14 at 30,428, TP1 08:29:22; stop 30,438 to 30,427 at 08:29:32
  const short = T3({ ...oct14, stops: stops('2026-10-14', [{ start: ['08:19:16', 30438], moves: [['08:29:32', 30427]] }]) })
  check('short: below entry is in profit', short.status === 'pass' && short.reason === 'Stop to breakeven (30,427) at 08:29:32, 10 s after TP1 filled (08:29:22).', short)
  const early = stops('2026-10-14', [{ start: ['08:19:16', 30438], moves: [['08:25:00', 30428]] }])
  check('short: at entry before TP1 = fail', T3({ ...oct14, stops: early }).status === 'fail')
  check('a counted fail puts "Breakeven before TP1" on the trade', JSON.stringify(ruleMistakeTagsFor({ ...oct14, stops: early, review_json: null }, [], RULES)) === JSON.stringify(['Breakeven before TP1']))
  check('a pass puts no tag on', ruleMistakeTagsFor({ ...oct14, stops: stops('2026-10-14', [{ start: ['08:19:16', 30438], moves: [['08:29:32', 30427]] }]), review_json: null }, [], RULES).length === 0)
  check('T3 now counts in the runner score (Jul 1: T1 pass, T2 fail at 2 ticks, T3 pass = 2/3)', Math.abs((runnerRulesScore(evaluateRunnerRules(RULES, { ...jul1, stops: real })) ?? 0) - 2 / 3) < 1e-9)
}
console.log('which trades are runners')
{
  check('no TP1 logged → not judged', evaluateRunnerRules(RULES, { ...oct14, tp1_price: null }) === null && readRunner({ ...oct14, tp1_price: null }).runner === false)
  check('all out at TP1 → not judged', evaluateRunnerRules(RULES, { ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 5, 7691.25]]) }) === null)
  check('never at TP1 (stopped) → not judged', evaluateRunnerRules(RULES, { ...sep18, exits_json: legs('2026-09-18', [['09:50:00', 5, 7683.25]]) }) === null)
  check('fills 30 s apart are one exit; 31 s apart are two', readRunner({ ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 3, 7691.25], ['09:54:17', 2, 7692.25]]) }).runner === false
    && readRunner({ ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 3, 7691.25], ['09:54:18', 2, 7692.25]]) }).runner === true)
  check('a TP1 on the wrong side of entry → not judged', evaluateRunnerRules(RULES, { ...sep18, tp1_price: 7680 }) === null)
}
console.log('how the runner left')
{
  const close = evaluateRunnerRules(RULES, { ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 3, 7691.25], ['13:00:05', 2, 7693]]) })!
  check('out at the 13:00 close passes', close[1].status === 'pass' && /13:00 close/.test(close[1].reason), close[1])
  const late = evaluateRunnerRules(RULES, { ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 3, 7691.25], ['13:20:00', 2, 7693]]) })!
  check('20 min after the close is not the close', late[1].status === 'fail', late[1])
  const target = evaluateRunnerRules(RULES, { ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 3, 7691.25], ['10:10:00', 2, 7685.25 + 3.75 * 2.13]]) })!
  check('3.75× ATR is inside the 0.25 tolerance of 4×', target[1].status === 'pass', target[1])
  const noAtr = evaluateRunnerRules(RULES, { ...sep18, entry_atr_1m: null })!
  check('no ATR at entry and not breakeven/close → unknown, never a guess', noAtr[1].status === 'unknown', noAtr[1])
  const shortBe = evaluateRunnerRules(RULES, { ...oct14, exits_json: legs('2026-10-14', [['08:29:22', 2, 30392.5], ['08:31:00', 1, 30428.5]]) })!
  check('a short\'s breakeven 2 ticks against still counts as breakeven', shortBe[1].status === 'pass' && /breakeven/.test(shortBe[1].reason), shortBe[1])
  const t1Fail = evaluateRunnerRules(RULES, { ...sep18, exits_json: legs('2026-09-18', [['09:53:47', 1, 7691.25], ['10:38:26', 4, 7693.75]]) })!
  check('20% at TP1 fails T1 with the share named', t1Fail[0].status === 'fail' && /\(20%\).*under your 60%/.test(t1Fail[0].reason), t1Fail[0])
}
console.log('settings, counting and Exit')
{
  const read = readRunnerRules([{ type: 'runner_exit', be_ticks: 99, close: '25:00', target_atr: 'x' }, { type: 'nope' }, { type: 'scale_out', pct: 150 }])
  check('malformed dropped, numbers clamped, bad time → 13:00', read.length === 2 && read[0].be_ticks === 40 && read[0].close === '13:00' && read[0].target_atr === 4 && read[1].pct === 100)
  check('sig ignores names, follows numbers', runnerRulesSig(RULES) === runnerRulesSig(RULES.map(r => ({ ...r, name: 'x' }))) && runnerRulesSig(RULES) !== runnerRulesSig(RULES.map(r => (r.type === 'runner_exit' ? { ...r, be_ticks: 5 } : r))))
  check('no runner rules → the day sig is the entry sig alone', traderRulesSig(FOUNDER_ENTRY_RULES, []) === traderRulesSig(FOUNDER_ENTRY_RULES))
  const later = RULES.map(r => ({ ...r, from: '2026-10-14' }))
  check('a trade before the rules start → generic Runner part', tradeRunnerPart(sep18, later).own === false)
  const own = tradeRunnerPart(oct14, later)
  check('a runner on/after the start → the trader\'s score', own.own === true && own.score === 1)
  const notRunner = tradeRunnerPart({ ...oct14, exits_json: legs('2026-10-14', [['08:29:22', 3, 30392.5]]) }, later)
  check('a non-runner on/after the start → own rules, no runner score', notRunner.own === true && notRunner.score === null)
  // Exit sums: generic vs own
  const base = { pnl: 299, quantity: 3, high_during_position: 30430, low_during_position: 30340, stop_price: 30442, tags_json: { trade_management: ['TP2 Reached Full Target'] } }
  const genericDay = dayTradeInputs([{ ...oct14, ...base } as never], 1)
  const ownDay = dayTradeInputs([{ ...oct14, ...base } as never], 1, [], later)
  check('generic day: runner part from TP1 filled', genericDay.runner.n === 1 && genericDay.rules_sig === '')
  check('own rules day: runner part = the runner score (1), sig records the rules', ownDay.runner.n === 1 && ownDay.runner.sum === 1 && ownDay.rules_sig === traderRulesSig([], later))
  const tally = runnerRuleTally(later[1], [{ ...oct14, pnl: 299 }, { ...sep18, pnl: 160 }, { ...oct14, entry_time: PT('2026-10-15', '08:19:16'), exits_json: legs('2026-10-15', [['08:29:22', 3, 30392.5]]), pnl: 100 }])
  check('tally: Oct 14 runner passes, Sep 18 before the start, all-out trade not a runner', tally.pass.n === 1 && tally.fail.n === 0 && tally.unknown === 0)
  check('Exit hover text explains the runner rules', /Runner rules: your own \(Settings → Trading Rules\)/.test(axisTooltip('Exit', null, 'exit')))
}

console.log(failed ? `\n${failed} FAILED` : '\nall runner-rules checks passed')
process.exit(failed ? 1 : 0)
