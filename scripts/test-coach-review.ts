/**
 * Coach Review's input holds nothing from the fill second on (src/lib/coach-review.ts).
 *
 * A synthetic tape runs from the day before to an hour past the fill, with a
 * rally to a new high after the fill. The real builder (buildSnapshot, the
 * same Blind cut the page uses) makes the Blind snapshot, and then:
 *   1. every bar and bubble time in the input is before the fill;
 *   2. nothing of the tape after the fill is in it: not the new high, not a
 *      clock time after the fill;
 *   3. it refuses a Full review payload, and a Blind one with a bar after the fill;
 *   4. the columns the route reads hold no exit, P&L, size, tags, notes or screenshot;
 *   5. checkLine drops lines naming a time after the fill or a price off the chart,
 *      and finishCoachReview keeps the rest in For / Against / Look at order.
 *
 *   npx tsx scripts/test-coach-review.ts
 */
import { buildCoachReviewInput, checkLine, finishCoachReview, parseCoachReview, timeLabelsIn, COACH_REVIEW_EXTRA, COACH_REVIEW_SCHEMA, COACH_REVIEW_SYSTEM, CoachReviewInputError, stopBandOf, traderBlock, dayAtFill, usualSizeOf, type CoachReviewData, type CoachReviewInput, type DayTrade } from '../src/lib/coach-review.ts'
import { OWNER_RAILS, UNTRACKED_RAILS } from '../src/lib/scoring-profile.ts'
import { buildSnapshot, type SnapshotRequest } from '../src/lib/orderflow/server/snapshot.ts'
import type { TickSource, HtfBars } from '../src/lib/orderflow/server/tick-source.ts'
import { BLIND_TRADE_COLUMNS, type DeepDivePayload } from '../src/lib/orderflow/server/deep-dive-payload.ts'
import { utcMsToSierraUs, sierraUsToUtcMs, type TickFrame } from '../src/lib/orderflow/ticks.ts'
import { utcToPtMs, ptMidnight, ptClock } from '../src/lib/orderflow/pt-clock.ts'
import { evaluateRules, FOUNDER_ENTRY_RULES } from '../src/lib/entry-rules.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }

// ---- a synthetic tape: Wed 06:00 PT → Thu 09:45 PT; NQ short filled Thu 2026-10-15 08:41:04 PT ----
const FILL_UTC = Date.parse('2026-10-15T15:41:04Z')        // 08:41:04 PDT
const START_UTC = Date.parse('2026-10-14T13:00:00Z')       // Wed 06:00 PDT
const END_UTC = FILL_UTC + 3600_000
let seed = 20261015
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296 }
const n = Math.floor((END_UTC - START_UTC) / 2500)
const T: TickFrame = {
  n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n), hh: new Float64Array(n),
  ll: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
}
const ptMs = new Float64Array(n)
const UTC = new Float64Array(n)
let tk = 84000 // 21000.00 in ticks
let preHi = -Infinity, preLo = Infinity, rallyFrom = 0
for (let i = 0; i < n; i++) {
  const utc = START_UTC + i * 2500 + Math.floor(rnd() * 2000)
  if (utc < FILL_UTC) tk += Math.floor(rnd() * 5) - 2
  else {
    // after the fill: a steady rally to 300 points over everything before it
    if (!rallyFrom) rallyFrom = tk
    tk = Math.max(tk, Math.round(rallyFrom + (preHi * 4 + 1200 - rallyFrom) * Math.min(1, (utc - FILL_UTC) / 1800_000)))
  }
  const buy = rnd() < 0.5, v = 1 + Math.floor(rnd() * (rnd() < 0.03 ? 120 : 8))
  T.us[i] = utcMsToSierraUs(utc)
  UTC[i] = utc
  ptMs[i] = utcToPtMs(utc)
  T.ptMin[i] = Math.floor(ptMs[i] / 60_000) * 60_000
  T.hh[i] = (tk + 1) / 4; T.ll[i] = tk / 4
  T.px[i] = buy ? T.hh[i] : T.ll[i]
  T.v[i] = v; T.av[i] = buy ? v : 0; T.bv[i] = buy ? 0 : v; T.nt[i] = 1
  if (utc < FILL_UTC) { preHi = Math.max(preHi, T.px[i]); preLo = Math.min(preLo, T.px[i]) }
}
const postHi = Math.max(...Array.from(T.px).filter((_, i) => sierraUsToUtcMs(T.us[i]) >= FILL_UTC))

