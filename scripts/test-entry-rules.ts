/**
 * Entry rules — the pure parts (src/lib/entry-rules.ts and how Entry uses them).
 * No data needed; the parity with the research lives in test-entry-rules-parity.ts.
 *
 *   npx tsx scripts/test-entry-rules.ts
 */
import {
  evaluateRule, evaluateRules, tradeRulesScore, rulesChip, readEntryRules, entryRulesSig, ruleTally, newEntryRule,
  FOUNDER_ENTRY_RULES, type EntryRuleConfig,
} from '../src/lib/entry-rules.ts'
import { blendAxis, PART_WEIGHTS } from '../src/lib/tapescore-axes.ts'
import { dayTradeInputs } from '../src/lib/exit-rollup.ts'
import type { EntryCtxBar, TradeEntryCtx } from '../src/lib/supabase/types.ts'

let failed = 0
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }

const bar = (t: string, o: number, c: number, extra: Partial<EntryCtxBar> = {}): EntryCtxBar =>
  ({ t, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100, d: 0, atr: 4, mv: 100, md: 20, ha: (Math.sign(c - o) as -1 | 0 | 1), ...extra })
const ctx = (bars: EntryCtxBar[], tape: number | null = 0): TradeEntryCtx => ({ v: 'ectx-1', src: '', read_at: '08:42:13', bars, tape, tape_clock: tape, at: '' })
const long = { direction: 'long', symbol: 'MNQZ6.CME', entry_time: '2026-10-14T15:42:13Z' }
const short = { ...long, direction: 'short' }
const rule = (type: EntryRuleConfig['type'], patch: Partial<EntryRuleConfig> = {}) => ({ ...newEntryRule(type, 'X', '2026-01-01', 'x'), ...patch })

