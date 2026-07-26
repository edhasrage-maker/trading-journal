/**
 * Unit tests for the pure ranker behind the coach's proactive opener
 * (src/lib/coach-suggestions.ts::rankSuggestions).
 *
 *   npx tsx scripts/test-coach-suggestions.ts
 *
 * Plain tsx asserts, exits non-zero on first failure — same style as the other
 * test scripts. Only the pure ranking/templating is covered; gatherCoachSignals
 * is I/O and is exercised by the route in practice.
 */
import { rankSuggestions } from '../src/lib/coach-suggestions.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('rankSuggestions')

// Empty signals → no topics (clean/new account degrades to a generic greeting).
check('no signals → empty', rankSuggestions({}).length === 0)

// A costly mistake surfaces, templated with the real numbers.
const one = rankSuggestions({ costliestMistake: { label: 'FOMO', pnl: -1240, count: 18 } })
check('costly mistake surfaces', one.length === 1 && one[0].id === 'costliest-mistake')
check('line carries the $ and count', one[0]?.line.includes('−$1,240') && one[0].line.includes('18 tagged trades'))
check('followUp references the label', one[0]?.followUp.includes('FOMO'))

// A positive-P&L mistake is NOT a leak → dropped.
check('winning mistake dropped', rankSuggestions({ costliestMistake: { label: 'Early', pnl: 300, count: 5 } }).length === 0)

// Below-floor severity is filtered (a −$40 mistake is trivial).
check('tiny mistake below floor', rankSuggestions({ costliestMistake: { label: 'Nit', pnl: -40, count: 1 } }).length === 0)

// Ranking: bigger dollar leak outranks a smaller one; capped at max=3.
const many = rankSuggestions({
  costliestMistake: { label: 'FOMO', pnl: -1500, count: 20 },      // score ~1.0
  worstDayType: { label: 'Trend', avgPnl: -50, days: 4 },          // score 0.2
  breach: { breachDays: 6, analyzedDays: 10 },                     // score 0.6
  structureSkew: { better: 'fading', betterWr: 60, worseWr: 45, n: 40 }, // score 0.5
})
check('caps at 3', many.length === 3)
check('costliest first', many[0].id === 'costliest-mistake')
check('weakest (day-type 0.2) dropped for stronger three', !many.some(s => s.id === 'worst-day-type'))

// Breach needs ≥5 analyzed days; structure needs ≥20 trades.
check('breach with <5 days ignored', !rankSuggestions({ breach: { breachDays: 1, analyzedDays: 3 } }).some(s => s.id === 'process-breach'))
check('structure with <20 trades ignored', !rankSuggestions({ structureSkew: { better: 'following', betterWr: 70, worseWr: 40, n: 12 } }).some(s => s.id === 'structure-skew'))

// Structure skew templates the winning side.
const skew = rankSuggestions({ structureSkew: { better: 'fading', betterWr: 62, worseWr: 41, n: 55 } })
check('structure line names the better side + WRs', skew[0]?.line.includes('fading') && skew[0].line.includes('62%') && skew[0].line.includes('41%'))
check('structure followUp says fade', skew[0]?.followUp.includes('fade'))

console.log(failures === 0 ? '\nAll coach-suggestion tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