class MemSource implements TickSource {
  readWindow(startPt: number, endPt: number, cap: number): TickFrame {
    const idx: number[] = []
    for (let i = 0; i < n; i++) if (ptMs[i] >= startPt && ptMs[i] < endPt && T.us[i] < cap) idx.push(i)
    const pick = <A extends Float64Array | Uint32Array>(a: A, make: new (k: number) => A) => { const o = new make(idx.length); idx.forEach((i, k) => { o[k] = a[i] }); return o }
    return {
      n: idx.length, us: pick(T.us, Float64Array), ptMin: pick(T.ptMin, Float64Array), px: pick(T.px, Float64Array), hh: pick(T.hh, Float64Array),
      ll: pick(T.ll, Float64Array), v: pick(T.v, Uint32Array), bv: pick(T.bv, Uint32Array), av: pick(T.av, Uint32Array), nt: pick(T.nt, Uint32Array),
    }
  }
  hasRthTrade(d: string) {
    const open = ptMidnight(d) + 6.5 * 3600_000, close = ptMidnight(d) + 13 * 3600_000
    for (let i = 0; i < n; i++) if (ptMs[i] >= open && ptMs[i] < close) return true
    return false
  }
  firstTradePrice(from: number, to: number) { for (let i = 0; i < n; i++) if (ptMs[i] >= from && ptMs[i] < to) return T.px[i]; return null }
  extremes(d: string, s: number, e: number) {
    const a = Math.max(s, ptMidnight(d) - 9 * 3600_000), b = Math.min(e, ptMidnight(d) + 15 * 3600_000)
    let h: number | null = null, l: number | null = null
    for (let i = 0; i < n; i++) if (ptMs[i] >= a && ptMs[i] < b) { if (h == null || T.px[i] > h) h = T.px[i]; if (l == null || T.px[i] < l) l = T.px[i] }
    return { h, l }
  }
  bars30(): HtfBars { return { t: [], o: [], h: [], l: [], c: [], v: [], bv: [], av: [] } }
  names() { return ['synthetic'] }
  close() { /* nothing open */ }
}

const req: SnapshotRequest = {
  root: 'NQ', entryUtcMs: FILL_UTC, direction: 'short', entryPrice: 21000,
  atrStopTarget: 1, tp1RMultiple: 2, recordedStop: 21018, recordedTp: 20964, entryAtr: null,
}
const payload = (blind: boolean): DeepDivePayload => {
  const snapshot = buildSnapshot(blind ? req : { ...req, displayEndUtcMs: END_UTC }, new MemSource())
  return { trade: { id: 't', symbol: 'MNQZ6', inst: 'NQ' }, blind, snapshot, ...(blind ? {} : { exits: [{ time: snapshot.times.entry + 192, price: 21018, qty: 1 }] }), build_ms: 0 }
}
const blindPayload = payload(true)
const entrySec = blindPayload.snapshot.times.entry
const fillPtMs = utcToPtMs(FILL_UTC)
/** A Blind payload for a fill at any instant (to the millisecond). */
const blindAt = (entryUtcMs: number): DeepDivePayload =>
  ({ trade: { id: 't', symbol: 'MNQZ6', inst: 'NQ' }, blind: true, snapshot: buildSnapshot({ ...req, entryUtcMs }, new MemSource()), build_ms: 0 })
const rules = evaluateRules(FOUNDER_ENTRY_RULES, null, { direction: 'short', symbol: 'MNQZ6', entry_time: new Date(FILL_UTC).toISOString() })
const data = (p: DeepDivePayload): CoachReviewData => ({ payload: p, usesOrderFlow: true, rules, entryCtx: null, flow: null, stopBand: [0.5, 1.5], day: [] })

