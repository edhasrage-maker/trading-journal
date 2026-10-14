/**
 * Tests for the five per-trade factors (src/lib/exit-score.ts — profit kept,
 * stop respected and runner rules for Exit; loss size and stop size for Risk)
 * and their per-day storage + average-risk rule (src/lib/exit-rollup.ts).
 * How the factors blend into the three axes is tested in
 * scripts/test-tapescore-axes.ts. Pure: no network, no database.
 *
 *   npx tsx scripts/test-exit-score.ts   (also wired into `npm test`)
 *
 * Fixtures are hand-built MNQ longs ($2 a point): entry 100, stop 90 (10 pts,
 * $20 of risk at one lot), ATR 10, target 120 unless a case says otherwise.
 */
import {
  exitTradeScores, lossSizeInputs, lossSizeScore, runnerAttempted, TRADE_FACTORS,
  type ExitTradeInput,
} from '../src/lib/exit-score'
import {
  riskYardstickBefore, tradeSumsInSequence, dayTradeInputs, dayTradeSums, tradeFlowTotal,
  AVG_RISK_WINDOW_TRADES, AVG_RISK_MIN_TRADES, type RiskDay,
} from '../src/lib/exit-rollup'
import { emptyTradeSums } from '../src/lib/tapescore-axes'
import type { TradeForStats } from '../src/lib/day-stats'

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
  // The trader's usual risk: mean $20, SD $5 → full marks to $25, none from $30.
  const ys = { riskYardstick: { mean: 20, sd: 5, n: 30 } }
  near('loss at the mean = 1', exitTradeScores(long({ exit: 90, low_during_position: 90 }), ys).lossSize, 1)
  near('loss at mean + 1 SD ($25, the edge of full marks) = 1', exitTradeScores(long({ exit: 87.5, low_during_position: 87.5 }), ys).lossSize, 1)
  near('loss of $28 → (30 − 28) / 5 = 0.4', exitTradeScores(long({ exit: 86, low_during_position: 86 }), ys).lossSize, 0.4)
  near('loss at mean + 2 SD ($30) = 0', exitTradeScores(long({ exit: 85, low_during_position: 85 }), ys).lossSize, 0)
  near('loss beyond + 2 SD stays 0', exitTradeScores(long({ exit: 70, low_during_position: 70 }), ys).lossSize, 0)
  // Founder's orientation numbers: mean $130, SD $76 → +1 SD ≈ $206, +2 SD ≈ $282.
  const founder = { mean: 130, sd: 76, n: 30 }
  near('founder: a $200 loss is fine', lossSizeScore(200, null, founder), 1)
  near('founder: a $300 loss scores 0', lossSizeScore(300, null, founder), 0)
  near('founder: a $250 loss ≈ 0.42', lossSizeScore(250, null, founder), 32 / 76, 1e-9)
  check('SD 0: full marks at the mean, none above it', lossSizeScore(20, null, { mean: 20, sd: 0, n: 9 }) === 1 && lossSizeScore(21, null, { mean: 20, sd: 0, n: 9 }) === 0)
  // No yardstick yet → the trade's own planned risk ($20), 1.1× / 2× as before.
  near('no yardstick: own planned risk, 1.5× own ≈ 0.56', exitTradeScores(long({ exit: 85, low_during_position: 85 })).lossSize, 0.5556, 0.001)
  near('no yardstick: 1.1× own = 1', exitTradeScores(long({ exit: 89, low_during_position: 89 })).lossSize, 1)
  near('no yardstick: 2× own = 0', exitTradeScores(long({ exit: 80, low_during_position: 80 })).lossSize, 0)
  absent('no yardstick and no stop → not judged', exitTradeScores(long({ exit: 85, low_during_position: 85, stop_price: null })).lossSize)
  near('with a yardstick, a loser without a stop is still judged', exitTradeScores(long({ exit: 85, low_during_position: 85, stop_price: null }), ys).lossSize, 0)
  absent('a winner is not judged on loss size', exitTradeScores(long({ exit: 110, high_during_position: 110 }), ys).lossSize)
  // The stored-pair path is the same arithmetic.
  const t = long({ exit: 86, low_during_position: 86 })
  const pair = lossSizeInputs(t)!
  check('loss inputs = [$ lost, own planned $ risk]', pair[0] === 28 && pair[1] === 20, JSON.stringify(pair))
  near('stored pair scored later = scored directly', lossSizeScore(pair[0], pair[1], ys.riskYardstick), exitTradeScores(t, ys).lossSize ?? -1, 1e-12)
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
  const yards = [null, { mean: 15, sd: 5, n: 30 }, { mean: 20, sd: 2, n: 30 }, { mean: 37.5, sd: 0, n: 30 }]
  for (const y of yards) {
    const avg = y?.mean ?? null
    const direct = emptyTradeSums()
    for (const t of day) {
      const s = exitTradeScores(t, { riskYardstick: y })
      for (const k of TRADE_FACTORS) { const v = s[k]; if (v != null) { direct[k].n++; direct[k].sum += v } }
    }
    const stored = JSON.parse(JSON.stringify(dayTradeInputs(day, 1)))   // survives stats_json
    const viaStore = dayTradeSums(stored, y)!
    const same = TRADE_FACTORS.every(k => direct[k].n === viaStore[k].n && Math.abs(direct[k].sum - viaStore[k].sum) < 1e-12)
    check(`stored-then-scored = scored directly (avg ${avg ?? 'none'})`, same, JSON.stringify({ direct, viaStore }))
  }
  check('stored inputs record the ATR stop setting', dayTradeInputs(day, 2).atr_stop === 2 && dayTradeInputs(day).atr_stop === 1)
  check('the 2-ATR setting changes stop size', dayTradeInputs(day, 2).stopSize.sum > dayTradeInputs(day, 1).stopSize.sum)
}

