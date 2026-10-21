/**
 * Tests for the three TapeScore axes, part by part (amendment 9 —
 * src/lib/tapescore-axes.ts + src/lib/tapescore.ts), and how a day's rollup and
 * a period carry them (src/lib/day-stats.ts). Pure: no network, no database.
 *
 *   npx tsx scripts/test-tapescore-axes.ts   (also wired into `npm test`)
 *
 *   Risk  = rules kept 45 · loss size 27 · stop size 18 · re-entries after a loss 10
 *   Entry = checklist 45 · order-flow Score 35 (setting, default on) · plan 20
 *   Exit  = profit kept 42 · stop respected 33 · runner rules 25
 */
import {
  computeTapeScore, tapeScoreBase, finishTapeScore, aggregateTapeScore, type TapeScoreResult,
} from '../src/lib/tapescore'
import {
  PART_WEIGHTS, AXIS_PARTS, emptyTradeSums, entryChecklist, axisPartLines, axisTooltip, mergeTradeSums,
  type TradeSums,
} from '../src/lib/tapescore-axes'
import {
  computeDayStats, scoreDayRollups, toStoredStats, fromStoredStats, isFreshStats, STATS_VERSION,
  type TradeForStats, type DayForStats,
} from '../src/lib/day-stats'
import { includeFlowScoreInEntry } from '../src/lib/scoring-profile'
import {
  dailyLossLimitBroken, effectiveAnalysis, effectiveProcess, hasFreshTrigger, noMistakesShare, toProxyTrades,
  sizeUpFails, sizeUpInputs, sizeUpTradeIds,
} from '../src/lib/tapescore-day-rules'
import { dayTradeInputs, dayTradeSums } from '../src/lib/exit-rollup'
import { computeBehavioralProxies, pressingDrawdownIds } from '../src/lib/behavioral-proxies'
import type { ExecutionScore, ProcessVerdict } from '../src/lib/supabase/types'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const near = (name: string, actual: number | null | undefined, expected: number, tol = 0.005) =>
  check(name, actual != null && Math.abs(actual - expected) <= tol, `got ${actual}, expected ${expected}`)

/** Rails with `pass` of five passing. */
const rails = (pass: number, active?: string[]): ProcessVerdict => ({
  per_rule: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5'].map((id, i) => [id, { status: i < pass ? 'pass' : 'fail' }])),
  verdict: pass >= 4 ? 'Compliant' : 'Breach',
  ...(active ? { active_rails: active } : {}),
} as unknown as ProcessVerdict)

const ALL9 = {
  setup_in_playbook: 1, stop_in_atr_band: 1, tp1_at_2r_or_reasoned: 1, clear_area_of_interest: 1,
  two_thirds_orderflow: 1, break_of_cluster_or_bubble_entry: 1, chart_not_emotion_management: 1,
  no_mistakes_tagged: 1, stable_emotion: 1,
}
/** An execution read: checklist from `breakdown`, plan adherence `plan`. */
const exec = (o: Partial<ExecutionScore> & { breakdown?: Partial<typeof ALL9> | null } = {}): ExecutionScore => {
  const { breakdown, ...rest } = o
  return {
    mfe_capture: 0.1, prep_adherence: 0.6, profit_factor: 1, planned_vs_realized_rr: null,
    execution_parameters: 0.5, composite: 0.5, compliant_trade_count: 1,
    ...(breakdown === null ? {} : { execution_parameter_breakdown: { ...ALL9, ...(breakdown ?? {}) } }),
    ...rest,
  } as ExecutionScore
}
/** Trade sums from per-part [n, mean 0..1] pairs. */
const sums = (o: Partial<Record<keyof TradeSums, [number, number]>>): TradeSums => {
  const s = emptyTradeSums()
  for (const [k, v] of Object.entries(o) as [keyof TradeSums, [number, number]][]) s[k] = { n: v[0], sum: v[0] * v[1] }
  return s
}

// ── Weights ──────────────────────────────────────────────────────────────────
console.log('weights')
for (const axis of ['risk', 'entry', 'exit'] as const) {
  near(`${axis} weights sum to 1`, AXIS_PARTS[axis].reduce((a, k) => a + PART_WEIGHTS[k], 0), 1, 1e-12)
}
check('Risk 45/27/18/10', PART_WEIGHTS.rules === 0.45 && PART_WEIGHTS.lossSize === 0.27 && PART_WEIGHTS.stopSize === 0.18 && PART_WEIGHTS.reentry === 0.10)
check('Entry 31.5/30/24.5/14 (founder 2026-10-14: entry rules 30, the rest ×0.7)', PART_WEIGHTS.checklist === 0.315 && PART_WEIGHTS.entryRules === 0.3 && PART_WEIGHTS.flow === 0.245 && PART_WEIGHTS.plan === 0.14)
check('Exit 42/33/25', PART_WEIGHTS.kept === 0.42 && PART_WEIGHTS.stopRespected === 0.33 && PART_WEIGHTS.runner === 0.25)

