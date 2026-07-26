/**
 * Unit tests for the session-clock deep dive (src/lib/deep-dive/time-of-day.ts).
 *   npx tsx scripts/test-time-of-day.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import { analyzeTimeOfDay, type TimeOfDayTrade } from '../src/lib/deep-dive/time-of-day.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// June 2026 ⇒ PDT (UTC−7), so 13:00Z = 6am PT. P&L alternates around the mean so
// the Welch check has real variance to work with (a constant series has none).
const slot = (utcHour: number, n: number, mean: number, spread = 20, utcMinute = 0): TimeOfDayTrade[] =>
  Array.from({ length: n }, (_, i) => ({
    entryTime: `2026-06-${String((i % 20) + 1).padStart(2, '0')}T${String(utcHour).padStart(2, '0')}:${String(utcMinute).padStart(2, '0')}:00Z`,
    pnl: mean + (i % 2 === 0 ? -spread : spread),
  }))

console.log('time-of-day')

// Bleeds in the 6am hour, prints from 8am on.
const warmup = analyzeTimeOfDay([...slot(13, 30, -100), ...slot(15, 60, 100)])
check('finds the front-of-day bleed', warmup !== null)
check('proposes cutting the early entries', !!warmup?.test && warmup.test.rule === 'Take no entries before 8am PDT')
check('impact = the skipped trades\' realized loss ($3,000)', warmup?.test?.impactUsd === 3000)
check('headline states the cost of the cut region', !!warmup && /net −\$3,000/.test(warmup.headline))
check('reframes it as warming up', !!warmup?.reframe && /WARMING UP/.test(warmup.reframe))
check('quotes the z it cleared', !!warmup?.detail.some(d => /z = \d+\.\d+ — past the 1\.64 bar/.test(d)))
check('one segment per active slot', warmup?.segments.length === 2)
check('segment value is $/trade', warmup?.segments[0]?.value === -100 && warmup?.segments[1]?.value === 100)
check('segments carry the win rate', warmup?.segments[0]?.extra?.winRate === 0 && warmup?.segments[1]?.extra?.winRate === 100)
check('labels are in the trader\'s zone', warmup?.segments[0]?.label === '6am PDT')

// Mirror image: good early, gives it back late.
const shelfLife = analyzeTimeOfDay([...slot(13, 60, 100), ...slot(15, 30, -100)])
check('finds the end-of-day give-back', !!shelfLife?.test && shelfLife.test.rule === 'Take no entries from 8am PDT onward')
check('same $3,000 recovered from the back end', shelfLife?.test?.impactUsd === 3000)
check('reframes it as an expiring edge', !!shelfLife?.reframe && /shelf life/.test(shelfLife.reframe))

// OVERFIT GUARD: the loser sits in the MIDDLE, so no edge trim is offered even
// though carving out the 8am hour would "recover" $3,000.
const middleLoser = analyzeTimeOfDay([...slot(13, 30, 100), ...slot(15, 20, -150), ...slot(17, 30, 100)])
check('never carves a losing slot out of the middle', middleLoser?.test === undefined)
check('still shows the full decomposition', middleLoser?.segments.length === 3)
check('and still names the worst slot', !!middleLoser?.detail.some(d => /Worst slot 8am PDT/.test(d)))
check('says shortening the session is not the lever', !!middleLoser?.detail.some(d => /shortening your session isn't the lever/.test(d)))
check('stays out of the opener', middleLoser?.severity === 0.05)

// SIGNIFICANCE GATE: the early slot is net negative but so wild that the
// difference is noise (z ≈ 0.1) — no test.
const noisyEarly = analyzeTimeOfDay([
  ...Array.from({ length: 30 }, (_, i) => ({ entryTime: `2026-06-${String((i % 20) + 1).padStart(2, '0')}T13:00:00Z`, pnl: i % 2 === 0 ? -5000 : 4980 })),
  ...slot(15, 60, 100),
])
check('a net-negative slot alone is not enough — z must clear the bar', noisyEarly?.test === undefined)

// Half-hour buckets once the sample supports them (≥150 trades).
const fine = analyzeTimeOfDay([...slot(13, 100, 100, 20, 15), ...slot(13, 100, 100, 20, 45)])
check('switches to 30-minute slots at scale', fine?.segments.length === 2)
check('labels the half-hour slot', fine?.segments[1]?.label === '6:30am PDT')
check('reports the slot size', !!fine?.detail.some(d => /2 30-minute slots/.test(d)))

// Bucket size can be forced.
const forced = analyzeTimeOfDay([...slot(13, 30, -100), ...slot(15, 60, 100)], { bucketMinutes: 30 })
check('honours an explicit bucket size', !!forced?.detail.some(d => /30-minute slots/.test(d)))

// Timezone drives the labels: the same trades read 9am on the east coast.
const ny = analyzeTimeOfDay([...slot(13, 30, -100), ...slot(15, 60, 100)], { timeZone: 'America/New_York' })
check('respects the trader\'s timezone', ny?.segments[0]?.label === '9am EDT')
check('and the rule follows it', ny?.test?.rule === 'Take no entries before 11am EDT')

// Floors.
check('null under the sample floor', analyzeTimeOfDay(slot(13, 20, -100)) === null)
check('null with a single active slot', analyzeTimeOfDay(slot(13, 60, -100)) === null)
check('ignores unscored trades', analyzeTimeOfDay([...slot(13, 30, -100), ...slot(15, 60, 100),
  ...Array.from({ length: 50 }, () => ({ entryTime: '2026-06-01T15:00:00Z', pnl: null }))])?.test?.impactUsd === 3000)

console.log(failures === 0 ? '\nAll time-of-day tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