console.log('the input, built from the Blind cut')
const input = buildCoachReviewInput(data(blindPayload))
check('it has bars and bubbles to read', input.times.length > 300 && /40-TRADE BUBBLES/.test(input.text) && /FOOTPRINT/.test(input.text), input.times.length)
check('every bar and bubble time is before the fill', input.times.every(t => t * 1000 < fillPtMs), input.times.filter(t => t * 1000 >= fillPtMs).slice(0, 3).map(t => ptClock(t * 1000)))
check('the fill is 08:41:04 and the data stops at 08:41:03', input.fill === '08:41:04' && input.cutoff === '08:41:03', [input.fill, input.cutoff])
const fillTod = '08:41:04'
const laterTimes = timeLabelsIn(input.text).filter(t => (t.length === 8 ? t : `${t}:00`) > fillTod && !t.startsWith('13:'))
check('no clock time after the fill appears in it', laterTimes.length === 0, laterTimes.slice(0, 5))
check('the high after the fill (a price never seen before it) is not in it', postHi > preHi + 100 && !input.text.includes(postHi.toFixed(2)), { postHi, preHi })
check('the chart range in it ends at the pre-fill high', input.hi < postHi && input.hi >= preHi, { hi: input.hi, preHi, postHi })
check('it says what it couldn\'t see', input.unseen.includes('news') && input.unseen.includes('your DOM and resting orders') && input.unseen.includes('your entry rules at this fill'), input.unseen)
check('the stop and target it was given are in it', input.text.includes('Stop 21018.00 (recorded') && input.text.includes('Target 20964.00 (recorded'))

console.log('\nno order flow when the profile doesn\'t trade it')
{
  const plain = buildCoachReviewInput({ ...data(blindPayload), usesOrderFlow: false })
  check('no bubbles, footprint, delta or Tape Reader', !/BUBBLES|FOOTPRINT|delta|Tape Reader|ORDER FLOW/.test(plain.text))
  check('no DOM in couldn\'t see', !plain.unseen.some(s => /DOM/.test(s)), plain.unseen)
}

console.log('\nit refuses anything but the Blind cut')
const throws = (f: () => unknown) => { try { f(); return false } catch (e) { return e instanceof CoachReviewInputError } }
check('a Full review payload', throws(() => buildCoachReviewInput(data(payload(false)))))
{
  const full = payload(false)
  check('a Full review snapshot passed off as blind', throws(() => buildCoachReviewInput(data({ ...full, blind: true, exits: undefined }))))
  const b = structuredClone(blindPayload)
  const bars = b.snapshot.bars
  bars.t.push(bars.t[bars.t.length - 1] + 120); bars.o.push(21000); bars.h.push(21300); bars.l.push(20990); bars.c.push(21290)
  bars.v.push(500); bars.bv.push(100); bars.av.push(400); bars.d.push(300); bars.dmin.push(0); bars.dmax.push(300); bars.pv.push(0); bars.vv.push(500)
  b.snapshot.has_partial = false
  check('a Blind payload with a bar after the fill', throws(() => buildCoachReviewInput(data(b))))
  const c = structuredClone(blindPayload)
  if (c.snapshot.bubbles) c.snapshot.bubbles.t[c.snapshot.bubbles.t.length - 1] = entrySec + 5
  check('a Blind payload with a bubble after the fill', throws(() => buildCoachReviewInput(data(c))))
}