// ── Risk ─────────────────────────────────────────────────────────────────────
console.log('risk')
{
  const e = exec()
  const full = computeTapeScore({ process: rails(5), execution: e, trades: sums({ lossSize: [2, 0.5], stopSize: [4, 0.75] }) })!
  near('rules 100 · loss 50 · stop 75 → 50 + 15 + 15 = 80', full.components.risk, 80, 0)
  const noLosers = computeTapeScore({ process: rails(5), execution: e, trades: sums({ stopSize: [4, 0.5] }) })!
  near('no losers: rules carries 50/70', noLosers.parts?.risk.rules.weight, 0.5 / 0.7, 1e-9)
  near('no losers: stop size carries 20/70', noLosers.parts?.risk.stopSize.weight, 0.2 / 0.7, 1e-9)
  check('no losers: 71 / 29', [noLosers.parts!.risk.rules.weight, noLosers.parts!.risk.stopSize.weight].map(w => Math.round(w * 100)).join('/') === '71/29')
  near('no losers: 100×50/70 + 50×20/70 ≈ 86', noLosers.components.risk, 86, 0)
  const noStops = computeTapeScore({ process: rails(5), execution: e, trades: sums({ lossSize: [1, 0] }) })!
  near('no stop trades: rules 50/80, loss size 30/80 → 62.5', noStops.components.risk, 63, 0)
  const rulesOnly = computeTapeScore({ process: rails(4), execution: e, trades: null })!
  near('nothing per-trade: Risk = rules kept (4 of 5 = 80)', rulesOnly.components.risk, 80, 0)
  const noRails = computeTapeScore({ process: null, execution: e, trades: sums({ lossSize: [1, 1], stopSize: [1, 1], kept: [1, 1] }) })!
  check('no rails audit → no Risk axis, whatever the trades', noRails.components.risk === null)
  check('… and Entry + Exit re-weight', noRails.score === Math.round(((noRails.components.entry ?? 0) + 100) / 2), String(noRails.score))
  const noneTracked = computeTapeScore({ process: rails(5, []), execution: e, trades: sums({ lossSize: [1, 1] }) })!
  check('tracking no rails → no Risk axis', noneTracked.components.risk === null)
  // Re-entries: the light fourth part.
  const all4 = computeTapeScore({ process: rails(5), execution: e, trades: sums({ lossSize: [2, 0.5], stopSize: [4, 0.75], reentry: [2, 0] }) })!
  near('all four: 45 + 13.5 + 13.5 + 0 = 72', all4.components.risk, 72, 0)
  near('re-entries carry 10%', all4.parts?.risk.reentry.weight, 0.10, 1e-12)
  check('no quick re-entries → the other three keep 50/30/20 (same as 45/27/18 rescaled)',
    Math.round(full.parts!.risk.rules.weight * 100) === 50 && Math.round(full.parts!.risk.lossSize.weight * 100) === 30)
  const onlyReentry = computeTapeScore({ process: rails(5), execution: e, trades: sums({ reentry: [1, 0] }) })!
  near('rules + re-entries only: 45/55 and 10/55 → 82', onlyReentry.components.risk, 82, 0)
}

// ── Breach cap: the rules alone ───────────────────────────────────────────────
console.log('breach cap')
{
  const perfect = sums({ lossSize: [3, 1], stopSize: [3, 1], kept: [3, 1], stopRespected: [3, 1], flow: [3, 1] })
  const breach = computeTapeScore({ process: rails(3), execution: exec({ prep_adherence: 1 }), trades: perfect })!
  check('rules broken → capped at 49 even with perfect loss and stop size', breach.score === 49 && breach.capped)
  const awful = sums({ lossSize: [5, 0], stopSize: [5, 0] })
  const kept = computeTapeScore({ process: rails(5), execution: exec({ prep_adherence: 1 }), trades: awful })!
  check('rules kept → never capped, however bad the sizing', !kept.capped && kept.components.verdict === 'Compliant')
  near('… sizing still pulls Risk down (rules 100 only → 50)', kept.components.risk, 50, 0)
}

// ── Exit ─────────────────────────────────────────────────────────────────────
console.log('exit')
{
  const r = computeTapeScore({ process: rails(5), execution: exec(), trades: sums({ kept: [2, 1], stopRespected: [1, 0], runner: [1, 1] }) })!
  near('all three: 42 + 0 + 25 = 67', r.components.exit, 67, 0)
  const noRunner = computeTapeScore({ process: rails(5), execution: exec(), trades: sums({ kept: [2, 1], stopRespected: [1, 0] }) })!
  check('no runner: 56 / 44', [noRunner.parts!.exit.kept.weight, noRunner.parts!.exit.stopRespected.weight].map(w => Math.round(w * 100)).join('/') === '56/44')
  near('no runner: 100 × 42/75 = 56', noRunner.components.exit, 56, 0)
  const sizingOnly = computeTapeScore({ process: rails(5), execution: exec(), trades: sums({ lossSize: [1, 0], stopSize: [1, 0] }) })!
  check('loss size and stop size no longer touch Exit', sizingOnly.components.exit === null)
}

