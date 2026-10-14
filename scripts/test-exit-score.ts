/**
 * Tests for the Exit score wiring — the definition (src/lib/exit-score.ts), the
 * per-day storage + average-risk rule (src/lib/exit-rollup.ts), the rollup
 * (src/lib/day-stats.ts) and the TapeScore blend (src/lib/tapescore.ts).
 * Pure: no network, no database.
 *
 *   npx tsx scripts/test-exit-score.ts   (also wired into `npm test`)
 *
 * Fixtures are hand-built MNQ longs ($2 a point): entry 100, stop 90 (10 pts,
 * $20 of risk at one lot), ATR 10, target 120 unless a case says otherwise.
 */
import {
  exitTradeScores, exitScoreView, emptyExitSums, addExitScores, mergeExitSums, lossSizeInputs, lossSizeScore,
  runnerAttempted, EXIT_FACTORS, EXIT_WEIGHTS,
  type ExitTradeInput, type ExitSums,
} from '../src/lib/exit-score'
import {
  avgRiskBefore, exitInSequence, dayExitStored, dayExitSums, exitFactorLines,
  AVG_RISK_WINDOW_TRADES, AVG_RISK_MIN_TRADES, type RiskDay,
} from '../src/lib/exit-rollup'
import {
  computeTapeScore, tapeScoreBase, tapeScoreWithExit, aggregateTapeScore, type TapeScoreResult,
} from '../src/lib/tapescore'
import {
  computeDayStats, scoreDayRollups, toStoredStats, fromStoredStats, isFreshStats, STATS_VERSION,
  type TradeForStats, type DayForStats,
} from '../src/lib/day-stats'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const near = (name: string, actual: number | null | undefined, expected: number, tol = 0.005) =>
  check(name, actual != null && Math.abs(actual - expected) <= tol, `got ${actual}, expected ${expected}`)
const absent = (name: string, actual: unknown) => check(name, actual === undefined, `got ${actual}`)

let seq = 0
/** A one-lot MNQ long. `exit` sets the fill; `pnl` follows from it unless given. */
function long(o: Partial<ExitTradeInput> & { exit: number } & Partial<TradeForStats>): TradeForStats {
  const qty = o.quantity ?? 1
  const legs = o.exits_json ?? [{ qty, price: o.exit }]
  const pnl = o.pnl ?? legs.reduce((a: number, l: { qty: number; price: number }) => a + (l.price - 100) * l.qty * 2, 0)
  const base: TradeForStats = {
    id: `t${++seq}`, tags_json: o.tags_json ?? {}, pnl,
    direction: 'long', entry_price: 100, exit_price: o.exit, stop_price: 90, tp1_price: 120,
    high_during_position: Math.max(100, o.exit), low_during_position: Math.min(100, o.exit),
    quantity: qty, symbol: 'MNQZ6.CME', entry_atr_1m: 10, exits_json: legs, mfe_dollars_per_leg: null,
    structure_5m_alignment: null,
  }
  const { exit, ...rest } = o
  void exit
  return { ...base, ...rest, pnl, exits_json: legs }
}

// ── 1 · Profit kept on winners ───────────────────────────────────────────────
console.log('1 · profit kept on winners')
{
  const atTarget = exitTradeScores(long({ exit: 120, high_during_position: 125 }))
  near('winner filled at its target = 1', atTarget.kept, 1)
  const short = exitTradeScores(long({ exit: 110, high_during_position: 120, tp1_price: 130 }))
  near('winner short of target = result ÷ best point (10 / 20)', short.kept, 0.5)
  const throughTarget = exitTradeScores(long({ exit: 121, high_during_position: 140 }))
  near('winner filled THROUGH its target still counts in full', throughTarget.kept, 1)
  absent('a loser is not judged on profit kept', exitTradeScores(long({ exit: 95, low_during_position: 95 })).kept)
}