console.log('\na fill a fraction of a second after a trade in the same second (fills are stored to the millisecond)')
{
  // a trade at hh:mm:ss.xxx, then the fill 300 ms later in that same second: the forming bubble's last
  // trade is that trade, so the bubble is stamped with the fill's own second — and it is before the fill
  const i = UTC.findIndex(u => u >= FILL_UTC - 1800_000 && u % 1000 < 700)
  const fill = UTC[i] + 300, fillMs = utcToPtMs(fill)
  const p = blindAt(fill)
  const B = p.snapshot.bubbles
  const last = B ? B.t[B.t.length - 1] : null
  check('the case is real: the last bubble carries the fill\'s own second', last === p.snapshot.times.entry && fill % 1000 > 0,
    { last: last != null ? ptClock(last * 1000) : null, fill: new Date(fillMs).toISOString().slice(11, 23) })
  let built: CoachReviewInput | null = null
  try { built = buildCoachReviewInput(data(p)) } catch (e) { console.log(`       threw: ${(e as Error).message}`) }
  check('it builds: that bubble is before the fill', !!built)
  check('every time in it is before the exact fill', !!built && built.times.every(t => t * 1000 < fillMs))
  const q = structuredClone(blindPayload)
  if (q.snapshot.bubbles) q.snapshot.bubbles.t[q.snapshot.bubbles.t.length - 1] = entrySec
  check('with the fill exactly on the second, a bubble stamped with that second is refused', throws(() => buildCoachReviewInput(data(q))))
}

console.log('\nthe stop against the trader\'s own stop rule (0.5x to 1.5x their ATR stop, as the Score judges it)')
{
  check('the plan says where the stop sits against the rule', /x the 1m ATR: wider than their stop rule \(0\.5 to 1\.5 x the 1m ATR\)/.test(input.text), input.text.split('\n').find(l => l.startsWith('Stop ')))
  const inside = buildCoachReviewInput({ ...data(blindPayload), stopBand: [0.5, 20] })
  check('inside the band, it says inside', /: inside their stop rule \(0\.5 to 20 x the 1m ATR\)/.test(inside.text))
  const none = buildCoachReviewInput({ ...data(blindPayload), stopBand: null })
  check('no ATR stop rule: no judgement in the plan', !/stop rule/.test(none.text))
  check('your empty profile: the 1x default, 0.5 to 1.5', JSON.stringify(stopBandOf(null, 1)) === '[0.5,1.5]')
  check('a 2 ATR stop setting: 1 to 3', JSON.stringify(stopBandOf({ stop: { mode: 'atr', value: 2 } }, 2)) === '[1,3]')
  check('a points stop, or none, has no band', stopBandOf({ stop: { mode: 'pts', value: 10 } }, 1) === null && stopBandOf({ execution: { uses_orderflow: true } }, 1) === null)
  const owner = traderBlock({ profileBlock: '', sp: null, usesOrderFlow: true, atrStopTarget: 1, tp1RMultiple: 2 })
  check('the trader block gives the band, not the bare 1x', owner.includes('Their stop rule: anywhere from 0.5 to 1.5 x the 1m ATR is on their rule') && !/about 1 x the 1m ATR\./.test(owner), owner)
  const pts = traderBlock({ profileBlock: '', sp: { stop: { mode: 'pts', value: 10 } }, usesOrderFlow: false, atrStopTarget: 1, tp1RMultiple: 2 })
  check('a points stop: never tight or wide', pts.includes('10 points') && pts.includes('never call it tight or wide'), pts)
}

console.log('\nwhat the route reads')
{
  const cols = `${BLIND_TRADE_COLUMNS}, ${COACH_REVIEW_EXTRA}`.toLowerCase()
  // quantity is read on purpose: "Your day at the fill" sets this trade's size against the trader's usual and cap
  const banned = ['exit_', 'exits_json', 'pnl', 'tags_json', 'notes', 'screenshot', 'high_during', 'low_during', 'post_exit', 'mfe', 'mae']
  check('no exit, P&L, tags, notes, screenshot or excursion columns for this trade', banned.every(b => !cols.includes(b)), banned.filter(b => cols.includes(b)))
}

