/**
 * Unit tests for the Review→Prep carryover engine (src/lib/prep-carryover.ts),
 * focused on the mistake/emotion CONCENTRATION rework: a costly tag only
 * surfaces when it clusters in a gateable condition (after-loss cooldown,
 * first-two-trades, clock hour) — the tautological `Trades tagged "X" went
 * worse` shape is gone.
 *   npx tsx scripts/test-prep-carryover.ts
 */
import { computeCarryover } from '../src/lib/prep-carryover.ts'
import type { TradeWithExcursion } from '../src/lib/analytics.ts'
import { symbolToMultiplier } from '../src/lib/futures-symbols.ts'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { TradeTags } from '../src/lib/supabase/types.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 10-pt planned risk on MNQ ⇒ pnl of r × 10 × multiplier reads exactly r R.
const DOLLARS_PER_R = 10 * symbolToMultiplier('MNQ')
let seq = 0
interface Spec { r: number; entry: string; exit: string; mistakes?: string[]; setups?: string[] }
const trade = (dayId: string, s: Spec): TradeWithExcursion & { exit_time: string } => ({
  id: `t${++seq}`,
  pnl: s.r * DOLLARS_PER_R,
  entry_price: 20000,
  stop_price: 19990,
  quantity: 1,
  direction: 'long',
  symbol: 'MNQ',
  trading_day_id: dayId,
  entry_time: s.entry,
  exit_time: s.exit,
  tags_json: { mistakes: s.mistakes ?? [], setups: s.setups ?? [] },
  high_during_position: null,
  low_during_position: null,
} as unknown as TradeWithExcursion & { exit_time: string })

console.log('prep-carryover')

// ── 1. After-loss concentration: every FOMO entry within minutes of a losing
//       exit. 4 days × 5 trades; per day: win, win, loss, FOMO loss (3 min
//       after), FOMO loss (2 min after). afterLoss share 8/8 vs base 8/20;
//       the 15Z hour also concentrates but with lower lift, so the cooldown
//       dimension must win.
const afterLossBook: TradeWithExcursion[] = []
for (let d = 1; d <= 4; d++) {
  const day = `day-${d}`
  const D = `2026-06-0${d}`
  afterLossBook.push(
    trade(day, { r: +1, entry: `${D}T14:00:00Z`, exit: `${D}T14:05:00Z` }),
    trade(day, { r: +1, entry: `${D}T14:30:00Z`, exit: `${D}T14:35:00Z` }),
    trade(day, { r: -1, entry: `${D}T15:00:00Z`, exit: `${D}T15:05:00Z` }),
    trade(day, { r: -1, entry: `${D}T15:08:00Z`, exit: `${D}T15:12:00Z`, mistakes: ['FOMO'] }),
    trade(day, { r: -1, entry: `${D}T15:14:00Z`, exit: `${D}T15:20:00Z`, mistakes: ['FOMO'] }),
  )
}
const afterLoss = computeCarryover(afterLossBook, 'test window')
check('costly clustered tag still produces a carryover', afterLoss !== null)
check('finding names the trigger, not the tautology', afterLoss?.finding === '"FOMO" follows a loss', afterLoss?.finding)
check('the old "went worse" shape is gone', !(afterLoss?.finding ?? '').includes('went worse'))
check('metric counts the concentration', !!afterLoss && /8 of 8 tagged entries came within 15 min of a losing exit/.test(afterLoss.metric), afterLoss?.metric)
check('metric shows the base rate (anti-tautology proof)', !!afterLoss && /40% of all trades do/.test(afterLoss.metric), afterLoss?.metric)
check('metric keeps the R comparison', !!afterLoss && /tagged −1\.0R, the rest/.test(afterLoss.metric), afterLoss?.metric)
check('do-next prescribes the cooldown mechanism', !!afterLoss && /15-minute cooldown after any losing exit/.test(afterLoss.today), afterLoss?.today)
check('evidence rail keeps the two-sided R bars', afterLoss?.evidence.length === 2)

