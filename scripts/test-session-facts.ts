/**
 * Unit tests for the precomputed session facts + the A9 fact-claim checker
 * (src/lib/session-facts.ts, ai-constraints.ts::checkFactClaims).
 *   npx tsx scripts/test-session-facts.ts
 *
 * The headline fixture is the REAL 2026-07-28 session, because that is the one
 * whose analysis got half its numbers wrong. Every assertion below is a claim
 * the model actually made and got wrong.
 */
import { computeSessionFacts, sessionFactsBlock, type FactTrade } from '../src/lib/session-facts.ts'
import { checkFactClaims } from '../src/lib/ai-constraints.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── The real session, verbatim from the DB ──────────────────────────────────
const t = (
  entry: string, exit: string, symbol: string, dir: 'long' | 'short',
  pnl: number, entryPrice: number, hi: number, lo: number, atr: number, conf: number,
): FactTrade => ({
  entry_time: `2026-07-28T${entry}Z`, exit_time: `2026-07-28T${exit}Z`,
  symbol, direction: dir, pnl, entry_price: entryPrice,
  high_during_position: hi, low_during_position: lo, entry_atr_1m: atr, quantity: 5,
  tags_json: { confluences: Array.from({ length: conf }, (_, i) => `c${i}`), setups: ['s'] },
})
const SESSION: FactTrade[] = [
  t('15:11:00', '15:12:16', 'MNQU6.CME', 'short', -213.00, 27817.0, 27832.25, 27795.5, 19.4, 2),
  t('15:13:00', '15:14:09', 'MNQU6.CME', 'short', -237.50, 27855.0, 27869.25, 27831.75, 19.4, 3),
  t('15:32:00', '15:34:03', 'MNQU6.CME', 'long',  330.00, 27959.0, 27989.25, 27956.25, 19.4, 2),
  t('16:11:00', '16:13:34', 'MNQU6.CME', 'long', -140.50, 28017.0, 28043.50, 28016.75, 19.4, 3),
  t('16:15:00', '16:15:33', 'MNQU6.CME', 'long', -100.00, 28005.0, 28013.75, 27993.0, 19.4, 5),
  t('16:24:00', '16:30:09', 'MNQU6.CME', 'long', -160.00, 27992.0, 28006.75, 27973.75, 19.4, 3),
  t('16:35:00', '16:43:55', 'MESU6.CME', 'long',  500.00, 7468.5, 7478.50, 7468.25, 2.6, 6),
  t('17:15:00', '17:17:36', 'MESU6.CME', 'long', -112.50, 7471.5, 7473.50, 7469.75, 2.6, 3),
  t('17:19:00', '17:20:56', 'MESU6.CME', 'long',  375.00, 7470.0, 7479.00, 7469.5, 2.6, 7),
]
const f = computeSessionFacts(SESSION)

console.log('session-facts: tallies')
check('session record is 3W/6L of 9', f.n === 9 && f.wins === 3 && f.losses === 6)
const nq = f.byInstrument.find(x => x.root === 'MNQ')!
const es = f.byInstrument.find(x => x.root === 'MES')!
check('NQ is 1W/5L of 6 (the model got this one right)', nq.n === 6 && nq.wins === 1 && nq.losses === 5)
check('ES is 2W/1L of 3 — the model claimed 3/3', es.n === 3 && es.wins === 2 && es.losses === 1)

console.log('session-facts: re-entry gaps')
const gap = (from: number) => f.gaps.find(g => g.from === from)?.seconds
check('T1→T2 is 44s, not the 60s claimed', gap(1) === 44)
check('T4→T5 is 86s (the one it got roughly right)', gap(4) === 86)
check('T8→T9 is 84s, not the "2 minutes" claimed', gap(8) === 84)
check('gaps are NOT monotone — 44 → 86 → 84 kills "the gap lengthens"',
  !(gap(1)! < gap(4)! && gap(4)! < gap(8)!))
check('a gap after a losing trade is marked', f.gaps.find(g => g.from === 8)?.afterLoss === true)
check('a gap after a winning trade is not', f.gaps.find(g => g.from === 3)?.afterLoss === false)

console.log('session-facts: per-trade counts + MFE')
const tf = (i: number) => f.trades.find(x => x.idx === i)!
check('T3 has 2 confluences — the model said T3/T7/T9 "each list 4-7"', tf(3).confluences === 2)
check('T5 has 5 confluences — the model said T1/T2/T5 "list 2-3"', tf(5).confluences === 5)
check('T8 MFE is 2.0 pts, not the 0.5 claimed', tf(8).mfePts === 2)
check('MFE is direction-aware for shorts (T1 = entry − low)', tf(1).mfePts === 21.5)
check('MFE in ATR is computed when ATR is present', tf(8).mfeAtr === 0.77)
check('winners/losers are flagged per trade', tf(3).win === true && tf(4).win === false)

console.log('session-facts: prompt block')
const block = sessionFactsBlock(f)
check('block carries the anchor phrases the drift test guards',
  block.includes('NEVER RECALCULATE') && block.includes('NO INVENTED TRENDS'))
check('block states the ES record correctly', /MES: 2W\/1L of 3/.test(block))
check('block lists the real gaps', block.includes('T1→T2: 44s') && block.includes('T8→T9: 84s'))
// The FULL sequence, not a flattering subset — the bogus "gap lengthens" claim
// was built by picking 3 of these 8 values.
check('block quotes the whole gap sequence so a trend claim is checkable',
  block.includes('44s → 1071s → 2217s → 86s → 507s → 291s → 1865s → 84s'))
check('empty session yields no block', sessionFactsBlock(computeSessionFacts([])) === '')

console.log('A9: fact-claim checking')
const v = (text: string) => checkFactClaims(text, f)
check('catches the real "3/3 ES" error', v('3/3 ES supply/demand trades hit TP').length === 1)
check('accepts the correct "1/6" NQ claim', v('NQ went 1/6 on the day').length === 0)
check('accepts the correct "2/3" ES claim', v('ES went 2 of 3 today').length === 0)
check('catches "T1→T2 was 60s"', v('T1→T2 was 60s').length === 1)
check('catches "T8→T9 was 2 minutes"', v('T8→T9 was 2 minutes').length === 1)
check('tolerates "T4→T5 was 90 seconds" for an 86s gap', v('T4→T5 was 90 seconds').length === 0)
check('evidence names both the claim and the truth',
  /claimed 2minutes \(120s\), actual 84s/.test(v('T8→T9 was 2 minutes')[0]?.evidence ?? ''))

// Conservatism — a false accusation costs more than a miss.
check('ignores a tally whose denominator we do not track', v('hit 4/7 of the targets').length === 0)
check('ignores an R-multiple that looks like a tally', v('captured 2/3R on the runner').length === 0)
check('ignores a non-consecutive pair we never measured', v('T1→T9 was 200 minutes').length === 0)
check('ignores prose with no numbers', v('The session showed clear tilt after the first loss.').length === 0)
check('no facts ⇒ no violations', checkFactClaims('3/3 hit TP', computeSessionFacts([])).length === 0)
// A denominator shared by two groups must union both, never false-flag.
check('ambiguous shared denominator does not false-flag', v('you were 5/6 on discipline').length === 0)

console.log(failures === 0 ? '\nAll session-facts tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