// ── Entry · checklist ─────────────────────────────────────────────────────────
console.log('entry checklist')
{
  near('the three dropped items are ignored', entryChecklist(exec({ breakdown: { stop_in_atr_band: 0, chart_not_emotion_management: 0, stable_emotion: 0 } })).value, 1, 1e-12)
  near('mean of the six kept items', entryChecklist(exec({ breakdown: { setup_in_playbook: 0, no_mistakes_tagged: 0.5 } })).value, 4.5 / 6, 1e-12)
  near('null items (not applicable that day) are skipped', entryChecklist(exec({
    breakdown: { setup_in_playbook: 0.4, tp1_at_2r_or_reasoned: null, clear_area_of_interest: null, two_thirds_orderflow: null, break_of_cluster_or_bubble_entry: null, no_mistakes_tagged: null },
  } as never)).value, 0.4, 1e-12)
  const legacy = entryChecklist(exec({ breakdown: null, execution_parameters: 0.37 }))
  check('no breakdown stored → the stored overall value as is', legacy.value === 0.37 && legacy.legacy)
  const allNull = entryChecklist(exec({ breakdown: Object.fromEntries(Object.keys(ALL9).map(k => [k, null])) as never }))
  check('a breakdown with every kept item null → no checklist (part drops)', allNull.value === null && !allNull.legacy)
}

// ── Entry · blend, order-flow Score on / off ──────────────────────────────────
console.log('entry blend')
{
  // checklist 100 (all items pass), plan 60, flow 40 on 2 trades
  const e = exec({ prep_adherence: 0.6 })
  const t = sums({ flow: [2, 0.4] })
  const on = computeTapeScore({ process: rails(5), execution: e, trades: t, includeFlow: true })!
  near('Score on: 45×100 + 35×40 + 20×60 = 71', on.components.entry, 71, 0)
  const off = computeTapeScore({ process: rails(5), execution: e, trades: t, includeFlow: false })!
  near('Score off: checklist 45/65 + plan 20/65 → 88', off.components.entry, 88, 0)
  check('Score off: 69 / 31', [off.parts!.entry.checklist.weight, off.parts!.entry.plan.weight].map(w => Math.round(w * 100)).join('/') === '69/31')
  const none = computeTapeScore({ process: rails(5), execution: e, trades: sums({}), includeFlow: true })!
  check('Score on but no scored trades = same as off', none.components.entry === off.components.entry)
  check('the default is ON (no option passed)', computeTapeScore({ process: rails(5), execution: e, trades: t })!.components.entry === on.components.entry)
  const pfLow = computeTapeScore({ process: rails(5), execution: exec({ profit_factor: 0.1 }), trades: t })!
  const pfHigh = computeTapeScore({ process: rails(5), execution: exec({ profit_factor: 5 }), trades: t })!
  check('profit factor no longer affects Entry', pfLow.components.entry === pfHigh.components.entry)
  const capLow = computeTapeScore({ process: rails(5), execution: exec({ mfe_capture: 0 }), trades: t })!
  check('mfe_capture still never read', capLow.components.entry === pfHigh.components.entry)
  const nothing = computeTapeScore({ process: rails(5), execution: exec({ breakdown: null, execution_parameters: null, prep_adherence: null, composite: null }), trades: null })!
  check('an execution read with nothing readable is a real 0', nothing.components.entry === 0)
  check('legacy score row unchanged', computeTapeScore({ legacyScore: 7.4 })?.score === 74 && computeTapeScore({ legacyScore: 7.4 })?.basis === 'legacy')
  check('no analysis → no TapeScore, whatever the trades say', computeTapeScore({ trades: sums({ kept: [1, 1] }) }) === null)
}

// ── TapeScore blend + caching the base ─────────────────────────────────────────
console.log('tapescore')
{
  const e = exec({ prep_adherence: 0.6 })
  const t = sums({ lossSize: [1, 1], stopSize: [2, 0.5], flow: [2, 0.4], kept: [1, 1] })
  const r = computeTapeScore({ process: rails(5), execution: e, trades: t })!
  check('score = mean of the three unrounded axes', r.score === Math.round(((50 + 30 + 10) + 71 + 100) / 3), `${r.score} ${JSON.stringify(r.components)}`)
  const base = tapeScoreBase({ process: rails(5), execution: e })!
  const later = finishTapeScore(JSON.parse(JSON.stringify(base)), t)
  check('base cached as JSON + trades later = computed in one go', JSON.stringify(later) === JSON.stringify(r))
}

