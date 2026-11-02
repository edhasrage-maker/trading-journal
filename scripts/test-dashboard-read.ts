/**
 * Unit tests for the dashboard's written reads (src/lib/dashboard-read.ts).
 *   npx tsx scripts/test-dashboard-read.ts
 *
 * The fixture is the founder's last 30 days as of 2026-11-01 (P&L, TapeScore,
 * trade count per day) — the numbers the scoreboard mockup was drawn from.
 */
import {
  tradeCountSplit, periodFinding, splitNote, splitHistory, historyNote, dayReasons, bigDaysWhy, scoutingActions, unitAmount,
  type ReadDay,
} from '../src/lib/dashboard-read.ts'
import type { TapeScoreResult } from '../src/lib/tapescore.ts'
import type { LiftDragView } from '../src/lib/lift-drag.ts'

let failures = 0
const check = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`) }
}

const ts = (score: number, extra: Partial<TapeScoreResult> = {}): TapeScoreResult => ({
  score, band: score >= 70 ? 'high' : score >= 50 ? 'mid' : 'low', basis: 'v15',
  capped: false, chaseTrades: 0, chaseCapped: false, uncapped: score,
  components: { risk: 60, entry: 60, exit: 60, passCount: 5, railCount: 5, verdict: 'Compliant' },
  parts: null, ...extra,
})
const day = (date: string, pnl: number, score: number, trades: number, extra: Partial<ReadDay> = {}): ReadDay =>
  ({ date, eod_pnl: pnl, trade_count: trades, tapescore: ts(score), ...extra })

const BROKE: Partial<ReadDay> = { tapescore: ts(49, { capped: true }), process_breach_rules: ['P3'] }
const OCT: ReadDay[] = [
  day('2026-10-07', 229, 69, 6), day('2026-10-08', 263, 68, 6), day('2026-10-09', -287, 65, 5),
  day('2026-10-12', 200, 83, 2), day('2026-10-13', 162, 81, 3), day('2026-10-14', 295, 85, 4),
  day('2026-10-15', 198, 91, 1), day('2026-10-16', 74, 91, 2), day('2026-10-19', 773, 49, 8, BROKE),
  day('2026-10-20', 295, 69, 6), day('2026-10-21', 208, 84, 2), day('2026-10-22', 1297, 49, 11, BROKE),
  day('2026-10-23', 431, 79, 2), day('2026-10-26', 570, 67, 7),
  day('2026-10-27', 852, 69, 12, { tapescore: ts(69, { chaseTrades: 2, chaseCapped: true }) }),
  day('2026-10-28', 680, 85, 2), day('2026-10-29', -413, 49, 15, BROKE), day('2026-10-30', 174, 63, 14),
]

console.log('trade-count split')
const split = tradeCountSplit(OCT)
check('cuts at 4 trades', split?.k, 4)
check('few side', split && { days: split.few.days, green: split.few.green, avg: Math.round(split.few.avg), min: split.few.scoreMin, max: split.few.scoreMax },
  { days: 8, green: 8, avg: 281, min: 79, max: 91 })
check('many side', split && { days: split.many.days, green: split.many.green, red: split.many.red, avg: Math.round(split.many.avg), min: split.many.scoreMin, max: split.many.scoreMax },
  { days: 10, green: 8, red: 2, avg: 375, min: 49, max: 69 })
check('too few days → null', tradeCountSplit(OCT.slice(0, 4)), null)
check('no score gap → null', tradeCountSplit(OCT.map(d => ({ ...d, tapescore: ts(70) }))), null)

console.log('finding')
const f = periodFinding(OCT)
check('headline', f?.headline, 'Your three biggest days all scored under 70.')
check('bridge ties the big days to the table', f?.bridge, 'All three had 5 or more trades, and across the period the busier days scored lower:')
check('note', f?.note, 'More trades made more money. Every red day came from the busier days. None of the busier days scored above 69.')
const BIG = ['2026-10-22', '2026-10-27', '2026-10-19']
const wellTraded = OCT.map(d => BIG.includes(d.date) ? { ...d, tapescore: ts(91) } : d)
const worstTraded = OCT.map(d => d.date === '2026-10-27' ? { ...d, ...BROKE } : d)
check('big days all bottom third', periodFinding(worstTraded)?.headline, 'Your biggest days were your worst-traded days.')
check('big days scored top third', periodFinding(wellTraded)?.headline, 'Your biggest days were your best-traded days.')
check('note with split reds', splitNote({ k: 3, few: { days: 4, green: 3, red: 1, avg: 100, scoreMin: 70, scoreMax: 90, scoreAvg: 80 }, many: { days: 4, green: 3, red: 1, avg: 50, scoreMin: 60, scoreMax: 80, scoreAvg: 70 } }),
  'Fewer trades made more money. 1 of your 2 red days came from the busier days.')
check('split headline needs no bridge', periodFinding(OCT.map(d => d.date === '2026-10-22' ? { ...d, tapescore: ts(91) } : d))?.bridge ?? 'none', 'none')
check('under 6 scored days → null', periodFinding(OCT.slice(0, 5)), null)

console.log('day reasons')
check('rule break caps', dayReasons(day('2026-10-22', 1297, 49, 11, { tapescore: ts(49, { capped: true, chaseTrades: 3 }), process_breach_rules: ['P3'] })),
  ['Sized up after a loss', 'A broken rule caps the day at 49', '3 quick re-entries after a loss with no fresh trigger'])
check('chase cap said when not rule-capped', dayReasons(day('x', 1, 69, 5, { tapescore: ts(69, { chaseTrades: 2, chaseCapped: true }) })),
  ['2 quick re-entries after a loss with no fresh trigger (caps the day at 69)'])
check('glance lines', dayReasons(day('x', 1, 60, 11, {
  glance_read: {
    risk: { avg: 300, max: 400, usual: 150, ratio: 2, off: true },
    trades: { count: 11, usual: 4, ratio: 2.75, off: true },
    playbook: null,
    kept: { pct: null, usual: null, off: false },
    high: { peak: 900, bar: 400, reached: true, afterTrades: 4, afterPnl: -310, off: true },
    off: 3,
  },
})), ['Risked 2.0× your usual per trade', '11 trades; your usual is 4', 'Up $900 at the high, then gave back $310 over 4 more trades'])
check('clean day → none', dayReasons(day('x', 1, 90, 2)), [])

console.log('biggest days, why')
const why = bigDaysWhy(OCT)
check('title', why?.title, 'Why your biggest days scored under 70')
check('title, same score', bigDaysWhy(worstTraded)?.title, 'Why your biggest days scored 49')
check('days in order', why?.days.map(d => d.date), ['2026-10-22', '2026-10-27', '2026-10-19', '2026-10-29'])
check('twin note', why?.twinNote, 'Oct 29 scored the same 49 and lost $413. A score like theirs, the opposite result.')
check('well-traded big days → null', bigDaysWhy(wellTraded), null)
check('a big day with nothing flagged is left out', bigDaysWhy(OCT.map(d => d.date === '2026-10-27' ? { ...d, tapescore: ts(69) } : d))?.days.map(d => d.date),
  ['2026-10-22', '2026-10-19', '2026-10-29'])

console.log('what to do')
const view = {
  pf: 1.25, trades: 300, sessions: 60, from: '2026-07-23', to: '2026-10-30', candidates: 20, extended: true,
  lift: { key: 'a', label: 'Break of Clusters/Bubbles entries', n: 68, winRate: 0.4, pf: 2, restN: 232, restWinRate: 0.3, pfWithout: 0.85, delta: 0.39, lo: 0.2, hi: 0.5 },
  drag: { key: 'b', label: 'Entries 7:30–9:00 PT', n: 114, winRate: 0.3, pf: 0.8, restN: 186, restWinRate: 0.4, pfWithout: 1.67, delta: -0.43, lo: -0.6, hi: -0.2 },
} as LiftDragView
const acts = scoutingActions({ split, liftDrag: view, mgmt: { unit: 'dollars', wentCount: 53, neverCount: 55, wentMae: 82, neverMae: 118 } })
check('titles', acts.map(a => a.title), [
  'Keep the busy days, trade them cleaner',
  'Keep taking Break of Clusters/Bubbles entries',
  'Be pickier with entries 7:30–9:00 PT',
  'Treat a trade past $82 against you as a loser',
])
check('first why, busier days paid and no history', acts[0].why, 'Your 5+ trade days made +$375 a day against +$281, but they score lower and held every red day. Fix how you trade them, not how many.')

console.log('the days before the period')
// Busier days lost money before the period: -$60 a day over 6 days, quieter +$90 over 6.
const PRIOR: ReadDay[] = [
  ...[1, 2, 3, 4, 5, 6].map(i => day(`2026-09-0${i}`, -60, 55, 8)),
  ...[1, 2, 3, 4, 5, 6].map(i => day(`2026-09-1${i}`, 90, 80, 2)),
]
const hist = splitHistory(PRIOR, 4)
check('history split', hist && { many: [hist.many.days, Math.round(hist.many.avg)], few: [hist.few.days, Math.round(hist.few.avg)], from: hist.from },
  { many: [6, -60], few: [6, 90], from: '2026-09-01' })
check('too little history → null', splitHistory(PRIOR.slice(0, 8), 4), null)
check('history note, exception', historyNote(split!, hist!),
  'This period was the exception. Before it (since Sep 1, 2026), days with 5 or more trades averaged −$60 a day over 6 days; days with 4 or fewer, +$90 over 6.')
check('finding says the days before', periodFinding(OCT, PRIOR)?.before?.startsWith('This period was the exception'), true)
check('no history → no before line', periodFinding(OCT)?.before, null)
const withHist = scoutingActions({ split, history: hist, liftDrag: null, mgmt: null })
check('history says cap → stop at 4', withHist[0]?.title, 'Stop at 4 trades for a week')
check('stop why names both', withHist[0]?.why,
  'This period your 5+ trade days made more (+$375 a day against +$281). Before it they averaged −$60 a day against +$90 on days with 4 trades or fewer. This period those quieter days were all green and scored 79+.')
const PRIOR_BUSY = PRIOR.map(d => ({ ...d, eod_pnl: d.trade_count > 4 ? 200 : 50 }))
const busy = scoutingActions({ split, history: splitHistory(PRIOR_BUSY, 4), liftDrag: null, mgmt: null })
check('history agrees busier pays → keep busy days', busy[0]?.title, 'Keep the busy days, trade them cleaner')
check('same-direction note', historyNote(split!, splitHistory(PRIOR_BUSY, 4)!).startsWith('Before this period it was the same'), true)
check('pf source says the window', acts[1].source, 'Profit factor, last 60 sessions')
check('unit note', acts[3].note, 'In $ because Trade management is set to $. Switch it there and this follows.')
check('heat line needs a clear gap', scoutingActions({ split: null, liftDrag: null, mgmt: { unit: 'atr', wentCount: 53, neverCount: 55, wentMae: 0.5, neverMae: 0.55 } }), [])
check('atr amount', unitAmount(0.456, 'atr'), '0.46× ATR')

if (failures) { console.error(`\n${failures} failing`); process.exit(1) }
console.log('\nall dashboard-read checks passed')
