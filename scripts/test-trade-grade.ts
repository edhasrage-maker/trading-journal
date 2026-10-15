/**
 * The trade's Score (src/lib/trade-grade.ts), the rule one-liners and the rule
 * mistake tags (src/lib/rule-tags.ts) — pure, no data needed. The wording is
 * the approved mockup's (docs/trade-grade-mockup.html).
 *
 *   npx tsx scripts/test-trade-grade.ts
 */
import { FOUNDER_ENTRY_RULES, ruleOneLiner, ruleMistakeTag, newEntryRule } from '../src/lib/entry-rules.ts'
import { newRunnerRule, runnerOneLiner, runnerMistakeTag, type RunnerRuleConfig } from '../src/lib/runner-rules.ts'
import { tradeGrade } from '../src/lib/trade-grade.ts'
import { mergeAutoMistakes, ruleMistakeTagsFor, allRuleMistakeTags } from '../src/lib/rule-tags.ts'
import type { EntryCtxBar, TradeEntryCtx, TradeFlowScore } from '../src/lib/supabase/types.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }

const RUNNER: RunnerRuleConfig[] = [
  newRunnerRule('scale_out', 'T1', '2026-10-14', 't1'), { ...newRunnerRule('runner_exit', 'T2', '2026-10-14', 't2'), be_ticks: 5 }, newRunnerRule('be_after_tp1', 'T3', '2026-10-14', 't3'),
]

console.log('one-liners and tags (as the mockup)')
{
  const lines = FOUNDER_ENTRY_RULES.map(ruleOneLiner)
  check('entry one-liners', JSON.stringify(lines) === JSON.stringify([
    'No 3 candles in a row against', 'Tape inside ±2', 'Last candle my way', 'No big candle against (last 3)',
    'No fading a big candle or spike (3 min)', 'Tape not 2+ against', 'Heiken Ashi not already my colour (2+)',
  ]), lines)
  check('runner one-liners', JSON.stringify(RUNNER.map(runnerOneLiner)) === JSON.stringify(['60% off at TP1', 'Runner out at BE, 4× ATR or 13:00', 'Breakeven only after TP1']), RUNNER.map(runnerOneLiner))
  const tags = FOUNDER_ENTRY_RULES.map(ruleMistakeTag)
  check('entry mistake tags', JSON.stringify(tags) === JSON.stringify([
    '3+ candles in a row against', 'Tape outside ±2', 'Last candle against', 'Big candle against',
    'Faded a big candle or spike', 'Tape 2+ against', 'Heiken Ashi already my colour',
  ]), tags)
  check('runner mistake tags (T3 has none)', JSON.stringify(RUNNER.map(runnerMistakeTag)) === JSON.stringify(['Under 60% at TP1', 'Runner closed by hand', null]))
  check('a number change moves the line and the tag', ruleOneLiner({ ...FOUNDER_ENTRY_RULES[0], n: 4 }) === 'No 4 candles in a row against' && ruleMistakeTag({ ...FOUNDER_ENTRY_RULES[0], n: 4 }) === '4+ candles in a row against')
  check('a different ES band is named', ruleOneLiner({ ...FOUNDER_ENTRY_RULES[1], es: 2.5 }) === 'Tape inside ±2 (ES 2.5)')
  check('library list = every rule\'s tag, once', allRuleMistakeTags(FOUNDER_ENTRY_RULES, RUNNER).length === 9)
}

const PT = (date: string, hms: string) => new Date(`${date}T${hms}-07:00`).toISOString()
const bar = (t: string, o: number, c: number): EntryCtxBar => ({ t, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 100, d: 0, atr: 4, mv: 100, md: 20, ha: Math.sign(c - o) as -1 | 0 | 1 })
const ctx = (bars: EntryCtxBar[], tape = 0): TradeEntryCtx => ({ v: 'ectx-1', src: '', read_at: '08:19:16', bars, tape, tape_clock: tape, at: '' })
const flow = (total: number): TradeFlowScore => ({ v: 'flow-4', total, max: 100, facts: [], read_at: '08:19:16', at: '' })