// ── Explanations ───────────────────────────────────────────────────────────────
console.log('explanations')
{
  const e = exec()
  const day = computeTapeScore({ process: rails(4), execution: e, trades: sums({ stopSize: [3, 1], kept: [1, 0.5] }), includeFlow: false })!
  const risk = axisPartLines(day.parts, 'risk')
  check('rules kept reads "score · x of y kept"', risk[0].detail === '80 · 4 of 5 kept', risk[0].detail)
  check('loss size with no losers reads "not applicable"', risk[1].detail === 'not applicable')
  check('stop size reads "score · trades"', risk[2].detail === '100 · 3 trades', risk[2].detail)
  const entry = axisPartLines(day.parts, 'entry')
  check('Score switched off reads "off"', entry[2].detail === 'off')
  check('no entry rules reads "no counted trades"', entry[1].key === 'entryRules' && entry[1].detail === 'no counted trades')
  const onNone = computeTapeScore({ process: rails(4), execution: e, trades: null })!
  check('Score on with nothing scored reads "no scored trades"', axisPartLines(onNone.parts, 'entry')[2].detail === 'no scored trades')
  check('Entry hover text names the checklist items', /setup in your playbook/.test(axisTooltip('Entry', day.parts, 'entry')))
  check('… unless asked not to', !/setup in your playbook/.test(axisTooltip('Entry', day.parts, 'entry', { checklistItems: false })))
}

// ── Period: per-trade parts pooled, session parts averaged ────────────────────
console.log('period pooling')
{
  const e = exec({ prep_adherence: 0.6 })
  const mk = (pass: number, t: TradeSums, includeFlow = true) => {
    const tapescore = computeTapeScore({ process: rails(pass), execution: e, trades: t, includeFlow }) as TapeScoreResult
    return { tapescore, trade_sums: t }
  }
  // Day A: one loser scored 1; day B: three losers scored 0.
  const a = mk(5, sums({ lossSize: [1, 1], flow: [1, 1], kept: [1, 1] }))
  const b = mk(4, sums({ lossSize: [3, 0], flow: [3, 0], kept: [3, 0] }))
  const p = aggregateTapeScore([a, b, { tapescore: null, trade_sums: a.trade_sums }])
  near('loss size pooled over the 4 losers (25), not the mean of days (50)', p.parts?.risk.lossSize.score, 25, 1e-9)
  check('loss size carries the pooled count', p.parts?.risk.lossSize.n === 4)
  near('rules kept = mean over sessions (100, 80 → 90)', p.parts?.risk.rules.score, 90, 1e-9)
  check('rules kept counts the rails (9 of 10)', p.parts?.rulesKept === 9 && p.parts?.rulesOf === 10)
  near('period Risk = 90×50/80 + 25×30/80 ≈ 66', p.risk, 66, 0)
  near('order-flow Score pooled over the 4 scored trades (25)', p.parts?.entry.flow.score, 25, 1e-9)
  near('period Entry = 45×100 + 35×25 + 20×60 ≈ 66', p.entry, 66, 0)
  near('profit kept pooled (25)', p.exit, 25, 0)
  check('headline = mean of day TapeScores', p.score === Math.round((a.tapescore.score + b.tapescore.score) / 2), String(p.score))
  check('an unscored day adds nothing', p.scoredDays === 2 && mergeTradeSums([a.trade_sums, b.trade_sums]).lossSize.n === 4)
  const off = aggregateTapeScore([mk(5, a.trade_sums, false), mk(4, b.trade_sums, false)])
  check('Score off on the days → off for the period', off.parts?.flowOn === false && off.parts?.entry.flow.score === null)
  near('… and Entry is checklist + plan only (88)', off.entry, 88, 0)
  // A day without a rules audit adds its trades to Exit but not to Risk.
  const noRails = { tapescore: computeTapeScore({ process: null, execution: e, trades: sums({ lossSize: [10, 0], kept: [10, 1] }) }) as TapeScoreResult, trade_sums: sums({ lossSize: [10, 0], kept: [10, 1] }) }
  const p2 = aggregateTapeScore([a, noRails])
  check('a day with no Risk axis adds no losers to the period Risk', p2.parts?.risk.lossSize.n === 1)
  check('… but its trades still count for Exit', p2.parts?.exit.kept.n === 11)
}