// ── 2 · Loss size on losers ──────────────────────────────────────────────────
console.log('2 · loss size on losers')
{
  const avg = { avgRiskDollars: 20 }
  // $20 / $30 / $40 losses against a $20 average risk.
  near('loss at 1.0× average risk = 1', exitTradeScores(long({ exit: 90, low_during_position: 90 }), avg).lossSize, 1)
  near('loss at 1.1× (the edge of full marks) = 1', exitTradeScores(long({ exit: 89, low_during_position: 89 }), avg).lossSize, 1)
  near('loss at 1.5× average risk ≈ 0.56', exitTradeScores(long({ exit: 85, low_during_position: 85 }), avg).lossSize, 0.5556, 0.001)
  near('loss at 2.0× average risk = 0', exitTradeScores(long({ exit: 80, low_during_position: 80 }), avg).lossSize, 0)
  near('loss beyond 2× stays 0', exitTradeScores(long({ exit: 70, low_during_position: 70 }), avg).lossSize, 0)
  // No average yet → the trade's own planned risk ($20) is the yardstick.
  near('no average: own planned risk is the yardstick (1.5× own)', exitTradeScores(long({ exit: 85, low_during_position: 85 })).lossSize, 0.5556, 0.001)
  absent('no average and no stop → not judged', exitTradeScores(long({ exit: 85, low_during_position: 85, stop_price: null })).lossSize)
  absent('a winner is not judged on loss size', exitTradeScores(long({ exit: 110, high_during_position: 110 }), avg).lossSize)
  // The stored-pair path is the same arithmetic.
  const t = long({ exit: 86, low_during_position: 86 })
  const pair = lossSizeInputs(t)!
  check('loss inputs = [$ lost, own planned $ risk]', pair[0] === 28 && pair[1] === 20, JSON.stringify(pair))
  near('stored pair scored later = scored directly', lossSizeScore(pair[0], pair[1], 20), exitTradeScores(t, avg).lossSize ?? -1, 1e-12)
  check('a winner has no loss inputs', lossSizeInputs(long({ exit: 110 })) === null)
}

// ── 3 · Stop respected ───────────────────────────────────────────────────────
console.log('3 · stop respected')
{
  near('stop in play and respected (stopped at it) = 1', exitTradeScores(long({ exit: 90, low_during_position: 90 })).stopRespected, 1)
  near('one point past the stop is slippage (10% of risk) = 1', exitTradeScores(long({ exit: 89, low_during_position: 89 })).stopRespected, 1)
  near('blown through by 5 pts = 0', exitTradeScores(long({ exit: 85, low_during_position: 85 })).stopRespected, 0)
  near('went 9.5 pts toward a 10-pt stop and came back = in play, respected', exitTradeScores(long({ exit: 105, low_during_position: 90.5, high_during_position: 105 })).stopRespected, 1)
  absent('stop never in play (worst point 5 of 10 pts) → not judged', exitTradeScores(long({ exit: 95, low_during_position: 95 })).stopRespected)
  absent('no stop logged → not judged', exitTradeScores(long({ exit: 95, low_during_position: 85, stop_price: null })).stopRespected)
}

// ── 4 · Stop size ────────────────────────────────────────────────────────────
console.log('4 · stop size')
{
  const w = (stop: number, atrStopTarget?: number) =>
    exitTradeScores(long({ exit: 110, high_during_position: 110, stop_price: stop }), { atrStopTarget }).stopSize
  near('stop 1.0× ATR (setting 1) = pass', w(90), 1)
  near('stop 1.1× ATR = pass (tolerance)', w(89), 1)
  near('stop 1.2× ATR = too wide', w(88), 0)
  near('stop 1.2× ATR with a 2-ATR setting = pass', w(88, 2), 1)
  near('stop 2.2× ATR with a 2-ATR setting = pass (tolerance)', w(78, 2), 1)
  near('stop 2.3× ATR with a 2-ATR setting = too wide', w(77, 2), 0)
  absent('no entry ATR → not judged', exitTradeScores(long({ exit: 110, entry_atr_1m: null })).stopSize)
}

