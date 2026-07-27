/**
 * Unit tests for the deep-dive registry (src/lib/deep-dive/registry.ts) — the
 * routing + ranking layer both coach trigger paths depend on.
 *   npx tsx scripts/test-dive-registry.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import {
  SERVER_DIVES, UNAVAILABLE_DIVES, runDives, diveSuggestions, matchDiveIds,
  formatDiveForPrompt, diveContextBlock, diveInsights, mergeDiveInsights, toDiveRows,
  type DiveRow,
} from '../src/lib/deep-dive/registry.ts'
import type { DeepDiveResult } from '../src/lib/deep-dive/types.ts'
import type { RankedInsight } from '../src/lib/data-insights.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('dive-registry: routing')

check('routes a scale-out question', matchDiveIds('is scaling out actually paying me?').includes('scale-out-ev'))
check('routes a tilt question', matchDiveIds('do I revenge trade after a loss?').includes('tilt-cascade'))
check('routes a clock question', matchDiveIds('what time of day should I stop?').includes('time-of-day'))
check('a question can hit two dives', matchDiveIds('do I tilt in the afternoon?').length === 2)
check('ignores unrelated questions', matchDiveIds('how many trades did I take in January?').length === 0)
check('punctuation does not break matching', matchDiveIds('TP1 — worth it?').includes('scale-out-ev'))
// Whole-phrase matching: "open" must not fire on "opened".
check('matches whole words, not substrings', matchDiveIds('I opened a position too big').length === 0)
check('every opener follow-up routes back to its own dive',
  SERVER_DIVES.every(d => matchDiveIds(d.followUp).includes(d.id)))
check('stopped-reversal is listed as unavailable with a reason',
  UNAVAILABLE_DIVES.some(d => d.id === 'stopped-reversal' && d.reason.length > 40))
check('and is NOT registered as runnable', !SERVER_DIVES.some(d => d.id === 'stopped-reversal'))

console.log('dive-registry: running')

// 15 days × [win, loss, loss, big loss, big loss] ⇒ a real tilt cascade, and
// every trade carries a 2-event scale-out that gives the runner back.
const rows: DiveRow[] = []
let n = 0
for (let d = 0; d < 15; d++) {
  const day = `2026-06-${String(d + 1).padStart(2, '0')}`
  const pattern: [number, number][] = [[100, 2], [-100, 2], [-100, 2], [-120, 5], [-120, 5]]
  pattern.forEach(([pnl, qty], i) => {
    rows.push({
      id: `t${n++}`,
      entry_time: `${day}T${String(15 + i).padStart(2, '0')}:00:00Z`,
      direction: 'long',
      entry_price: 100,
      quantity: qty,
      pnl,
      symbol: 'MNQM6.CME',
      high_during_position: 112,
      low_during_position: 98,
      entry_atr_1m: 20,
      exits_json: [
        { qty: 3, price: 110, time: `${day}T${String(15 + i).padStart(2, '0')}:10:00Z` },
        { qty: 2, price: 100, time: `${day}T${String(15 + i).padStart(2, '0')}:20:00Z` },
      ],
    })
  })
}

const results = runDives(rows)
check('runs the registered dives', results.length >= 2)
check('sorted by severity, strongest first',
  results.every((r, i) => i === 0 || results[i - 1].severity >= r.severity))
check('finds the tilt cascade', results.some(r => r.id === 'tilt-cascade'))
check('finds the scale-out leak', results.some(r => r.id === 'scale-out-ev'))
check('never returns stopped-reversal', !results.some(r => r.id === 'stopped-reversal'))
check('an empty book yields no findings', runDives([]).length === 0)

// A dive that throws must not take the opener down with it.
const poisoned = rows.map(r => ({ ...r, exits_json: 'not-an-array' as unknown as DiveRow['exits_json'] }))
check('survives malformed rows', runDives(poisoned).some(r => r.id === 'tilt-cascade'))

console.log('dive-registry: opener + prompt')

const topics = diveSuggestions(results)
check('one topic per finding', topics.length === results.length)
check('topic line is the finding headline', topics[0]?.line === results[0].headline)
check('topic ids are namespaced', topics.every(t => t.id.startsWith('dive:')))
check('topic score is the severity', topics[0]?.score === results[0].severity)
check('every topic follow-up routes back to a dive', topics.every(t => matchDiveIds(t.followUp).length > 0))

const scaleOut = results.find(r => r.id === 'scale-out-ev')!
const prompt = formatDiveForPrompt(scaleOut)
check('prompt block carries the headline', prompt.includes(scaleOut.headline))
check('prompt block carries every segment', scaleOut.segments.every(s => prompt.includes(s.label)))
check('prompt block carries the test + impact', prompt.includes(scaleOut.test!.rule) && /modelled impact: [+−]\$/.test(prompt))
check('prompt block carries the basis', prompt.includes(scaleOut.test!.basis))

const block = diveContextBlock([scaleOut])
check('context block forbids recomputing', /Do NOT recompute/.test(block))
check('context block demands exact quoting', /quote its numbers EXACTLY/.test(block))
check('no dives ⇒ empty context block', diveContextBlock([]) === '')

// A question that routes to a dive which found NOTHING for this account must be
// reported as an empty result, not silently dropped — otherwise the model
// answers from the general context and it reads as though the dive said it.
const empty = diveContextBlock([], { matched: ['scale-out-ev'], tradeCount: 464 })
check('an investigation that found nothing is named', empty.includes('Is scaling out paying you?'))
check('and states it RAN', /RAN over their full book \(464 trades\)/.test(empty))
check('and forbids answering from other numbers', /Do NOT answer the question from other numbers/.test(empty))
check('unmatched dives are not mentioned', !empty.includes('The tilt cascade'))
const mixed = diveContextBlock([scaleOut], { matched: ['scale-out-ev', 'tilt-cascade'], tradeCount: 100 })
check('a mixed result carries both the finding and the gap',
  mixed.includes(scaleOut.headline) && mixed.includes('The tilt cascade'))
check('a matched dive that DID produce a finding is not also listed as empty',
  !/- Is scaling out paying you\?/.test(mixed))

// A finding with no test (the "you're already doing it right" shape) must render.
const noTest: DeepDiveResult = {
  id: 'x', title: 'T', headline: 'H', severity: 0.1,
  segments: [{ label: 'only', value: 1 }], detail: ['d'],
}
check('renders a finding that proposes no test', !formatDiveForPrompt(noTest).includes('PROPOSED TEST'))

console.log('dive-registry: "what your data already says" merge')

const asInsights = diveInsights(results)
check('one insight per finding', asInsights.length === results.length)
check('headline is a short claim, not the numbers', asInsights.every(i => !/\$|%/.test(i.headline)))
check('claims carry no trailing period (the renderer adds one)', asInsights.every(i => !i.headline.endsWith('.')))
check('detail carries the numbers', asInsights.some(i => /\$/.test(i.detail)))
check('a finding with a test is toned as a leak',
  asInsights.find(i => i.key === 'dive_scale_out_ev')?.tone === 'bad')
check('keys are namespaced so they cannot collide with contrast keys',
  asInsights.every(i => i.key.startsWith('dive_')))
check('footnote states the sample', /\d+ (trades|scale-outs)/.test(asInsights[0].footnote))

const classic: RankedInsight[] = [
  { key: 'time_of_day', dimension: 'Time of day', headline: 'Right after the open is your weak spot', detail: 'd', footnote: 'f', tone: 'bad', score: 0.9 },
  { key: 'capture_efficiency', dimension: 'Exits', headline: 'You keep less than half the move', detail: 'd', footnote: 'f', tone: 'bad', score: 0.85 },
  { key: 'instrument', dimension: 'Instrument', headline: 'NQ is your best book', detail: 'd', footnote: 'f', tone: 'good', score: 0.8 },
]
const merged = mergeDiveInsights(classic, results, 3)
check('merged list respects the limit', merged.length === 3)
check('the scale-out dive supersedes the capture read',
  !merged.some(i => i.key === 'capture_efficiency') && merged.some(i => i.key === 'dive_scale_out_ev'))
check('unrelated contrasts survive when there is room', mergeDiveInsights(classic, results, 5).some(i => i.key === 'instrument'))
// The time-of-day dive is capped out of this list (two stronger dives take the
// slots), so it must NOT suppress the contrast engine's time-of-day read — a
// finding that isn't shown can't supersede anything.
check('a dive capped out of the list suppresses nothing', merged.some(i => i.key === 'time_of_day'))
check('merged list is ranked by score',
  merged.every((i, n) => n === 0 || merged[n - 1].score >= i.score))
check('caps the dive share of the list', mergeDiveInsights(classic, results, 5).filter(i => i.key.startsWith('dive_')).length <= 2)
check('no findings ⇒ the contrast list is untouched',
  mergeDiveInsights(classic, [], 3).map(i => i.key).join(',') === 'time_of_day,capture_efficiency,instrument')

check('toDiveRows fills missing fields with null', toDiveRows([{ id: 'a' }])[0].pnl === null)
check('toDiveRows rejects a non-array exits_json',
  toDiveRows([{ id: 'a', exits_json: 'x' as unknown as DiveRow['exits_json'] }])[0].exits_json === null)

console.log(failures === 0 ? '\nAll dive-registry tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
