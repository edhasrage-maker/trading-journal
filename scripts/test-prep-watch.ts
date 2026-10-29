/**
 * Unit tests for Highlights Prep's Watch / Keep pick (src/lib/prep-watch.ts).
 *   npx tsx scripts/test-prep-watch.ts
 */
import { watchAndKeep } from '../src/lib/prep-watch.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const EARLY = '2026-10-28T13:05:00.000Z'
const LATE = '2026-10-28T13:40:00.000Z'

console.log('nothing run yet')
{
  const r = watchAndKeep(null)
  check('no watch, no keep', r.watch === null && r.keep === null)
  const e = watchAndKeep({})
  check('empty analysis → nothing', e.watch === null && e.keep === null)
}

console.log('only one source')
{
  const quick = watchAndKeep({ watch: 'FOMC at 11:00.', watch_at: EARLY })
  check('quick line alone shows', quick.watch === 'FOMC at 11:00.')
  check('quick line has no keep', quick.keep === null)
  const full = watchAndKeep({ flags: ['Overnight range is spent.'], strengths: ['Clear stops.'], analyzed_at: EARLY })
  check('full read alone shows its first flag', full.watch === 'Overnight range is spent.')
  check('keep is the first strength', full.keep === 'Clear stops.')
}

console.log('both sources — newest wins')
{
  const quickLater = watchAndKeep({ watch: 'quick', watch_at: LATE, flags: ['full'], analyzed_at: EARLY })
  check('quick ran later → quick', quickLater.watch === 'quick')
  const fullLater = watchAndKeep({ watch: 'quick', watch_at: EARLY, flags: ['full'], analyzed_at: LATE })
  check('full ran later → full', fullLater.watch === 'full')
  const noStamp = watchAndKeep({ watch: 'quick', watch_at: EARLY, flags: ['full'] })
  check('full read without a stamp → quick', noStamp.watch === 'quick')
  const keepStays = watchAndKeep({ watch: 'quick', watch_at: LATE, flags: ['full'], strengths: ['kept'], analyzed_at: EARLY })
  check('keep still comes from the full read', keepStays.keep === 'kept')
}

console.log('blank values')
{
  const blankFlags = watchAndKeep({ watch: '', flags: ['', 'second'], analyzed_at: EARLY })
  check('empty quick line is ignored; first non-empty flag', blankFlags.watch === 'second')
}

if (failures) { console.error(`\n${failures} failed`); process.exit(1) }
console.log('\nall passed')