console.log('the grade')
{
  // a short on Oct 14 whose last 4 candles closed green (L1, L3 fail), tape +3.1 (L2, F5 fail) → 3 of 7
  const t = {
    id: 'a', pnl: 299, direction: 'short' as const, symbol: 'MNQZ6.CME', quantity: 3, entry_price: 30428, exit_price: 30351, stop_price: 30442, tp1_price: 30398,
    high_during_position: 30431, low_during_position: 30351, entry_atr_1m: 20.1, entry_time: PT('2026-10-14', '08:19:16'),
    exits_json: [{ time: PT('2026-10-14', '08:29:22'), qty: 1, price: 30392.5 }, { time: PT('2026-10-14', '08:29:24'), qty: 1, price: 30391 }, { time: PT('2026-10-14', '08:37:04'), qty: 1, price: 30351 }],
  }
  const c = ctx([bar('08:14', 11, 10), bar('08:15', 10, 11), bar('08:16', 11, 12), bar('08:17', 12, 13), bar('08:18', 13, 14)], 3.1)
  const g = tradeGrade(t, { entryRules: FOUNDER_ENTRY_RULES, runnerRules: RUNNER, flow: flow(84), entryCtx: c })
  check('entry rules 3 of 7 → 43', Math.round(g.parts.entryRules!) === 43, g.parts)
  check('Entry = rules 55% / order flow 45% → 61', g.entry === 61, g.entry)
  check('Exit: target + runner 2/2 → 100; stop never in play', g.exit === 100 && g.parts.stopRespected == null && g.parts.runnerOwn === true, g.parts)
  check('Score = Entry and Exit averaged → 81 (the mockup\'s 08:19)', g.score === 81, g.score)
  const off = tradeGrade(t, { entryRules: FOUNDER_ENTRY_RULES, runnerRules: RUNNER, flow: flow(84), entryCtx: c, includeFlow: false })
  check('order-flow Score switched off → Entry is the rules alone', off.entry === 43 && off.flowScore === null)
  const none = tradeGrade(t, {})
  check('no rules, no Score → Entry absent, Score = Exit', none.entry === null && none.score === none.exit)
  const loser = tradeGrade({ ...t, pnl: -105, exit_price: 30448, low_during_position: 30420, high_during_position: 30449, exits_json: [{ time: PT('2026-10-14', '08:20:30'), qty: 3, price: 30448 }] },
    { entryRules: FOUNDER_ENTRY_RULES, runnerRules: RUNNER, flow: flow(62), entryCtx: c })
  check('a loser past its stop: Exit 0 (stop respected only)', loser.exit === 0 && loser.parts.kept == null, loser.parts)
}

console.log('rule mistake tags')
{
  const t = { direction: 'short', symbol: 'MNQZ6.CME', entry_time: PT('2026-10-14', '08:19:16'), review_json: { entry_ctx: ctx([bar('08:16', 11, 12), bar('08:17', 12, 13), bar('08:18', 13, 14)], 3.1) } }
  const next = ruleMistakeTagsFor(t, FOUNDER_ENTRY_RULES, RUNNER)
  check('counted fails → their tags', JSON.stringify(next) === JSON.stringify(['3+ candles in a row against', 'Tape outside ±2', 'Last candle against', 'Tape 2+ against']), next)
  const before = ruleMistakeTagsFor({ ...t, entry_time: PT('2026-09-29', '08:19:16') }, FOUNDER_ENTRY_RULES, RUNNER)
  check('Sep 29: L-rules don\'t count yet → only F-rule fails tag', JSON.stringify(before) === JSON.stringify(['Tape 2+ against']), before)
  check('no snapshot → no tags (unknown never tags)', ruleMistakeTagsFor({ ...t, review_json: {} }, FOUNDER_ENTRY_RULES, []).length === 0)

  const m1 = mergeAutoMistakes(['FOMO'], [], ['Last candle against'])
  check('added beside the trader\'s own tag; only the app\'s is claimed', JSON.stringify(m1) === JSON.stringify({ mistakes: ['FOMO', 'Last candle against'], auto: ['Last candle against'], changed: true }), m1)
  const m2 = mergeAutoMistakes(m1.mistakes, m1.auto, [])
  check('rule passes now (or switched off) → the app\'s tag comes off, FOMO stays', JSON.stringify(m2.mistakes) === '["FOMO"]' && m2.auto.length === 0 && m2.changed)
  const m3 = mergeAutoMistakes(['Last candle against'], [], ['Last candle against'])
  check('a tag the trader added themselves is never claimed', JSON.stringify(m3) === JSON.stringify({ mistakes: ['Last candle against'], auto: [], changed: false }), m3)
  const m4 = mergeAutoMistakes(m3.mistakes, m3.auto, [])
  check('…so it is never taken off', JSON.stringify(m4.mistakes) === '["Last candle against"]' && !m4.changed)
  const m5 = mergeAutoMistakes(['FOMO'], ['Last candle against'], ['Last candle against'])
  check('an app tag dropped by an older save comes back while the rule fails', JSON.stringify(m5.mistakes) === '["FOMO","Last candle against"]' && m5.changed)
  const m6 = mergeAutoMistakes(['FOMO', 'Last candle against'], ['Last candle against'], ['Last candle against'])
  check('already up to date → nothing to write', !m6.changed)
  const m7 = mergeAutoMistakes(['3+ candles in a row against'], ['3+ candles in a row against'], ['4+ candles in a row against'])
  check('a rule\'s number changes → old tag swapped for the new one', JSON.stringify(m7.mistakes) === '["4+ candles in a row against"]' && m7.changed)
  check('a legacy single-string mistakes value is read', mergeAutoMistakes('FOMO', undefined, []).mistakes[0] === 'FOMO')
  void newEntryRule
}

console.log(failed ? `\n${failed} FAILED` : '\nall trade-grade checks passed')
process.exit(failed ? 1 : 0)
