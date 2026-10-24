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
import { buildCoachReviewInput, checkLine, finishCoachReview, parseCoachReview, timeLabelsIn, COACH_REVIEW_EXTRA, CoachReviewInputError, type CoachReviewData } from '../src/lib/coach-review.ts'
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
const rules = evaluateRules(FOUNDER_ENTRY_RULES, null, { direction: 'short', symbol: 'MNQZ6', entry_time: new Date(FILL_UTC).toISOString() })
const data = (p: DeepDivePayload): CoachReviewData => ({ payload: p, usesOrderFlow: true, rules, entryCtx: null, flow: null })

console.log('the input, built from the Blind cut')
const input = buildCoachReviewInput(data(blindPayload))
check('it has bars and bubbles to read', input.times.length > 300 && /40-TRADE BUBBLES/.test(input.text) && /FOOTPRINT/.test(input.text), input.times.length)
check('every bar and bubble time is before the fill', input.times.every(t => t < entrySec), input.times.filter(t => t >= entrySec).slice(0, 3).map(t => ptClock(t * 1000)))
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

console.log('\nwhat the route reads')
{
  const cols = `${BLIND_TRADE_COLUMNS}, ${COACH_REVIEW_EXTRA}`.toLowerCase()
  const banned = ['exit_', 'exits_json', 'pnl', 'quantity', 'tags_json', 'notes', 'screenshot', 'high_during', 'low_during', 'post_exit', 'mfe', 'mae']
  check('no exit, P&L, size, tags, notes, screenshot or excursion columns', banned.every(b => !cols.includes(b)), banned.filter(b => cols.includes(b)))
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
}

console.log(failed ? `\n${failed} FAILED` : '\nall coach-review checks passed')
process.exit(failed ? 1 : 0)
