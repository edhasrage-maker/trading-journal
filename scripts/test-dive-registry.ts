/**
 * Unit tests for the deep-dive registry (src/lib/deep-dive/registry.ts) — the
 * routing + ranking layer both coach trigger paths depend on.
 *   npx tsx scripts/test-dive-registry.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import {
  SERVER_DIVES, UNAVAILABLE_DIVES, runDives, diveSuggestions, matchDiveIds,
  formatDiveForPrompt, diveContextBlock, type DiveRow,
} from '../src/lib/deep-dive/registry.ts'
import type { DeepDiveResult } from '../src/lib/deep-dive/types.ts'

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

// A finding with no test (the "you're already doing it right" shape) must render.
const noTest: DeepDiveResult = {
  id: 'x', title: 'T', headline: 'H', severity: 0.1,
  segments: [{ label: 'only', value: 1 }], detail: ['d'],
}
check('renders a finding that proposes no test', !formatDiveForPrompt(noTest).includes('PROPOSED TEST'))

console.log(failures === 0 ? '\nAll dive-registry tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