// ── The rollup carries the inputs; the score is finished at read time ──────────
console.log('rollup')
{
  let seq = 0
  const long = (exit: number, o: Partial<TradeForStats> = {}): TradeForStats => ({
    id: `t${++seq}`, tags_json: {}, pnl: (exit - 100) * 2, direction: 'long', entry_price: 100, exit_price: exit,
    stop_price: 90, tp1_price: 120, high_during_position: Math.max(100, exit), low_during_position: Math.min(100, exit),
    quantity: 1, symbol: 'MNQZ6.CME', entry_atr_1m: 10, exits_json: [{ qty: 1, price: exit }], mfe_dollars_per_leg: null,
    structure_5m_alignment: null, ...o,
  })
  const eod = { process: rails(5), execution: exec({ prep_adherence: 0.8 }) }
  const mkDay = (date: string, withEod: boolean): DayForStats => ({ id: date, date, eod_pnl: null, day_type: null, day_types: null, ai_analysis_json: null, eod_ai_analysis_json: withEod ? eod as never : null })
  // Six prior days of five $20-risk trades (30 trades), then a day with a $30 loss and a scored winner.
  const prior = Array.from({ length: 6 }, (_, i) => computeDayStats(mkDay(`2026-04-0${i + 1}`, false), Array.from({ length: 5 }, () => long(110)), null))
  const today = computeDayStats(mkDay('2026-04-07', true), [long(85), long(110, { flow_total: 30 })], null)
  check('rollup stores trade inputs + the analysis base, not a finished score', 'trade_parts' in today && 'tape' in today && !('tapescore' in today))
  const on = scoreDayRollups([...prior, today]).at(-1)!
  const off = scoreDayRollups([...prior, today], [], { includeFlow: false }).at(-1)!
  // The prior 30 trades all risked $20 → yardstick mean $20, SD $0: a $30 loss is past mean + 2 SD.
  near('loss size measured against the prior 30 trades (mean $20, SD 0) → $30 loss = 0', on.trade_sums?.lossSize.sum, 0, 1e-9)
  check('loss size lands in Risk', on.tapescore?.parts?.risk.lossSize.n === 1)
  check('the order-flow Score is read from the trade (default on)', on.tapescore?.parts?.entry.flow.n === 1 && Math.round(on.tapescore.parts.entry.flow.score!) === 30)
  check('switching the Score off changes Entry from the SAME rollup (no recompute)', off.tapescore?.components.entry !== on.tapescore?.components.entry && off.tapescore?.parts?.flowOn === false)
  const stored = toStoredStats(on)
  check('the read-time fields are never cached', !('tapescore' in stored) && !('trade_sums' in stored))
  const back = fromStoredStats(JSON.parse(JSON.stringify(stored)), { id: on.id, date: on.date, day_type: null, day_types: null })
  check('a cached row scores identically', JSON.stringify(scoreDayRollups([...prior, back]).at(-1)!.tapescore) === JSON.stringify(on.tapescore))
  check('STATS_VERSION is 16', STATS_VERSION === 16)
  check('fresh at this version + same ATR setting', isFreshStats({ stats_json: stored, stats_version: STATS_VERSION }, 1, ''))
  check('stale when the ATR setting changed', !isFreshStats({ stats_json: stored, stats_version: STATS_VERSION }, 2, ''))
  check('stale at the old version', !isFreshStats({ stats_json: stored, stats_version: 13 }, 1, ''))
  check('stale when the trader has entry rules the row was not computed with', !isFreshStats({ stats_json: stored, stats_version: STATS_VERSION }, 1, 'er1-1-abc'))
}