// ── Order-flow Score: read from the trade, stored as total ÷ 100 ────────────
console.log('order-flow Score inputs')
{
  check('read from review_json.score.total (any version)', tradeFlowTotal({ review_json: { score: { total: 72 } } }) === 72)
  check('read from the lean JSON-path column', tradeFlowTotal({ flow_total: 55 }) === 55)
  check('a trade without a Score reads null', tradeFlowTotal({ review_json: { verdict: undefined } as never }) === null && tradeFlowTotal({}) === null)
  const day = [
    { ...long({ exit: 110 }), flow_total: 80 },
    { ...long({ exit: 95 }), flow_total: 40 },
    long({ exit: 120 }),
  ]
  const s = dayTradeInputs(day, 1)
  check('only scored trades count (2 of 3)', s.flow.n === 2)
  near('stored as total ÷ 100, summed', s.flow.sum, 1.2, 1e-12)
}

// ── The risk yardstick: one rule ───────────────────────────────────────────
console.log('risk yardstick')
{
  /** A day of `n` stop trades all risking sum ÷ n (so its own SD is 0). */
  const d = (date: string, sum: number, n: number): RiskDay => ({ date, sum_risk_dollars: sum, sum_risk_sq: n > 0 ? (sum / n) ** 2 * n : 0, risk_sample: n })
  const mean = (y: { mean: number } | null) => y?.mean ?? null
  check(`constants are ${AVG_RISK_WINDOW_TRADES} / ${AVG_RISK_MIN_TRADES}`, AVG_RISK_WINDOW_TRADES === 30 && AVG_RISK_MIN_TRADES === 5)
  const few = [d('2026-01-05', 100, 3), d('2026-01-06', 200, 2)]
  check('fewer than 5 prior stop trades → no yardstick', riskYardstickBefore('2026-01-06', few) === null)
  near('exactly 5 → mean of all of them', mean(riskYardstickBefore('2026-01-07', few)), 60)
  // Spread: 3 trades of $33.3 and 2 of $100 → mean 60, population SD = sqrt(E[x²] − mean²).
  const ex2 = (3 * (100 / 3) ** 2 + 2 * 100 ** 2) / 5
  near('SD is the population SD of the window trades', riskYardstickBefore('2026-01-07', few)?.sd, Math.sqrt(ex2 - 60 * 60), 1e-9)
  const spread = [{ date: '2026-01-10', sum_risk_dollars: 300, sum_risk_sq: 30000, risk_sample: 3 }, { date: '2026-01-11', sum_risk_dollars: 200, sum_risk_sq: 50 ** 2 + 150 ** 2, risk_sample: 2 }]
  const y = riskYardstickBefore('2026-01-12', spread)!
  check('mean 100, SD √1000 from (100,100,100,50,150)', Math.abs(y.mean - 100) < 1e-9 && Math.abs(y.sd - Math.sqrt(1000)) < 1e-9 && y.n === 5)
  check('the day itself is never its own history', riskYardstickBefore('2026-01-06', [...few, d('2026-01-06', 9999, 50)]) === null)
  check('later days are ignored', riskYardstickBefore('2026-01-06', [...few, d('2026-01-09', 9999, 50)]) === null)
  // Ten days of 10 trades: the newest three cover 30 exactly; older days are not read.
  const ten = Array.from({ length: 10 }, (_, i) => d(`2026-02-${String(i + 1).padStart(2, '0')}`, (i + 1) * 100, 10))
  near('stops once 30 trades are covered (newest 3 of 10 days)', mean(riskYardstickBefore('2026-02-11', ten)), (800 + 900 + 1000) / 30)
  near('… and the SD is over those 30 trades only', riskYardstickBefore('2026-02-11', ten)?.sd, Math.sqrt((80 ** 2 + 90 ** 2 + 100 ** 2) / 3 - 90 ** 2), 1e-9)
  // Whole days: 25 + 10 → both days count in full (35 trades), never a part-day.
  const whole = [d('2026-03-01', 1000, 10), d('2026-03-02', 2500, 25)]
  near('whole days only (25 + a full day of 10 = 35 trades)', mean(riskYardstickBefore('2026-03-03', whole)), 3500 / 35)
  check('days with no stop trades are skipped, not counted', JSON.stringify(riskYardstickBefore('2026-03-03', [...whole, d('2026-03-02b', 0, 0)])) === JSON.stringify(riskYardstickBefore('2026-03-03', whole)))
  // The sequence helper uses the same rule for every day of a window.
  const window = ten.map(x => ({ ...x, trade_parts: null }))
  const seq = tradeSumsInSequence(window)
  const agree = window.every((x, i) => JSON.stringify(seq[i].yardstick) === JSON.stringify(riskYardstickBefore(x.date, window)))
  check('tradeSumsInSequence agrees with riskYardstickBefore on every day', agree)
  // History supplies the days before a window; a date in both counts once.
  const hist = [d('2026-01-20', 3000, 30)]
  near('history before the window feeds its first day', mean(tradeSumsInSequence([{ ...d('2026-02-01', 10, 1), trade_parts: null }], hist)[0].yardstick), 100)
  near('a date in both window and history counts once (window wins)',
    mean(tradeSumsInSequence([{ ...d('2026-01-20', 600, 10), trade_parts: null }, { ...d('2026-01-21', 0, 0), trade_parts: null }], hist)[1].yardstick), 60)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall exit-score checks passed')
