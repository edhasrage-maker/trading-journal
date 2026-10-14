/**
 * Unit tests for the profit-factor lifter / drag (src/lib/lift-drag.ts).
 *   npx tsx scripts/test-lift-drag.ts
 */
import { liftDrag, liftDragByScope, windowFor, formatPfDelta, MIN_SESSIONS, type LiftDragTrade } from '../src/lib/lift-drag.ts'
import { symbolToMultiplier } from '../src/lib/futures-symbols.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// 10-pt planned risk on 1 MNQ ⇒ a pnl of r × 10 × multiplier reads exactly r R.
const DOLLARS_PER_R = 10 * symbolToMultiplier('MNQ')
let rng = 7
const rand = () => { rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff; return rng / 0x80000000 }

interface Spec {
  r: number
  setup: string
  direction?: 'long' | 'short'
  /** Planned reward:risk; sets tp1. */
  rr?: number
  confluences?: string[]
  mistakes?: string[]
  management?: string[]
}
let seq = 0
function day(date: string, specs: Spec[]): LiftDragTrade[] {
  // Shuffle the order and spread the clock so no setup is always trade #1
  // or always in the same hour (that would tie it with a sequence/time factor).
  const order = specs.map(s => ({ s, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.s)
  return order.map((s, i) => {
    const dir = s.direction ?? (rand() < 0.5 ? 'long' : 'short')
    const minute = 390 + Math.floor(rand() * 360) + i // 06:30–12:30 PT
    const entry = new Date(`${date}T00:00:00-07:00`)
    entry.setMinutes(minute)
    const exit = new Date(entry.getTime() + 3 * 60_000)
    return {
      id: `t${++seq}`,
      trading_day_id: `d-${date}`,
      date,
      pnl: s.r * DOLLARS_PER_R,
      entry_price: 20000,
      stop_price: dir === 'long' ? 19990 : 20010,
      tp1_price: s.rr == null ? null : dir === 'long' ? 20000 + s.rr * 10 : 20000 - s.rr * 10,
      quantity: 1,
      direction: dir,
      symbol: 'MNQZ6.CME',
      entry_time: entry.toISOString(),
      exit_time: exit.toISOString(),
      entry_atr_1m: 12,
      tags_json: {
        setups: [s.setup],
        confluences: s.confluences ?? [],
        mistakes: s.mistakes ?? [],
        trade_management: s.management ?? [],
      },
    }
  })
}
const dateN = (i: number) => {
  const d = new Date(Date.UTC(2026, 0, 5))
  d.setUTCDate(d.getUTCDate() + Math.floor(i / 5) * 7 + (i % 5)) // weekdays only
  return d.toISOString().slice(0, 10)
}

// ── A book with one clear lifter and one clear drag ──────────────────────────
// Alpha wins big two days in three; Beta loses three days in four; Gamma is a
// coin flip. Hindsight tags and after-the-fact tags sit on the outcomes they
// describe — they must never be named.
function makeBook(days: number): LiftDragTrade[] {
  const out: LiftDragTrade[] = []
  for (let i = 0; i < days; i++) {
    const alphaWin = i % 3 !== 0
    const betaWin = i % 4 === 0
    out.push(...day(dateN(i), [
      { r: alphaWin ? 2 : -1, setup: 'Alpha', rr: 2.5, confluences: alphaWin ? ["TP2 Would've Hit"] : [], management: alphaWin ? ['TP2 Reached Full Target'] : [] },
      { r: betaWin ? 1 : -1, setup: 'Beta', rr: 2.5, mistakes: betaWin ? [] : ['Revenge Trading'] },
      { r: i % 2 ? 1 : -1, setup: 'Gamma', rr: 2.5 },
      { r: i % 2 ? -1 : 1, setup: 'Gamma', rr: 2.5 },
    ]))
  }
  return out
}

console.log('liftDrag — picks')
{
  const book = makeBook(60)
  const res = liftDrag(book)
  check('returns a read for a 60-session book', res != null)
  check('lifter is the Alpha setup', res?.lift?.label === 'Alpha trades', res?.lift?.label)
  check('drag is the Beta setup', res?.drag?.label === 'Beta trades', res?.drag?.label)
  check('lift delta is positive and its range clears zero', (res?.lift?.delta ?? 0) > 0 && (res?.lift?.lo ?? 0) > 0)
  check('drag delta is negative and its range clears zero', (res?.drag?.delta ?? 0) < 0 && (res?.drag?.hi ?? 0) < 0)
  const pf = res!.pf
  check('delta = PF − PF without the group', Math.abs(res!.lift!.delta - (pf - res!.lift!.pfWithout)) < 1e-9)
  check('group + rest = every trade', res!.lift!.n + res!.lift!.restN === book.length)
  check('n counts the group (60 Alpha trades)', res!.lift!.n === 60)
  check('no named factor covers more than half the trades',
    [res!.lift!, res!.drag!].every(f => f.n <= book.length / 2))

  const again = liftDrag(makeBookFresh(60))
  check('deterministic: same data, same ranges', JSON.stringify(again) === JSON.stringify(res))
}

function makeBookFresh(days: number) { rng = 7; seq = 0; return makeBook(days) }

console.log('liftDrag — what never competes')
{
  rng = 7; seq = 0
  const res = liftDrag(makeBook(60))!
  const named = [res.lift?.label, res.drag?.label].join(' | ')
  check('hindsight confluence never named', !/Would've/i.test(named), named)
  check('trade-management tags never named', !/TP2 Reached/i.test(named), named)
  check('mistake tags never named', !/Revenge/i.test(named), named)
}

console.log('liftDrag — the drag comes from a different dimension')
{
  // Far targets win, close targets lose: "Targets of 3R or more" lifts. Its own
  // complement ("Targets closer than 3R") is the same split and must not come
  // back as the drag.
  seq = 0; rng = 11
  const book: LiftDragTrade[] = []
  for (let i = 0; i < 60; i++) {
    book.push(...day(dateN(i), [
      { r: i % 3 ? 3 : -1, setup: 'S1', rr: 3.5 },
      { r: i % 4 ? -1 : 1, setup: 'S2', rr: 1.5 },
      { r: i % 2 ? 1 : -1, setup: 'S3', rr: 3.5 },
      { r: i % 2 ? -1 : 1, setup: 'S4', rr: 1.5 },
    ]))
  }
  const res = liftDrag(book)!
  const lift = res.lift?.label ?? ''
  const drag = res.drag?.label ?? ''
  check('something lifts', lift !== '', JSON.stringify(res.lift))
  check('lift and drag are not the two sides of one split',
    !(/Targets/.test(lift) && /Targets/.test(drag)), `${lift} | ${drag}`)
}

console.log('liftDrag — thin windows say nothing')
{
  seq = 0; rng = 3
  check('ten trades → null', liftDrag(makeBook(60).slice(0, 10)) == null)
  check('no trades → null', liftDrag([]) == null)
  // All winners: no profit factor to speak of.
  const allWin = makeBook(30).map(t => ({ ...t, pnl: Math.abs(t.pnl ?? 0) || DOLLARS_PER_R }))
  check('no losses → null', liftDrag(allWin) == null)
}

console.log('windowFor — the 60-session floor')
{
  const dates = Array.from({ length: 100 }, (_, i) => dateN(i))
  const end = dates[99]
  const short = windowFor(dates, dates[85], end)!
  check('a 15-session period widens to 60', short.extended && dates.filter(d => d >= short.start && d <= short.end).length === MIN_SESSIONS)
  check('…ending where the period ends', short.end === end)
  const long = windowFor(dates, dates[20], end)!
  check('an 80-session period is kept as is', !long.extended && long.start === dates[20])
  const fewer = windowFor(dates.slice(0, 30), '2000-01-01', end)!
  check('a book under 60 sessions uses all of it', fewer.start === dates[0] && fewer.end === dates[29])
  check('a period before any trade → null', windowFor(dates, '1990-01-01', '1990-12-31') == null)
  const lastYear = windowFor(dates, '2026-01-01', dates[10])!
  check('a past period widens backwards from its own end', lastYear.end === dates[10])
}

console.log('liftDragByScope')
{
  seq = 0; rng = 5
  const book = makeBook(100)
  const today = book[book.length - 1].date
  const scopes = liftDragByScope(book, today)
  check('every Period option and Filter range has a key',
    ['p:all', 'p:week', 'p:month', 'p:30d', 'p:ytd', 'p:last_year', 'r:1m', 'r:3m', 'r:6m', 'r:ytd', 'r:1y', 'r:all'].every(k => k in scopes))
  check('short periods widen to the same 60 sessions',
    scopes['p:week']?.sessions === MIN_SESSIONS && scopes['p:week']?.extended === true
      && JSON.stringify(scopes['p:week']) === JSON.stringify(scopes['p:30d']))
  check('all time reads the whole book', scopes['p:all']?.sessions === 100 && scopes['p:all']?.extended === false)
}

console.log('formatPfDelta')
check('positive', formatPfDelta(0.537) === '+0.54')
check('negative uses a real minus', formatPfDelta(-0.41) === '−0.41')

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll lift/drag checks passed.')