console.log('\nthe line checks')
{
  const firstBar = /\n(\d\d:\d\d) /.exec(input.text.slice(input.text.indexOf('1-MINUTE')))?.[1] ?? ''
  check('a time from the data passes', checkLine(`The ${firstBar} candle closed down.`, input) === null, firstBar)
  check('the fill time passes', checkLine('Your fill at 08:41:04 sat at the low.', input) === null)
  check('a time after the fill is dropped', checkLine('By 08:45 price was 30 points higher.', input) !== null)
  check('a second after the fill, inside its minute, is dropped', checkLine('A buyer hit at 08:41:30.', input) !== null)
  check('the high after the fill is dropped as off the chart', checkLine(`Price reached ${postHi.toFixed(2)}.`, input) !== null)
  check('the stop passes', checkLine('Your stop at 21018.00 sits above the swing.', input) === null)
  const parsed = parseCoachReview('```json\n' + JSON.stringify({
    observations: [
      { kind: 'look', text: 'Look at the footprint just before your fill.' },
      { kind: 'against', text: 'By 08:50 the bounce had kept going.' },
      { kind: 'for', text: 'You sold under VWAP with the 5m making lower highs.' },
      { kind: 'against', text: 'Price had bounced off the session low first.' },
    ],
  }) + '\n```')
  const done = parsed && finishCoachReview(parsed, input, { model: 'm', at: new Date().toISOString(), key: { trade: 'a', rules: 'b', profile: 'c' } })
  check('fenced JSON parses', !!parsed && parsed.items.length === 4)
  check('the after-the-fill line is dropped, the rest kept in For / Against / Look at order', !!done && JSON.stringify(done.items.map(i => i.kind)) === '["for","against","look"]', done?.items)
  check('couldn\'t see is what was never sent', !!done && JSON.stringify(done.unseen) === JSON.stringify(input.unseen), done?.unseen)
  check('nothing usable: no review', finishCoachReview({ items: [{ kind: 'for', text: 'By 09:30 it had run 40 points.' }] }, input, { model: 'm', at: '', key: { trade: '', rules: '', profile: '' } }) === null)
  check('a dollar amount is not read as a price', checkLine('Your day was up $25,000 before this trade.', input) === null)
}

console.log('\nthe coach\'s call')
{
  const key = { trade: '', rules: '', profile: '' }
  const items = [{ kind: 'for' as const, text: 'You sold under VWAP with the 5m making lower highs.' }]
  const parsed = parseCoachReview(JSON.stringify({ observations: items, call: { kind: 'mistake', why: 'Sellers met your price, but you sold a bounce with buyers still leading.' } }))
  check('the call parses', parsed?.call?.kind === 'mistake' && !!parsed.call.why, parsed?.call)
  const done = parsed && finishCoachReview(parsed, input, { model: 'm', at: '', key })
  check('a call that passes the checks is kept', done?.call?.kind === 'mistake', done?.call)
  check('it always takes a side: "unsure" is not a call', parseCoachReview(JSON.stringify({ observations: items, call: { kind: 'unsure', why: 'It is split between the sellers and the bounce.' } }))?.call === null)
  check('…and the schema only offers good or mistake', JSON.stringify(COACH_REVIEW_SCHEMA.properties.call.properties.kind.enum) === '["good","mistake"]' && !/"unsure"|Unsure:/.test(COACH_REVIEW_SYSTEM))
  const late = finishCoachReview({ items, call: { kind: 'mistake', why: 'By 08:50 the bounce had kept going against you.' } }, input, { model: 'm', at: '', key })
  check('a call whose line names a time after the fill is dropped, the points stay', !!late && late.call === null && late.items.length === 1)
  check('an unknown call word is not a call', parseCoachReview(JSON.stringify({ observations: items, call: { kind: 'great', why: 'x x x x x x x x' } }))?.call === null)
}

