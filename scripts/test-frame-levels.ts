/**
 * Unit tests for the recording-frame level guards (src/lib/frame-levels.ts).
 *   npx tsx scripts/test-frame-levels.ts
 * Plain tsx asserts; exits non-zero if anything failed.
 *
 * These guard the one thing that must not go wrong here: a stop the coach
 * misread reaching trades.stop_price, which silently corrupts R and heat for
 * every downstream number the journal computes.
 */
import { guardFrameLevels, autoApplicableFields } from '../src/lib/frame-levels.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('A CLEAN READ SURVIVES INTACT')
{
  // Real shape of trade #1 from 2026-08-10: short 7786.75, bracket 2pt / 7.5pt.
  const g = guardFrameLevels(
    { stop_price: 7788.75, tp1_price: 7779.25, stop_points: 2, tp1_points: 7.5, confidence: 'high', reasoning: 'both order lines legible' },
    { direction: 'short', entry_price: 7786.75 },
  )
  check('stop kept', g?.levels.stop_price === 7788.75)
  check('target kept', g?.levels.tp1_price === 7779.25)
  check('confidence kept at high', g?.levels.confidence === 'high')
  check('entry reported from the fill, not the model', g?.levels.entry_price === 7786.75)
  check('nothing to report', g?.notes.length === 0, JSON.stringify(g?.notes))
}

console.log('\nA LEG WITH ONLY A DISTANCE IS RECONSTRUCTED')
{
  // The real 2026-07-30 MES short: the limit read "(+12.50p)" but its axis price
  // never came through. 7415.50 - 12.50 = 7403.00 is fully determined.
  const g = guardFrameLevels(
    { stop_price: 7419.5, tp1_price: null, stop_points: 4, tp1_points: 12.5, confidence: 'medium', reasoning: '' },
    { direction: 'short', entry_price: 7415.5 },
  )
  check('target rebuilt from entry + distance', g?.levels.tp1_price === 7403)
  check('it says so', !!g?.notes.some(n => n.includes('reconstructed')))
}

console.log('\nLABELS THAT DO NOT MATCH THE REAL FILL ARE NOT TRUSTED')
{
  // Stop reads 7788.75 with a 2pt label, but the actual fill was 7770 — those
  // cannot both be right, and there is no way to tell which half is wrong.
  const g = guardFrameLevels(
    { stop_price: 7788.75, tp1_price: null, stop_points: 2, tp1_points: null, confidence: 'high', reasoning: '' },
    { direction: 'short', entry_price: 7770 },
  )
  check('demoted to low', g?.levels.confidence === 'low', g?.levels.confidence)
  check('reason recorded', !!g?.notes.some(n => n.includes('reconcile')))
  check('a demoted read never auto-applies', Object.keys(autoApplicableFields(g!.levels, {})).length === 0)
}
{
  // ...and a conflicted read must not rebuild the missing leg off the bad label.
  const g = guardFrameLevels(
    { stop_price: 7788.75, tp1_price: null, stop_points: 2, tp1_points: 7.5, confidence: 'high', reasoning: '' },
    { direction: 'short', entry_price: 7770 },
  )
  check('missing leg left null rather than built on a bad read', g?.levels.tp1_price === null)
}

console.log('\nWRONG-SIDED LEVELS')
{
  // Both levels reversed = the right two numbers the wrong way round.
  const g = guardFrameLevels(
    { stop_price: 7779.25, tp1_price: 7788.75, stop_points: null, tp1_points: null, confidence: 'medium', reasoning: '' },
    { direction: 'short', entry_price: 7786.75 },
  )
  check('swapped back', g?.levels.stop_price === 7788.75 && g?.levels.tp1_price === 7779.25)
}
{
  // A single wrong-sided level is ambiguous — drop it rather than guess.
  const g = guardFrameLevels(
    { stop_price: 7780, tp1_price: null, stop_points: null, tp1_points: null, confidence: 'high', reasoning: '' },
    { direction: 'short', entry_price: 7786.75 },
  )
  check('a short with its stop BELOW entry is dropped', g?.levels.stop_price === null)
  check('and the read is demoted', g?.levels.confidence === 'low')
}

console.log('\nA LEVEL THAT EQUALS ENTRY IS THE PRICE MARKER, NOT A LEVEL')
{
  const g = guardFrameLevels(
    { stop_price: 7786.75, tp1_price: null, stop_points: null, tp1_points: null, confidence: 'medium', reasoning: '' },
    { direction: 'short', entry_price: 7786.75 },
  )
  check('dropped', g?.levels.stop_price === null)
}

console.log('\nNOTHING TO CHECK AGAINST')
{
  const g = guardFrameLevels(
    { stop_price: 7788.75, tp1_price: 7779.25, stop_points: null, tp1_points: null, confidence: 'high', reasoning: '' },
    { direction: null, entry_price: null },
  )
  check('read kept', g?.levels.stop_price === 7788.75)
  check('but never claims high confidence', g?.levels.confidence === 'medium')
  check('so it cannot auto-apply', Object.keys(autoApplicableFields(g!.levels, {})).length === 0)
}

console.log('\nWHAT MAY WRITE ITSELF INTO A COLUMN')
{
  const high = { entry_price: 100, stop_price: 98, tp1_price: 104, tp2_price: null, confidence: 'high' as const, reasoning: '' }
  check('high + empty columns → both fill',
    JSON.stringify(autoApplicableFields(high, {})) === JSON.stringify({ stop_price: 98, tp1_price: 104 }))
  check('a stop the trader already entered is never overwritten',
    autoApplicableFields(high, { stop_price: 97 }).stop_price === undefined)
  check('medium waits for a click',
    Object.keys(autoApplicableFields({ ...high, confidence: 'medium' }, {})).length === 0)
  check('low waits too',
    Object.keys(autoApplicableFields({ ...high, confidence: 'low' }, {})).length === 0)
}

console.log('\nJUNK IN')
{
  check('null answer', guardFrameLevels(null, { direction: 'long', entry_price: 100 }) === null)
  const g = guardFrameLevels({}, { direction: 'long', entry_price: 100 })
  check('empty answer yields an all-null read', g?.levels.stop_price === null && g?.levels.tp1_price === null)
  check('with no confidence claimed', g?.levels.confidence === 'low')
}

console.log(failures === 0 ? '\nAll frame-level guards pass.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