// ── 5 · Runner rules ─────────────────────────────────────────────────────────
console.log('5 · runner rules')
{
  const tag = { trade_management: ['TP2 runner'] }
  const tagged = long({ exit: 120, high_during_position: 125, tags_json: tag })
  check('runner detected by a "TP2 …" management tag', runnerAttempted(tagged))
  near('tagged, first target filled, no structure read = 1', exitTradeScores(tagged).runner, 1)
  near('… with 5-minute structure following = 1', exitTradeScores({ ...tagged, structure_5m_alignment: 'following' }).runner, 1)
  near('… with 5-minute structure fading = 0.5', exitTradeScores({ ...tagged, structure_5m_alignment: 'fading' }).runner, 0.5)
  near('tagged but first target never filled = 0', exitTradeScores(long({ exit: 110, high_during_position: 115, tags_json: tag })).runner, 0)
  const byFills = long({ exit: 130, high_during_position: 132, quantity: 2, exits_json: [{ qty: 1, price: 120 }, { qty: 1, price: 130 }] })
  check('runner detected by fills (target taken, a piece left on)', runnerAttempted(byFills))
  near('runner by fills, first target filled = 1', exitTradeScores(byFills).runner, 1)
  const single = long({ exit: 120, high_during_position: 125 })
  check('one fill at the target is not a runner', !runnerAttempted(single))
  absent('no runner attempted → not judged', exitTradeScores(single).runner)
  check('a "TP1 only" tag is not a runner', !runnerAttempted(long({ exit: 120, tags_json: { trade_management: ['TP1 only'] } })))
}

// ── Weights: absent factors share their weight ───────────────────────────────
console.log('weights')
{
  const sums = emptyExitSums()
  addExitScores(sums, { kept: 1, lossSize: 1, stopRespected: 1, stopSize: 1 })
  const v = exitScoreView(sums)
  near('no runner: profit kept carries 25/85', v.factors.kept.weight, 0.25 / 0.85, 1e-9)
  near('no runner: loss size carries 25/85', v.factors.lossSize.weight, 0.25 / 0.85, 1e-9)
  near('no runner: stop respected carries 20/85', v.factors.stopRespected.weight, 0.20 / 0.85, 1e-9)
  near('no runner: stop size carries 15/85', v.factors.stopSize.weight, 0.15 / 0.85, 1e-9)
  near('no runner: runner carries 0', v.factors.runner.weight, 0, 1e-12)
  check('rounded: 29 / 29 / 24 / 18', [v.factors.kept, v.factors.lossSize, v.factors.stopRespected, v.factors.stopSize]
    .map(f => Math.round(f.weight * 100)).join('/') === '29/29/24/18')
  const all = emptyExitSums()
  addExitScores(all, { kept: 1, lossSize: 0, stopRespected: 1, stopSize: 0, runner: 1 })
  near('all five present: plain 25/25/20/15/15 blend', exitScoreView(all).score, 25 + 20 + 15)
  near('weights sum to 1', EXIT_FACTORS.reduce((a, k) => a + EXIT_WEIGHTS[k], 0), 1, 1e-12)
  check('nothing to judge → no Exit score', exitScoreView(emptyExitSums()).score === null)
  const lines = exitFactorLines(v.factors)
  check('a factor with no trades reads "not applicable"', lines.find(l => l.key === 'runner')?.detail === 'not applicable')
  check('a judged factor reads "score · trades"', lines.find(l => l.key === 'kept')?.detail === '100 · 1 trade')
}

// ── Day storage: rollup path = direct path ───────────────────────────────────
console.log('day storage')
{
  const day = [
    long({ exit: 120, high_during_position: 125 }),
    long({ exit: 110, high_during_position: 120, tp1_price: 130 }),
    long({ exit: 85, low_during_position: 85 }),
    long({ exit: 89, low_during_position: 89, stop_price: 88 }),
    long({ exit: 130, high_during_position: 132, quantity: 2, exits_json: [{ qty: 1, price: 120 }, { qty: 1, price: 130 }] }),
  ]
  for (const avg of [null, 15, 20, 37.5]) {
    const direct = emptyExitSums()
    for (const t of day) addExitScores(direct, exitTradeScores(t, { avgRiskDollars: avg }))
    const stored = JSON.parse(JSON.stringify(dayExitStored(day, 1)))   // survives stats_json
    const viaStore = dayExitSums(stored, avg)!
    const same = EXIT_FACTORS.every(k => direct[k].n === viaStore[k].n && Math.abs(direct[k].sum - viaStore[k].sum) < 1e-12)
    check(`stored-then-scored = scored directly (avg ${avg ?? 'none'})`, same, JSON.stringify({ direct, viaStore }))
  }
  check('stored inputs record the ATR stop setting', dayExitStored(day, 2).atr_stop === 2 && dayExitStored(day).atr_stop === 1)
  check('the 2-ATR setting changes stop size', dayExitStored(day, 2).stopSize.sum > dayExitStored(day, 1).stopSize.sum)
}