// ── 2. Costly but UNCLUSTERED tag says nothing at all. Same cost profile, but
//       the FOMO trades are scattered: mid-day slots, after winners, across
//       hours. No setups, no excursion data ⇒ no other candidate families ⇒
//       the whole carryover must be null (honest "no read yet"), never the
//       tautology.
const scatteredBook: TradeWithExcursion[] = []
for (let d = 1; d <= 4; d++) {
  const day = `sday-${d}`
  const D = `2026-06-1${d}`
  // FOMO in slots 3 and 5, both after WINNING exits and >15 min later, in
  // different hours each day so no hour clears the lift bar.
  const h = 13 + d
  const hh = (x: number) => String(x).padStart(2, '0')
  scatteredBook.push(
    trade(day, { r: +1, entry: `${D}T${hh(h)}:00:00Z`, exit: `${D}T${hh(h)}:05:00Z` }),
    trade(day, { r: +1, entry: `${D}T${hh(h)}:40:00Z`, exit: `${D}T${hh(h)}:45:00Z` }),
    trade(day, { r: -1, entry: `${D}T${hh(h + 1)}:10:00Z`, exit: `${D}T${hh(h + 1)}:15:00Z`, mistakes: ['FOMO'] }),
    trade(day, { r: +1, entry: `${D}T${hh(h + 2)}:00:00Z`, exit: `${D}T${hh(h + 2)}:05:00Z` }),
    trade(day, { r: -1, entry: `${D}T${hh(h + 3)}:00:00Z`, exit: `${D}T${hh(h + 3)}:05:00Z`, mistakes: ['FOMO'] }),
  )
}
check('unclustered costly tag produces NO finding (null, not tautology)', computeCarryover(scatteredBook, 'test window') === null)

// ── 3. First-two-trades concentration, when after-loss cannot pass. 4 days ×
//       6 trades; FOMO = trades #1 and #2 (only #2 is after a loss ⇒ afterLoss
//       share 0.5 < 0.6), rest winners.
const openerBook: TradeWithExcursion[] = []
for (let d = 1; d <= 4; d++) {
  const day = `oday-${d}`
  const D = `2026-06-2${d}`
  openerBook.push(
    trade(day, { r: -1, entry: `${D}T14:00:00Z`, exit: `${D}T14:05:00Z`, mistakes: ['FOMO'] }),
    trade(day, { r: -1, entry: `${D}T14:10:00Z`, exit: `${D}T14:15:00Z`, mistakes: ['FOMO'] }),
    trade(day, { r: +1, entry: `${D}T15:00:00Z`, exit: `${D}T15:05:00Z` }),
    trade(day, { r: +1, entry: `${D}T15:30:00Z`, exit: `${D}T15:35:00Z` }),
    trade(day, { r: +1, entry: `${D}T16:00:00Z`, exit: `${D}T16:05:00Z` }),
    trade(day, { r: +1, entry: `${D}T16:30:00Z`, exit: `${D}T16:35:00Z` }),
  )
}
const opener = computeCarryover(openerBook, 'test window')
check('first-two concentration fires with its own copy', opener?.finding === '"FOMO" shows up in your first two trades of the day', opener?.finding)
check('do-next targets the open, not the feeling', !!opener && /plan trade #1 before the open/.test(opener.today), opener?.today)

// ── 4. Setup separation family is untouched by the rework.
const setupBook: TradeWithExcursion[] = []
for (let d = 1; d <= 3; d++) {
  const day = `pday-${d}`
  const D = `2026-06-0${d}`
  for (let i = 0; i < 4; i++) {
    setupBook.push(trade(day, { r: +1, entry: `${D}T1${i}:00:00Z`, exit: `${D}T1${i}:05:00Z`, setups: ['ORB'] }))
    setupBook.push(trade(day, { r: -0.5, entry: `${D}T1${i}:30:00Z`, exit: `${D}T1${i}:35:00Z`, setups: ['Fade'] }))
  }
}
const setup = computeCarryover(setupBook, 'test window')
check('setup findings still surface', !!setup && /ORB was your best setup|Fade cost you/.test(setup.finding), setup?.finding)

if (failures > 0) { console.error(`\n${failures} prep-carryover test(s) failed.`); process.exit(1) }
console.log('\nAll prep-carryover tests passed.')
