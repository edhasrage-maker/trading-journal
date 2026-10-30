/**
 * Unit tests for Highlights' rule-code wording (src/lib/plain-rule-codes.ts).
 *   npx tsx scripts/test-plain-rule-codes.ts
 */
import { plainRuleCodes } from '../src/lib/plain-rule-codes.ts'

let failures = 0
const check = (name: string, got: string, want: string) => {
  if (got === want) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}\n      got:  ${got}\n      want: ${want}`) }
}

console.log('parenthetical codes beside words are dropped')
check('single', plainRuleCodes('Violating the size-up gate (P2).'), 'Violating the size-up gate.')
check('list', plainRuleCodes('Breached the post-loss cap (P2, P3) twice.'), 'Breached the post-loss cap twice.')
check('slash + and', plainRuleCodes('Both rails (P2/P3) and (P4 and P5) broke.'), 'Both rails and broke.')

console.log('bare codes become rule names')
check('sentence start', plainRuleCodes('P2 and P3 failed after losses.'), 'Your size cap and no size-up after a loss failed after losses.')
check('mid-sentence', plainRuleCodes('The -$844 net blew P1.'), 'The -$844 net blew your daily loss limit.')

console.log('leaves everything else alone')
check('no codes', plainRuleCodes('Stay at 5 MNQ after a loss.'), 'Stay at 5 MNQ after a loss.')
check('P6 untouched', plainRuleCodes('Legacy P6 row.'), 'Legacy P6 row.')
check('word containing P1', plainRuleCodes('MP1 is not a rule.'), 'MP1 is not a rule.')

if (failures) { console.error(`\n${failures} failing`); process.exit(1) }
console.log('\nall plain-rule-codes checks passed')
