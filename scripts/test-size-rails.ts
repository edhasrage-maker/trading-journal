/**
 * Unit tests for INSTRUMENT-AWARE size rails (src/lib/scoring-profile.ts
 * sizeCapFor / resolveRails, + the deterministic P2/P3 in eod-prompt.ts).
 *   npx tsx scripts/test-size-rails.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import {
  OWNER_RAILS, UNTRACKED_RAILS, sizeCapFor, resolveRails, activeRailIds,
  isEmptyScoringProfile, type ScoringProfile,
} from '../src/lib/scoring-profile.ts'
import { computeDeterministicRules, applyDeterministicOverrides } from '../src/lib/eod-prompt.ts'
import { applySizeUp, COOLDOWN_NEVER_BREACH } from '../src/lib/tapescore-day-rules.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('sizeCapFor')

check('owner MNQ base cap is 5', sizeCapFor(OWNER_RAILS, 'MNQU6.CME') === 5)
check('owner MES base cap is 10', sizeCapFor(OWNER_RAILS, 'MESU6.CME') === 10)
check('owner MNQ A+ cap is 10', sizeCapFor(OWNER_RAILS, 'MNQU6.CME', 'sizeUp') === 10)
check('owner MES A+ cap is 20', sizeCapFor(OWNER_RAILS, 'MESU6.CME', 'sizeUp') === 20)
check('an unlisted root falls back to the default cap', sizeCapFor(OWNER_RAILS, 'GCZ6.COMEX') === 5)
check('a null symbol falls back to the default cap', sizeCapFor(OWNER_RAILS, null) === 5)
check('untracked rails cap nothing', sizeCapFor(UNTRACKED_RAILS, 'MNQU6.CME') === null)
// A root with a base cap but no size-up entry must NOT inherit another
// instrument's size-up, and must not fall through to the global default.
const partial = { ...OWNER_RAILS, maxSizeByRoot: { MNQ: 5, MYM: 3 }, sizeUpByRoot: { MNQ: 10 } }
check('size-up falls back to that root\'s OWN base cap', sizeCapFor(partial, 'MYMZ6.CBOT', 'sizeUp') === 3)

console.log('resolveRails from a user profile')

const sp: ScoringProfile = { rails: { max_size: 3, max_size_by_root: { mnq: 5, MES: 10 }, size_up_by_root: { MNQ: 10, MES: 20 } } }
const rc = resolveRails(sp, false)
check('per-root caps are read from the profile', sizeCapFor(rc, 'MESU6.CME') === 10)
check('roots are normalized to upper case', sizeCapFor(rc, 'MNQU6.CME') === 5)
check('the scalar still covers unlisted roots', sizeCapFor(rc, 'RTYZ6.CME') === 3)
check('P2 becomes deterministic for a per-root profile', rc.p2Deterministic === true)
check('P2/P3 are graded when only per-root caps are set',
  activeRailIds(resolveRails({ rails: { max_size_by_root: { MNQ: 5 } } }, false)).includes('P2'))
check('a profile with only per-root caps is NOT empty',
  isEmptyScoringProfile({ rails: { max_size_by_root: { MNQ: 5 } } }) === false)
check('junk entries are dropped', resolveRails({ rails: { max_size_by_root: { MNQ: 0 } } }, false).maxSizeByRoot === null)

console.log('deterministic P3 — the live MES bug')

// T1 MNQ 5 lots, LOSS. T2 MES 10 lots right after → correctly sized for MES
// (cap 10), was a breach when the cap was instrument-blind at 5.
// T3 MES 10 lots, LOSS. T4 MNQ 10 lots right after → a real breach (cap 5).
const t = (id: string, symbol: string, quantity: number, pnl: number, h: number) => ({
  id, symbol, quantity, pnl,
  entry_time: `2026-07-28T${String(h).padStart(2, '0')}:00:00Z`,
  exit_time: `2026-07-28T${String(h).padStart(2, '0')}:30:00Z`,
})
const det = computeDeterministicRules([
  t('1', 'MNQU6.CME', 5, -100, 15),
  t('2', 'MESU6.CME', 10, 50, 16),
  t('3', 'MESU6.CME', 10, -80, 17),
  t('4', 'MNQU6.CME', 10, 40, 18),
], OWNER_RAILS)
check('a correctly-sized 10-lot MES after a loss is NOT a P3 breach',
  !det.P3.reason.includes('T2'), det.P3.reason)
check('an over-sized 10-lot MNQ after a loss IS still a P3 breach',
  det.P3.status === 'fail' && det.P3.reason.includes('T4'), det.P3.reason)
check('exactly one breach', det.P3.breach_count === 1, det.P3.reason)

// All-MES session, all within cap → clean.
const clean = computeDeterministicRules([
  t('1', 'MESU6.CME', 10, -100, 15),
  t('2', 'MESU6.CME', 10, 50, 16),
], OWNER_RAILS)
check('an all-MES session within cap passes P3', clean.P3.status === 'pass', clean.P3.reason)

console.log('deterministic P2 — per-instrument, public profile')

const pubRc = resolveRails({ rails: { max_size_by_root: { MNQ: 5, MES: 10 } } }, false)
const p2 = computeDeterministicRules([
  t('1', 'MESU6.CME', 10, 20, 15),   // at cap → fine
  t('2', 'MNQU6.CME', 6, -20, 16),   // over the MNQ cap → breach
], pubRc)
check('P2 flags only the instrument that actually exceeded its cap',
  p2.P2?.status === 'fail' && p2.P2.breach_count === 1, p2.P2?.reason)
check('P2 reason names the per-instrument caps', /5 MNQ \/ 10 MES/.test(p2.P2?.reason ?? ''), p2.P2?.reason)
check('an unlisted instrument is not capped, not breached',
  computeDeterministicRules([t('1', 'GCZ6.COMEX', 50, 10, 15)],
    resolveRails({ rails: { max_size_by_root: { MNQ: 5 } } }, false)).P2?.status === 'pass')

console.log('cooldown (P4) — light weight, a fresh trigger excuses it (founder 2026-10-20)')

// Per-user 1.5 min cooldown. T1 loses at 15:30:00; T2 opens 45 s later.
const cdRc = resolveRails({ rails: { cooldown_min: 1.5, max_size: 10, daily_loss_limit: 500, max_trades: 7 } }, false)
const second = (pnl: number, qty: number, em: string[], mistakes: string[] = []) => ({
  id: '2', symbol: 'MNQZ6.CME', quantity: qty, pnl, entry_time: '2026-07-28T15:30:45Z', exit_time: '2026-07-28T15:40:00Z',
  entry_price: 100, stop_price: 90, direction: 'long' as const, high_during_position: 101, low_during_position: 90,
  tags_json: { entry_model: em, mistakes } as never,
})
const first = { ...t('1', 'MNQZ6.CME', 5, -150, 15), entry_price: 100, stop_price: 90, direction: 'long' as const, high_during_position: 101, low_during_position: 90 }
const cd = (em: string[] = [], mistakes: string[] = []) => computeDeterministicRules([first, second(-150, 5, em, mistakes)], cdRc).P4
check('45 s after a loss with no trigger: fails', cd().status === 'fail', cd().reason)
check('"Based on Price" alone is not new information: fails', cd(['Based on Price']).status === 'fail')
check('a fresh trigger excuses it: passes', cd(['Break of Candle']).status === 'pass', cd(['Break of Candle']).reason)
check('tagged Revenge Trading, the trigger does not excuse it: fails', cd(['Break of Candle'], ['Revenge Trading']).status === 'fail')
check('the owner rubric keeps the plain 90 s gap rule (trigger or not)',
  computeDeterministicRules([first, second(10, 5, ['Break of Candle'])], OWNER_RAILS).P4.status === 'fail')

// Verdicts: P4 counts toward "rules kept" but never makes the day a Breach.
check('the cooldown rail is P4', COOLDOWN_NEVER_BREACH === 'P4')
const rule = (status: 'pass' | 'fail') => ({ status, breach_count: status === 'fail' ? 1 : 0, reason: '' })
const audit = (p4: 'pass' | 'fail', p5: 'pass' | 'fail') => ({
  verdict: 'Compliant', active_rails: ['P1', 'P2', 'P3', 'P4', 'P5'],
  per_rule: { P1: rule('pass'), P2: rule('pass'), P3: rule('pass'), P4: rule(p4), P5: rule(p5) },
}) as never
check('read time: P3 (size-up) + P4 failed = Compliant (P4 never counts toward Breach)', applySizeUp(audit('fail', 'pass'), 1)?.verdict === 'Compliant')
check('read time: P3 + P5 failed = Breach (P4 aside)', applySizeUp(audit('pass', 'fail'), 1)?.verdict === 'Breach')
const analyse = (qty: number, maxTrades: number) => applyDeterministicOverrides(
  { process: { verdict: 'Compliant', per_rule: {}, breach_count_vector: {} } } as never,
  [first, second(-150, qty, [])] as never, undefined,
  resolveRails({ rails: { cooldown_min: 1.5, max_size: 10, daily_loss_limit: 500, max_trades: maxTrades } }, false),
) as unknown as { process: { verdict: string; per_rule: Record<string, { status: string }> } }
const oneLapse = analyse(5, 1)
check('analysis: P5 (2 trades > 1) + P4 (45 s) failed = Compliant (one lapse + the cooldown)',
  oneLapse.process.per_rule.P5?.status === 'fail' && oneLapse.process.per_rule.P4?.status === 'fail' && oneLapse.process.verdict === 'Compliant',
  JSON.stringify(oneLapse.process))
const twoLapses = analyse(11, 7)
check('analysis: P2 + P3 (11 lots after a loss) failed = Breach, cooldown or not',
  twoLapses.process.per_rule.P2?.status === 'fail' && twoLapses.process.per_rule.P3?.status === 'fail' && twoLapses.process.verdict === 'Breach')

console.log(failures === 0 ? '\nAll size-rail tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