console.log('\nyour day at the fill (worked out from your trades and rules, only what was known at the fill)')
{
  const at = (hms: string) => `2026-10-15T${hms}Z`
  const fill = Date.parse(at('14:22:00'))                       // 07:22:00 PT
  const T = (id: string, e: string, x: string | null, pnl: number, qty: number, exits?: string[]): DayTrade =>
    ({ id, symbol: 'MNQZ6', entry_time: at(e), exit_time: x ? at(x) : null, exits_json: exits ? exits.map(s => ({ time: at(s) })) : null, pnl, quantity: qty })
  const day: DayTrade[] = [
    T('a', '13:40:00', '13:52:00', 120, 5),
    T('b', '14:10:00', '14:20:08', -95, 5),                      // out 1m 52s before the fill, a loss
    T('d', '14:15:00', '14:40:00', -300, 2, ['14:21:00', '14:40:00']),   // still open at the fill: no result yet
    T('this', '14:22:00', '14:30:00', -999, 5),                  // the trade under review
    T('e', '15:00:00', '15:10:00', 500, 5),                      // after the fill
  ]
  const usual = { typical: 5, pct: 62, n: 130 }
  const lines = dayAtFill({ tradeId: 'this', fillUtcMs: fill, symbol: 'MNQZ6', quantity: 5, day, rails: OWNER_RAILS, usual })
  const want = [
    ['4th trade today. Your cap: 7.', 'kept'],
    ['5 MNQ. Your usual on MNQ: 5 (62% of your MNQ trades). Your cap: 5 (10 on a size-up).', 'your usual'],
    ['1m 52s after your last exit.', null],
    ['Your last trade lost $95. This is a re-entry 1m 52s after it. Your cooldown: 1m 30s.', 'kept'],
    ['5 MNQ after that loss (it was 5). Your cap after a loss: 5.', 'kept'],
    ['Day up $25 before this trade: $525 from your $500 daily loss limit.', 'room left'],
  ]
  check('your rules, as the mockup reads', JSON.stringify(lines.map(l => [l.fact, l.status])) === JSON.stringify(want), lines)
  check('this trade\'s own result, a trade still open at the fill and a later trade are not in it', !lines.some(l => /999|300|500 up|\$275/.test(l.fact)))
  const quick = dayAtFill({ tradeId: 'this', fillUtcMs: Date.parse(at('14:20:38')), symbol: 'MNQZ6', quantity: 5, day, rails: OWNER_RAILS, usual })
  const cd = quick.find(l => l.fact.startsWith('Your last trade lost'))
  check('30 s after a loss with a 90 s cooldown: broken', !!cd && cd.broken && cd.status === 'inside your cooldown', cd)
  const big = dayAtFill({ tradeId: 'this', fillUtcMs: fill, symbol: 'MNQZ6', quantity: 12, day, rails: OWNER_RAILS, usual })
  check('12 MNQ over a 5 (10 on a size-up) cap: over your cap', big[1].status === 'over your cap' && big[1].broken, big[1])
  const up = dayAtFill({ tradeId: 'this', fillUtcMs: fill, symbol: 'MNQZ6', quantity: 8, day, rails: OWNER_RAILS, usual })
  check('8 MNQ: a size-up, not a break', up[1].status === 'a size-up' && !up[1].broken, up[1])
  const none = dayAtFill({ tradeId: 'this', fillUtcMs: fill, symbol: 'MNQZ6', quantity: 5, day, rails: UNTRACKED_RAILS, usual })
  check('no rules set: facts only, no cooldown, cap or limit lines', JSON.stringify(none.map(l => l.status)) === '[null,"your usual",null,null]' && !none.some(l => /cap|cooldown|limit/i.test(l.fact)), none)
  const first = dayAtFill({ tradeId: 'this', fillUtcMs: fill, symbol: 'MNQZ6', quantity: 5, day: [day[3]], rails: OWNER_RAILS, usual })
  check('the first trade of the day: no exit, loss or day lines', first.length === 2 && first[0].fact === '1st trade today. Your cap: 7.', first)
  const recent = [...Array(9)].map(() => ({ symbol: 'MNQZ6', quantity: 5 })).concat([{ symbol: 'MNQZ6', quantity: 10 }, { symbol: 'MESZ6', quantity: 10 }])
  check('your usual: the most common size on that instrument, from 8 trades', JSON.stringify(usualSizeOf(recent, 'MNQ')) === '{"typical":5,"pct":90,"n":10}' && usualSizeOf(recent, 'MES') === null)
  const withDay = buildCoachReviewInput({ ...data(blindPayload), day: lines })
  check('the coach gets the same lines', withDay.text.includes("THE TRADER'S DAY AT THE FILL") && withDay.text.includes('Your cap after a loss: 5. [kept]'))
  check('…and still nothing from the fill on', withDay.times.every(t => t * 1000 < fillPtMs))
}

console.log(failed ? `\n${failed} FAILED` : '\nall coach-review checks passed')
process.exit(failed ? 1 : 0)
