/**
 * Tests for the trade form's entry-time save (src/lib/trade-entry-time.ts).
 *   npx tsx scripts/test-trade-entry-time.ts
 *
 * The real case: an MES fill at 08:18:26.696 PT came back as 08:18:00 after
 * an edit that never touched the time — 176 imported trades were rounded so.
 */
import { entryTimeField, entryTimeForSave } from '../src/lib/trade-entry-time.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const FILL = '2026-10-08T15:18:26.696Z'          // 08:18:26.696 PT
const field = entryTimeField(FILL)               // what the form shows, browser-local

console.log('AN EDIT THAT LEAVES THE TIME ALONE KEEPS THE FILL TIME')
check('stored timestamp kept to the millisecond', entryTimeForSave(FILL, field, '2026-10-08') === FILL,
  String(entryTimeForSave(FILL, field, '2026-10-08')))
check('…even when the page date differs (a trade filed under another day)',
  entryTimeForSave(FILL, field, '2026-10-09') === FILL)

console.log('\nA CHANGED MINUTE IS WHAT THE TRADER TYPED')
const [h, m] = field.split(':').map(Number)
const later = `${String(h).padStart(2, '0')}:${String((m + 1) % 60).padStart(2, '0')}`
const rebuilt = entryTimeForSave(FILL, later, '2026-10-08')
check('rebuilt from the field, on the page date, at :00', rebuilt != null && rebuilt !== FILL && entryTimeField(rebuilt) === later &&
  new Date(rebuilt).getSeconds() === 0, String(rebuilt))

console.log('\nNEW TRADES AND BLANKS')
const fresh = entryTimeForSave(null, '06:45', '2026-10-08')
check('a new trade is built from the field', fresh != null && entryTimeField(fresh) === '06:45', String(fresh))
check('a blank field on a new trade saves no time', entryTimeForSave(null, '', '2026-10-08') === null)
check('clearing the field on a saved trade clears the time', entryTimeForSave(FILL, '', '2026-10-08') === null)

console.log(failures === 0 ? '\nAll entry-time tests pass.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