// ── Average dollar risk: one rule ────────────────────────────────────────────
console.log('average dollar risk')
{
  const d = (date: string, sum: number, n: number): RiskDay => ({ date, sum_risk_dollars: sum, risk_sample: n })
  check(`constants are ${AVG_RISK_WINDOW_TRADES} / ${AVG_RISK_MIN_TRADES}`, AVG_RISK_WINDOW_TRADES === 30 && AVG_RISK_MIN_TRADES === 5)
  const few = [d('2026-01-05', 100, 3), d('2026-01-06', 200, 2)]
  check('fewer than 5 prior stop trades → no average', avgRiskBefore('2026-01-06', few) === null)
  near('exactly 5 → average of all of them', avgRiskBefore('2026-01-07', few), 60)
  check('the day itself is never its own history', avgRiskBefore('2026-01-06', [...few, d('2026-01-06', 9999, 50)]) === null)
  check('later days are ignored', avgRiskBefore('2026-01-06', [...few, d('2026-01-09', 9999, 50)]) === null)
  // Ten days of 10 trades: the newest three cover 30 exactly; older days are not read.
  const ten = Array.from({ length: 10 }, (_, i) => d(`2026-02-${String(i + 1).padStart(2, '0')}`, (i + 1) * 100, 10))
  near('stops once 30 trades are covered (newest 3 of 10 days)', avgRiskBefore('2026-02-11', ten), (800 + 900 + 1000) / 30)
  // Whole days: 25 + 10 → both days count in full (35 trades), never a part-day.
  const whole = [d('2026-03-01', 1000, 10), d('2026-03-02', 2500, 25)]
  near('whole days only (25 + a full day of 10 = 35 trades)', avgRiskBefore('2026-03-03', whole), 3500 / 35)
  check('days with no stop trades are skipped, not counted', avgRiskBefore('2026-03-03', [...whole, d('2026-03-02b', 0, 0)]) === avgRiskBefore('2026-03-03', whole))
  // The sequence helper uses the same rule for every day of a window.
  const window = ten.map(x => ({ ...x, exit: null }))
  const seq = exitInSequence(window)
  const agree = window.every((x, i) => {
    const a = seq[i].avgRiskDollars, b = avgRiskBefore(x.date, window)
    return (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9)
  })
  check('exitInSequence agrees with avgRiskBefore on every day', agree)
  // History supplies the days before a window; a date in both counts once.
  const hist = [d('2026-01-20', 3000, 30)]
  near('history before the window feeds its first day', exitInSequence([{ ...d('2026-02-01', 10, 1), exit: null }], hist)[0].avgRiskDollars, 100)
  near('a date in both window and history counts once (window wins)',
    exitInSequence([{ ...d('2026-01-20', 600, 10), exit: null }, { ...d('2026-01-21', 0, 0), exit: null }], hist)[1].avgRiskDollars, 60)
}