// ── Read-time rules from the trades ────────────────────────────────────────────
console.log('read-time rules')
{
  // A day's trades: `at` = PT minutes after 08:00, held `hold` minutes.
  let n = 0
  // `stopPts` gives the trade a stop that many MNQ points away ($2 a point per lot).
  const tr = (at: number, qty: number, pnl: number, tags: object | null = {}, hold = 1, stopPts: number | null = null) => {
    const t0 = Date.UTC(2026, 8, 29, 15, 0) + at * 60000
    const t: TradeForStats = {
      id: `r${++n}`, direction: 'long', quantity: qty, pnl, tags_json: tags,
      entry_time: new Date(t0).toISOString(), exit_time: new Date(t0 + hold * 60000).toISOString(),
      entry_price: 100, exit_price: 100, stop_price: stopPts != null ? 100 - stopPts : null, tp1_price: null, high_during_position: 100, low_during_position: 100,
      symbol: 'MNQZ6.CME', entry_atr_1m: null, exits_json: [], mfe_dollars_per_leg: null, structure_5m_alignment: null,
    }
    return t
  }
  const active = (ids: string[], statuses: Record<string, 'pass' | 'fail'>, verdict: 'Compliant' | 'Breach' = 'Compliant') => ({
    per_rule: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5'].map(id => [id, { status: statuses[id] ?? 'pass' }])),
    verdict, active_rails: ids,
  } as unknown as ProcessVerdict)

  // 1 · daily loss limit = hard breach
  const dll = active(['P1', 'P2', 'P3', 'P5'], { P1: 'fail' })
  check('P1 fail is a breach even with 3 of 4 kept (stored verdict Compliant)', dailyLossLimitBroken(dll) && effectiveProcess(dll, null)?.verdict === 'Breach')
  const dllScore = computeTapeScore({ process: dll, execution: exec({ prep_adherence: 1 }), trades: sums({ kept: [1, 1] }) })!
  check('… and the day caps at 49', dllScore.score === 49 && dllScore.capped && dllScore.components.verdict === 'Breach')
  const untracked = active(['P2', 'P3', 'P5'], { P1: 'fail' })
  check('an untracked P1 changes nothing', !dailyLossLimitBroken(untracked) && effectiveProcess(untracked, null)?.verdict === 'Compliant')
  const owner = rails(5)
  ;(owner.per_rule as Record<string, { status: string }>).P1 = { status: 'fail' }
  check('no active_rails (all five tracked): P1 fail is a breach', computeTapeScore({ process: owner, execution: exec() })?.components.verdict === 'Breach')

  // 2 · P3 against the trader's usual risk spread (mean + 2 SD of planned $ risk)
  const usual = { mean: 100, sd: 20, n: 30 }                     // size-up = planned risk above $140
  const p3Of = (trades: TradeForStats[], y: typeof usual | null, statuses: Record<string, 'pass' | 'fail'> = {}) =>
    effectiveProcess(active(['P1', 'P2', 'P3', 'P5'], statuses), trades, y)!
  const p3Status = (p: ProcessVerdict) => (p.per_rule as Record<string, { status: string }>).P3.status
  // $100 normal risk = 50 MNQ points x 1 lot.
  const normalWhileRed = [tr(0, 1, -100, {}, 1, 50), tr(5, 1, 20, {}, 1, 50), tr(10, 2, -40, {}, 1, 25)]
  check('a return to normal size while red passes (risk $100 <= $140, even at more lots)', p3Status(p3Of(normalWhileRed, usual)) === 'pass')
  const bigAfterLoss = [tr(0, 1, -100, {}, 1, 50), tr(5, 1, -150, {}, 1, 75)]   // $150 planned risk
  check('1.5x normal after a loss ($150 > mean + 2 SD = $140) fails', p3Status(p3Of(bigAfterLoss, usual)) === 'fail')
  check('the same $150 trade after a WIN on a green day is not judged', p3Status(p3Of([tr(0, 1, 100, {}, 1, 50), tr(5, 1, -150, {}, 1, 75)], usual)) === 'pass')
  const founder = { mean: 130, sd: 76, n: 30 }                    // +2 SD = $282
  check('founder yardstick: $200 after a loss is fine', p3Status(p3Of([tr(0, 1, -50, {}, 1, 25), tr(5, 1, -50, {}, 1, 100)], founder)) === 'pass')
  check('founder yardstick: $300 after a loss is oversized', p3Status(p3Of([tr(0, 1, -50, {}, 1, 25), tr(5, 1, -50, {}, 1, 150)], founder)) === 'fail')
  const noStop = [tr(0, 1, -100, {}, 1, 50), tr(5, 10, -500, {}, 1, null)]
  check('a trade without a stop is not judged (10 lots, no stop -> pass)', p3Status(p3Of(noStop, usual, { P3: 'fail' })) === 'pass')
  check('sizeUpInputs keeps it as an unjudged entry', JSON.stringify(sizeUpInputs(noStop).pressed) === '[null]')
  // No yardstick yet -> the old quantity rule (bigger than every size so far).
  const sizeUp = [tr(0, 5, -30), tr(5, 10, -200), tr(10, 10, -100)]
  check('no yardstick: 5 -> 10 lots after a loss fails (quantity rule)', p3Status(p3Of(sizeUp, null)) === 'fail')
  check('no yardstick: 5 -> 3 -> 5 is a return to normal size -> pass', p3Status(p3Of([tr(0, 5, 50), tr(5, 3, -20), tr(10, 5, -20)], null, { P3: 'fail' })) === 'pass')
  check('the fallback is the recap proxy, unchanged', JSON.stringify(pressingDrawdownIds(toProxyTrades(sizeUp))) === JSON.stringify([sizeUp[1].id])
    && computeBehavioralProxies(toProxyTrades(sizeUp)).proxies.find(p => p.key === 'pressing_drawdown')?.evidence.join() === '2')
  check('sizeUpFails: yardstick vs fallback', sizeUpFails(sizeUpInputs(bigAfterLoss), usual) === 1 && sizeUpFails({ pressed: [500], qty_hits: 0 }, null) === 0)
  // The Session behavior panel names the same trades (founder 2026-10-20: more lots at the same risk is not pressing).
  check('sizeUpTradeIds = the trade sizeUpFails counts', JSON.stringify(sizeUpTradeIds(bigAfterLoss, usual)) === JSON.stringify([bigAfterLoss[1].id]))
  check('sizeUpTradeIds: more lots at normal risk while red names nothing', sizeUpTradeIds(normalWhileRed, usual).length === 0)
  check('sizeUpTradeIds: no yardstick -> the quantity rule', JSON.stringify(sizeUpTradeIds(sizeUp, null)) === JSON.stringify([sizeUp[1].id]))
  check('the panel reads those ids: 1 -> 2 lots at $50 risk while red is not "pressing"',
    computeBehavioralProxies(toProxyTrades(normalWhileRed), null, { pressingIds: sizeUpTradeIds(normalWhileRed, usual) }).proxies.find(p => p.key === 'pressing_drawdown')?.count === 0
    && computeBehavioralProxies(toProxyTrades(normalWhileRed)).proxies.find(p => p.key === 'pressing_drawdown')?.count === 1)
  const lapse = p3Of(bigAfterLoss, usual)
  check('one lapse with 4 rails tracked stays Compliant', lapse.verdict === 'Compliant')
  check('a second failed rail makes it a Breach', p3Of(bigAfterLoss, usual, { P2: 'fail' }).verdict === 'Breach')
  check('P3 untracked -> left as stored', p3Status(effectiveProcess(active(['P1', 'P2'], {}), bigAfterLoss, usual)!) === 'pass')
  check('no yardstick passed (undefined) -> P3 left as stored', p3Status(effectiveProcess(active(['P3'], {}), bigAfterLoss)!) === 'pass')

  // 3 · no mistakes tagged, from the tags
  near('share of trades with no mistakes', noMistakesShare([tr(0, 1, 1, { mistakes: ['Chased'] }), tr(5, 1, 1, { mistakes: [] }), tr(9, 1, 1, {})]), 2 / 3, 1e-12)
  check('no trade with tags at all → not applicable', noMistakesShare([tr(0, 1, 1, null), tr(5, 1, 1, null)]) === null)
  const withNull = exec({ breakdown: { no_mistakes_tagged: null } as never })
  const eff = effectiveAnalysis({ execution: withNull } as never, [tr(0, 1, -1, { mistakes: ['Revenge Trading'] })])
  check('the stored AI value (null) is replaced by the trades\' tags (0)', eff?.execution?.execution_parameter_breakdown?.no_mistakes_tagged === 0)

  // 4 · re-entries after a loss
  check('fresh trigger = an entry model other than "Based on Price"', hasFreshTrigger({ tags_json: { entry_model: ['Break of Candle'] } }) && hasFreshTrigger({ tags_json: { entry_model: ['based on price', 'Break of Clusters/Bubbles'] } }))
  check('only "Based on Price" (any case) or nothing = no fresh trigger', !hasFreshTrigger({ tags_json: { entry_model: ['BASED ON PRICE'] } }) && !hasFreshTrigger({ tags_json: { entry_model: [] } }) && !hasFreshTrigger({ tags_json: {} }))
  const seq = [
    tr(0, 1, -10, {}, 1),                                         // loss, exits 08:01
    tr(4, 1, 10, { entry_model: ['Break of Candle'] }, 2),        // 3 min after a loss → judged, pass; exits 08:06 (win)
    tr(9, 1, -10, { entry_model: ['Based on Price'] }, 1),        // 3 min after a WIN, 8 after the loss → not judged; exits 08:10
    tr(16, 1, 5, {}, 1),                                          // 6 min after a loss → not judged
    tr(18, 1, 5, {}, 1),                                          // 8 min after the 08:10 loss → not judged
  ]
  const s = dayTradeInputs(seq, 1)
  check('only trades within 5 min of a losing exit are judged (1 of 5)', s.reentry.n === 1 && s.reentry.sum === 1, JSON.stringify(s.reentry))
  const quick = [tr(0, 1, -10, {}, 1), tr(3, 1, -10, { entry_model: ['Based on Price'] }, 1), tr(5, 1, 5, {}, 1)]
  const q = dayTradeInputs(quick, 1)
  check('quick re-entries without a fresh trigger fail (0 of 2)', q.reentry.n === 2 && q.reentry.sum === 0, JSON.stringify(q.reentry))
  check('a day with none drops the part', computeTapeScore({ process: rails(5), execution: exec(), trades: dayTradeSums(dayTradeInputs([tr(0, 1, 5)], 1), null) })!.parts?.risk.reentry.score === null)
}