console.log('candles against')
{
  const three = ctx([bar('08:38', 10, 12), bar('08:39', 12, 11), bar('08:40', 11, 10), bar('08:41', 10, 9)])
  const r = evaluateRule(rule('candles_against'), three, long)
  check('3 red before a long fails L1, with the three times', r.status === 'fail' && r.reason === '08:39, 08:40 and 08:41 all closed red before your long.')
  check('the same candles pass for a short', evaluateRule(rule('candles_against'), three, short).status === 'pass')
  const doji = ctx([bar('08:39', 12, 11), bar('08:40', 11, 10), bar('08:41', 10, 10)])
  check('a flat last candle ends the run (pass)', evaluateRule(rule('candles_against'), doji, long).status === 'pass')
  check('a flat last candle passes "last candle my way"', evaluateRule(rule('last_candle'), doji, long).status === 'pass')
}
console.log('large candle against')
{
  const big = ctx([bar('08:39', 10, 11), bar('08:40', 20, 11, { h: 20.4, l: 10.8 }), bar('08:41', 11, 12)])
  const r = evaluateRule(rule('large_against'), big, long)
  check('a 9.6-pt red candle (body 94%) on a 4-pt ATR fails for a long', r.status === 'fail' && /08:40 was a large red candle: range 2\.4× ATR, body 94%/.test(r.reason))
  check('it is not against a short', evaluateRule(rule('large_against'), big, short).status === 'pass')
  check('no ATR → unknown, never a guess', evaluateRule(rule('large_against'), ctx(big.bars.map(b => ({ ...b, atr: null }))), long).status === 'unknown')
  check('no fade: the same large red candle fails F3 for a long', evaluateRule(rule('fade_spike'), big, long).status === 'fail')
  const spike = ctx([bar('08:39', 10, 11), bar('08:40', 11, 11.5, { v: 250, d: -60 }), bar('08:41', 11, 12)])
  const s = evaluateRule(rule('fade_spike'), spike, long)
  check('a delta spike down 2 min before a long fails F3', s.status === 'fail' && /delta spike down at 08:40 \(volume 2\.5×, delta 3\.0× the 10-minute median\), 2 minutes before the fill/.test(s.reason))
}
console.log('tape')
{
  check('band ±2: −3.4 fails a long', evaluateRule(rule('tape'), ctx([bar('08:41', 1, 2)], -3.4), long).status === 'fail')
  check('band ±2: +2.7 fails (outside the band on your side)', /on your side/.test(evaluateRule(rule('tape'), ctx([bar('08:41', 1, 2)], 2.7), long).reason))
  check('not against: +3 is against a short', evaluateRule(rule('tape', { mode: 'not_against' }), ctx([bar('08:41', 1, 2)], 3), short).status === 'fail')
  check('not against: −1.9 passes a long', evaluateRule(rule('tape', { mode: 'not_against' }), ctx([bar('08:41', 1, 2)], -1.9), long).status === 'pass')
  check('pressure: −5.9 passes a long, −6 fails', evaluateRule(rule('tape', { mode: 'pressure' }), ctx([bar('08:41', 1, 2)], -5.9), long).status === 'pass'
    && evaluateRule(rule('tape', { mode: 'pressure' }), ctx([bar('08:41', 1, 2)], -6), long).status === 'fail')
  check('ES uses its own band', evaluateRule(rule('tape', { es: 3 }), ctx([bar('08:41', 1, 2)], 2.5), { ...long, symbol: 'MESZ6.CME' }).status === 'pass')
}
console.log('Heiken Ashi')
{
  const two = ctx([bar('08:39', 12, 11), bar('08:40', 10, 11), bar('08:41', 11, 12)])
  check('green on the last 2 fails a long', evaluateRule(rule('ha_run'), two, long).status === 'fail')
  check('one green candle passes', evaluateRule(rule('ha_run'), ctx(two.bars.slice(0, 2)), long).status === 'pass')
}
console.log('no tape, counting, scoring')
{
  const r = evaluateRules(FOUNDER_ENTRY_RULES, null, long)
  check('no snapshot → every rule unknown', r.every(x => x.status === 'unknown'))
  check('nothing known → no score', tradeRulesScore(r) === null)
  const sep29 = { ...long, entry_time: '2026-09-29T15:53:00Z' }
  const res = evaluateRules(FOUNDER_ENTRY_RULES, ctx([bar('08:50', 12, 11), bar('08:51', 11, 10), bar('08:52', 10, 9)]), sep29)
  check('on Sep 29 only F3/F5/F6 count (L-rules start Oct 14)', res.filter(x => x.counted).map(x => x.name).join() === 'F3,F5,F6')
  check('the score is the share of COUNTED rules passed', tradeRulesScore(res) === res.filter(x => x.counted && x.status === 'pass').length / res.filter(x => x.counted && x.status !== 'unknown').length)
  check('chip: 7/7 green, 1/7 red, 5/7 neutral',
    rulesChip(Array(7).fill({ status: 'pass', counted: true }) as never).tone === 'ok'
    && rulesChip([{ status: 'pass' }, ...Array(6).fill({ status: 'fail' })] as never).tone === 'bad'
    && rulesChip([...Array(5).fill({ status: 'pass' }), ...Array(2).fill({ status: 'fail' })] as never).tone === 'mid')
}
console.log('settings')
{
  const read = readEntryRules([{ type: 'candles_against', n: 50, name: 'L1', from: '2026-10-14', id: 'a' }, { type: 'nonsense' }, null, { type: 'tape', mode: 'weird', nq: '2.5' }])
  check('malformed rules dropped, numbers clamped (N ≤ 10)', read.length === 2 && read[0].n === 10 && read[1].mode === 'band' && read[1].nq === 2.5)
  check('the sig ignores names and changes with numbers',
    entryRulesSig(FOUNDER_ENTRY_RULES) === entryRulesSig(FOUNDER_ENTRY_RULES.map(r => ({ ...r, name: 'renamed' })))
    && entryRulesSig(FOUNDER_ENTRY_RULES) !== entryRulesSig(FOUNDER_ENTRY_RULES.map(r => (r.type === 'ha_run' ? { ...r, n: 3 } : r))))
  check('no rules on → empty sig', entryRulesSig([]) === '' && entryRulesSig(FOUNDER_ENTRY_RULES.map(r => ({ ...r, on: false }))) === '')
  const t = ruleTally(rule('candles_against', { from: '2026-10-14' }), [
    { ...long, pnl: 100, ctx: ctx([bar('08:41', 1, 2)]) },
    { ...long, pnl: -50, ctx: ctx([bar('08:39', 3, 2), bar('08:40', 2, 1), bar('08:41', 1, 0)]) },
    { ...long, entry_time: '2026-10-01T15:00:00Z', pnl: -50, ctx: null },
    { ...long, pnl: 10, ctx: null },
  ])
  check('tally: pass 1 won, fail 1 lost, 1 unknown, the trade before the start date left out', t.pass.n === 1 && t.pass.wins === 1 && t.fail.n === 1 && t.fail.pf === 0 && t.unknown === 1)
}
console.log('Entry')
{
  check('weights: rules 30 and the other three keep 45 / 35 / 20 exactly',
    PART_WEIGHTS.entryRules === 0.3 && Math.abs(PART_WEIGHTS.checklist / 0.7 - 0.45) < 1e-12 && Math.abs(PART_WEIGHTS.flow / 0.7 - 0.35) < 1e-12 && Math.abs(PART_WEIGHTS.plan / 0.7 - 0.2) < 1e-12)
  const without = blendAxis('entry', { checklist: { score: 62, n: null }, entryRules: { score: null, n: 0 }, flow: { score: 55, n: 7 }, plan: { score: 80, n: null } })
  check('no counted rule → Entry exactly as the old 45/35/20', Math.abs(without.score! - (0.45 * 62 + 0.35 * 55 + 0.2 * 80)) < 1e-9)
  const withR = blendAxis('entry', { checklist: { score: 62, n: null }, entryRules: { score: 48, n: 7 }, flow: { score: 55, n: 7 }, plan: { score: 80, n: null } })
  check('with rules: 31.5 / 30 / 24.5 / 14', Math.abs(withR.score! - (0.315 * 62 + 0.3 * 48 + 0.245 * 55 + 0.14 * 80)) < 1e-9 && withR.parts.entryRules.weight === 0.3)
  const day = dayTradeInputs([{ direction: 'long', symbol: 'MNQ', entry_time: '2026-10-14T15:42:13Z', entry_ctx: ctx([bar('08:39', 3, 2), bar('08:40', 2, 1), bar('08:41', 1, 0)], 0) } as never], 1, FOUNDER_ENTRY_RULES)
  check('a day stores the rules part and the sig it used', day.entryRules.n === 1 && day.rules_sig === entryRulesSig(FOUNDER_ENTRY_RULES))
  const none = dayTradeInputs([{ direction: 'long', symbol: 'MNQ', entry_time: '2026-10-14T15:42:13Z' } as never], 1, [])
  check('a trader with no rules has no rules part', none.entryRules.n === 0 && none.rules_sig === '')
}

console.log(failed ? `\n${failed} FAILED` : '\nall entry-rules checks passed')
process.exit(failed ? 1 : 0)