// ── TapeScore: Exit is passed in, never read from the analysis ──────────────
console.log('tapescore blend')
{
  const rails = (pass: number) => ({
    per_rule: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5'].map((id, i) => [id, { status: i < pass ? 'pass' : 'fail' }])),
    verdict: pass >= 4 ? 'Compliant' : 'Breach',
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execution: any = { execution_parameters: 0.7, prep_adherence: 0.7, profit_factor: 1.4, mfe_capture: 0.1, composite: 0.6 }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = computeTapeScore({ process: rails(5) as any, execution, exit: 90 })!
  check('the Exit axis is the value passed in, not mfe_capture', r.components.exit === 90, String(r.components.exit))
  check('score = (Risk + Entry + Exit) / 3', r.score === Math.round((100 + 70 + 90) / 3), String(r.score))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noExit = computeTapeScore({ process: rails(5) as any, execution, exit: null })!
  check('no Exit → axis absent, Risk + Entry re-weight', noExit.components.exit === null && noExit.score === 85, String(noExit.score))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const breach = computeTapeScore({ process: rails(3) as any, execution, exit: 100 })!
  check('Breach cap unchanged (≤49)', breach.score === 49 && breach.capped)
  check('legacy row unchanged and ignores Exit', computeTapeScore({ legacyScore: 7.4, exit: 10 })?.score === 74 && computeTapeScore({ legacyScore: 7.4, exit: 10 })?.basis === 'legacy')
  check('no analysis → no TapeScore, whatever the trades say', computeTapeScore({ exit: 95 }) === null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = tapeScoreBase({ process: rails(4) as any, execution })!
  const roundTrip = tapeScoreWithExit(JSON.parse(JSON.stringify(base)), 77)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check('base cached as JSON + Exit later = computed in one go', JSON.stringify(roundTrip) === JSON.stringify(computeTapeScore({ process: rails(4) as any, execution, exit: 77 })))
}

// ── Period: Exit pooled over trades, headline = mean of day scores ──────────
console.log('period pooling')
{
  // Day A: one winner kept in full. Day B: three winners that kept nothing.
  const a = emptyExitSums(); addExitScores(a, { kept: 1 })
  const b = emptyExitSums(); for (let i = 0; i < 3; i++) addExitScores(b, { kept: 0 })
  const day = (score: number, exit: number, sums: ExitSums) => ({
    tapescore: { score, band: 'mid', basis: 'v15', capped: false, components: { risk: 100, entry: 50, exit, passCount: 5, railCount: 5, verdict: 'Compliant' } } as TapeScoreResult,
    exit_sums: sums,
  })
  const p = aggregateTapeScore([day(83, 100, a), day(50, 0, b), { tapescore: null, exit_sums: a }])
  check('period Exit = pooled over the 4 trades (25), not the mean of days (50)', p.exit === 25, String(p.exit))
  check('period factors carry the pooled count', p.exitFactors?.kept.n === 4)
  check('headline = mean of day TapeScores (66.5 → 67)', p.score === 67, String(p.score))
  check('an unscored day adds nothing to the period Exit', p.scoredDays === 2)
  check('merge is plain addition', mergeExitSums([a, b]).kept.n === 4)
}

// ── The rollup carries the inputs; the score is finished in sequence ────────
console.log('rollup')
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eod: any = { process: { per_rule: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5'].map(id => [id, { status: 'pass' }])), verdict: 'Compliant' }, execution: { execution_parameters: 0.8, prep_adherence: 0.8, profit_factor: 2, composite: 0.8 } }
  const mkDay = (date: string, withEod: boolean): DayForStats => ({ id: date, date, eod_pnl: null, day_type: null, day_types: null, ai_analysis_json: null, eod_ai_analysis_json: withEod ? eod : null })
  // Six prior days of five $20-risk trades (30 trades), then a day with a $30 loss.
  const prior = Array.from({ length: 6 }, (_, i) => computeDayStats(mkDay(`2026-04-0${i + 1}`, false), Array.from({ length: 5 }, () => long({ exit: 110, high_during_position: 110 })), null))
  const today = computeDayStats(mkDay('2026-04-07', true), [long({ exit: 85, low_during_position: 85 })], null)
  check('rollup stores Exit inputs and the Risk+Entry base, not a finished score', 'exit' in today && 'tape' in today && !('tapescore' in today))
  const scored = scoreDayRollups([...prior, today])
  const t = scored[scored.length - 1]
  near('loss size measured against the prior 30 trades ($20 avg) → 1.5× ≈ 0.56', t.exit_sums?.lossSize.sum, 0.5556, 0.001)
  check('the finished TapeScore carries that Exit', t.tapescore?.components.exit === Math.round(exitScoreView(t.exit_sums!).score!))
  check('an unanalysed day still has Exit sums but no TapeScore', scored[0].tapescore === null && scored[0].exit_sums != null)
  const stored = toStoredStats(t)
  check('the read-time fields are never cached', !('tapescore' in stored) && !('exit_sums' in stored))
  const back = fromStoredStats(JSON.parse(JSON.stringify(stored)), { id: t.id, date: t.date, day_type: null, day_types: null })
  check('a cached row scores identically', JSON.stringify(scoreDayRollups([...prior, back]).at(-1)!.tapescore) === JSON.stringify(t.tapescore))
  check('fresh at this version + same ATR setting', isFreshStats({ stats_json: stored, stats_version: STATS_VERSION }, 1))
  check('stale when the ATR setting changed', !isFreshStats({ stats_json: stored, stats_version: STATS_VERSION }, 2))
  check('stale at the old version', !isFreshStats({ stats_json: stored, stats_version: 9 }, 1))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall exit-score checks passed')