// ── Sep 29, 2026 — the founder's day that scored far too well ─────────────────
console.log('2026-09-29')
{
  // The four trades as stored (UTC; 08:42–08:53 PT), and the stored analysis:
  // P1 failed, the rest passed, 4 rails tracked, verdict "Compliant".
  const T = (id: string, sym: string, dir: 'long' | 'short', qty: number, pnl: number, entry: string, exit: string,
    ep: number, xp: number, sp: number, tags: object): TradeForStats => ({
    id, symbol: sym, direction: dir, quantity: qty, pnl, entry_time: `2026-09-29T${entry}Z`, exit_time: `2026-09-29T${exit}Z`,
    entry_price: ep, exit_price: xp, stop_price: sp, tp1_price: null, tags_json: tags,
    high_during_position: Math.max(ep, xp), low_during_position: Math.min(ep, xp), entry_atr_1m: null,
    exits_json: [{ qty, price: xp }], mfe_dollars_per_leg: null, structure_5m_alignment: null,
  })
  const trades = [
    T('t1', 'MESZ6.CME', 'short', 5, -31.25, '15:42:00', '15:44:38', 7726, 7727.25, 7728.5, { mistakes: ['Faded HTF Area/Move'], entry_model: ['Break of Clusters/Bubbles'] }),
    T('t2', 'MESZ6.CME', 'short', 10, -200, '15:47:00', '15:47:21', 7726, 7730, 7729.75, { mistakes: ['Faded HTF Area/Move'], entry_model: ['Based on Price'] }),
    T('t3', 'MESZ6.CME', 'long', 10, -137.5, '15:50:00', '15:51:27', 7726, 7723.25, 7722, { mistakes: ['Flip Flop at a Level', 'Revenge Trading'] }),
    T('t4', 'MNQZ6.CME', 'long', 10, -271, '15:53:00', '16:04:52', 30567, 30553.45, 30552, { mistakes: ['Flip Flop at a Level', 'Revenge Trading', 'Oversized'] }),
  ]
  const eod = {
    process: {
      per_rule: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5'].map(id => [id, { status: id === 'P1' ? 'fail' : 'pass' }])),
      verdict: 'Compliant', active_rails: ['P1', 'P2', 'P3', 'P5'],
    },
    execution: exec({
      prep_adherence: 0.38, composite: 0.3003, execution_parameters: 0.51, profit_factor: 0, mfe_capture: 0,
      breakdown: {
        stable_emotion: 0.5, stop_in_atr_band: 0.75, setup_in_playbook: 1, no_mistakes_tagged: null,
        two_thirds_orderflow: null, tp1_at_2r_or_reasoned: 1, clear_area_of_interest: 0.5,
        chart_not_emotion_management: null, break_of_cluster_or_bubble_entry: null,
      } as never,
    }),
  }
  const day: DayForStats = { id: 'sep29', date: '2026-09-29', eod_pnl: null, day_type: null, day_types: null, ai_analysis_json: null, eod_ai_analysis_json: eod as never }
  // History before the day: 30 stop trades with the founder's spread (mean $130, SD $76).
  const hist = [{ date: '2026-09-28', sum_risk_dollars: 30 * 130, sum_risk_sq: 30 * (130 ** 2 + 76 ** 2), risk_sample: 30 }]
  const r = scoreDayRollups([computeDayStats(day, trades, null)], hist).at(-1)!
  const ts = r.tapescore!
  check('trades 2 and 3 ($187.50, $200) sit within mean + 2 SD ($282); trade 4 risked $300 (10 MNQ x 15 pts) -> P3 fails',
    r.process_breach_rules?.includes('P3') === true, JSON.stringify(r.process_breach_rules))
  check('... only trade 4 is over', sizeUpFails(sizeUpInputs(trades), { mean: 130, sd: 76, n: 30 }) === 1
    && JSON.stringify(sizeUpInputs(trades).pressed) === JSON.stringify([187.5, 200, 300]))
  check('the day reads as a Breach (P1 broken)', r.process_verdict === 'Breach' && ts.components.verdict === 'Breach')
  check('rules kept 2 of 4', ts.parts?.rulesKept === 2 && ts.parts?.rulesOf === 4)
  const noHist = scoreDayRollups([computeDayStats(day, trades, null)]).at(-1)!
  check('with no yardstick yet: the quantity rule (5 -> 10 after a loss) -> P3 fails', noHist.process_breach_rules?.includes('P3') === true && noHist.tapescore?.parts?.rulesKept === 2)
  check('... and it still caps at 49', noHist.tapescore?.score === 49)
  // The Recap page path: the analysis corrected with the same yardstick agrees.
  const recap = effectiveAnalysis(eod as never, trades, { mean: 130, sd: 76, n: 30 })
  check('Recap rules card = rollup (same yardstick)', recap?.process?.verdict === r.process_verdict
    && (recap?.process?.per_rule as Record<string, { status: string }>).P3.status === 'fail')
  check('no mistakes tagged = 0 (every trade carries mistakes)', ts.parts?.entry.checklist.score != null)
  near('checklist = mean(setup 1, TP1 1, area 0.5, no mistakes 0) = 62.5', ts.parts?.entry.checklist.score, 62.5, 1e-9)
  check('re-entries: trades 2, 3, 4 judged, none with a fresh trigger', ts.parts?.risk.reentry.n === 3 && ts.parts?.risk.reentry.score === 0)
  check('capped at 49', ts.score === 49 && ts.capped, `${ts.score} ${JSON.stringify(ts.components)}`)
}

// ── The setting ────────────────────────────────────────────────────────────────
console.log('setting')
{
  check('no profile → on', includeFlowScoreInEntry(null) === true)
  check('a profile that never touched it → on', includeFlowScoreInEntry({ rails: { max_size: 5 } }) === true)
  check('switched off → off', includeFlowScoreInEntry({ tapescore: { entry_flow_score: false } }) === false)
  check('switched on → on', includeFlowScoreInEntry({ tapescore: { entry_flow_score: true } }) === true)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall tapescore-axes checks passed')
