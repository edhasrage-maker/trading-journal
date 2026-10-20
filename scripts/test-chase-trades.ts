/**
 * Chase trades (src/lib/tapescore-day-rules.ts): quick re-entries after a loss
 * with no fresh trigger. Two or more cap the day's TapeScore at 69
 * (src/lib/tapescore.ts); each re-entry after a loss gets "Waited after a loss"
 * in its Score (src/lib/trade-grade.ts). Founder-approved mockup
 * docs/chase-score-mockup.html, 2026-10-19. Pure, no data needed.
 *
 *   npx tsx scripts/test-chase-trades.ts
 */
import { chaseTrades, reentryReads, type ReentryTrade } from '../src/lib/tapescore-day-rules.ts'
import { computeDayStats, scoreDayRollups, type DayForStats, type TradeForStats } from '../src/lib/day-stats.ts'
import { tradeGrade } from '../src/lib/trade-grade.ts'
import type { ExecutionScore, ProcessVerdict } from '../src/lib/supabase/types.ts'

let failed = 0
const check = (name: string, ok: boolean, got?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`); if (!ok) failed++ }
const PT = (hms: string) => new Date(`2026-10-19T${hms}-07:00`).toISOString()

console.log('which trades are chase trades (Oct 19 as it happened)')
{
  // the founder's real Oct 19: times, results, triggers
  const t = (id: string, inAt: string, outAt: string, dir: 'long' | 'short', pnl: number, em: string[] | undefined, stopped: boolean): ReentryTrade => ({
    id, entry_time: PT(inAt), exit_time: PT(outAt), direction: dir, pnl, quantity: 5, symbol: 'MNQZ6.CME',
    entry_price: 100, stop_price: dir === 'long' ? 90 : 110, tp1_price: dir === 'long' ? 130 : 70,
    exit_price: stopped ? (dir === 'long' ? 90 : 110) : 99, exits_json: [{ qty: 5, price: stopped ? (dir === 'long' ? 90 : 110) : 99 }],
    high_during_position: 101, low_during_position: 89, tags_json: em ? { entry_model: em } : {},
  })
  const day = [
    t('a', '08:57:29', '08:58:08', 'long', -60, ['1 ATR Entry'], false),
    t('b', '09:04:10', '09:20:50', 'long', -120, undefined, true),
    t('c', '09:25:15', '09:40:06', 'short', 291, ['Based on Price'], false),
    t('d', '10:05:02', '10:07:14', 'long', -150, undefined, true),
    t('e', '10:07:59', '10:09:38', 'long', -150, undefined, true),
    t('f', '10:11:29', '10:20:32', 'long', -63, undefined, false),
  ]
  const reads = reentryReads(day)
  check('re-entries within 5 min of a losing exit: 09:25, 10:07:59, 10:11:29', JSON.stringify([...reads.keys()]) === JSON.stringify(['c', 'e', 'f']), [...reads.keys()])
  check('10:05:02 is not one: 25 min after the last loss (09:25 won)', !reads.has('d'))
  check('09:04:10 is not one: 6 min 2 s after the 08:58 loss', !reads.has('b'))
  const e = reads.get('e')!
  check('10:07:59: 45 s after the 10:07:14 stop-out, no trigger', e.gapSec === 45 && e.afterExit === PT('10:07:14') && e.afterStopOut && !e.fresh && e.triggers.length === 0, e)
  const c = reads.get('c')!
  check('09:25: 265 s after the 09:20:50 stop-out; "Based on Price" alone is not fresh', c.gapSec === 265 && c.afterStopOut && !c.fresh && c.triggers[0] === 'Based on Price', c)
  const f = reads.get('f')!
  check('10:11:29 reads the LATEST losing exit (10:09:38, a stop-out), 111 s', f.gapSec === 111 && f.afterExit === PT('10:09:38') && f.afterStopOut, f)
  check('chase trades: 3, oldest first', JSON.stringify(chaseTrades(day).map(x => x.id)) === JSON.stringify(['c', 'e', 'f']))
  const fresh = day.map(x => x.id === 'e' ? { ...x, tags_json: { entry_model: ['Based on Price', 'Break of Clusters/Bubbles'] } } : x)
  check('a fresh trigger beside "Based on Price" passes', reentryReads(fresh).get('e')?.fresh === true && chaseTrades(fresh).length === 2)
  const manual = reentryReads(day.map(x => x.id === 'd' ? { ...x, exit_price: 95, exits_json: [{ qty: 5, price: 95 }] } : x)).get('e')!
  check('after a loss closed by hand it says "loss", not "stop-out"', manual.afterStopOut === false)
}

// ── the day's cap ──
const rails = (pass: number): ProcessVerdict => ({
  per_rule: Object.fromEntries(['P1', 'P2', 'P3', 'P4', 'P5'].map((id, i) => [id, { status: i < pass ? 'pass' : 'fail' }])),
  verdict: pass >= 4 ? 'Compliant' : 'Breach',
} as unknown as ProcessVerdict)
const ALL9 = {
  setup_in_playbook: 1, stop_in_atr_band: 1, tp1_at_2r_or_reasoned: 1, clear_area_of_interest: 1,
  two_thirds_orderflow: 1, break_of_cluster_or_bubble_entry: 1, chart_not_emotion_management: 1,
  no_mistakes_tagged: 1, stable_emotion: 1,
}
const exec = { mfe_capture: 0.1, prep_adherence: 0.9, profit_factor: 1, planned_vs_realized_rr: null, execution_parameters: 0.9, composite: 0.9, compliant_trade_count: 3, execution_parameter_breakdown: ALL9 } as unknown as ExecutionScore
let seq = 0
const trade = (inAt: string, outAt: string, exit: number, em?: string[]): TradeForStats => ({
  id: `t${++seq}`, tags_json: em ? { entry_model: em } : {}, pnl: (exit - 100) * 2, direction: 'long', entry_price: 100, exit_price: exit,
  stop_price: 90, tp1_price: 120, high_during_position: Math.max(100, exit), low_during_position: Math.min(100, exit),
  quantity: 1, symbol: 'MNQZ6.CME', entry_atr_1m: 10, exits_json: [{ qty: 1, price: exit, time: PT(outAt) }], mfe_dollars_per_leg: null,
  structure_5m_alignment: null, entry_time: PT(inAt), exit_time: PT(outAt),
})
const score = (pass: number, trades: TradeForStats[]) => {
  const day: DayForStats = { id: 'd', date: '2026-10-19', eod_pnl: null, day_type: null, day_types: null, ai_analysis_json: null, eod_ai_analysis_json: { process: rails(pass), execution: exec } as never }
  return scoreDayRollups([computeDayStats(day, trades, null)]).at(-1)!.tapescore!
}

console.log('\nthe day: 2 or more chase trades and it can\'t be green')
{
  // a 09:00 loss, then two winners inside 5 minutes of it with no trigger
  const two = [trade('08:58:00', '09:00:00', 90), trade('09:01:00', '09:03:00', 120), trade('09:04:00', '09:06:00', 120)]
  const r = score(5, two)
  check('two chase trades: the blend would be green, the day reads 69', r.uncapped > 69 && r.score === 69 && r.chaseCapped && r.chaseTrades === 2, { score: r.score, uncapped: r.uncapped, chase: r.chaseTrades })
  check('the band follows: amber', r.band === 'mid')
  const one = [trade('08:58:00', '09:00:00', 90), trade('09:01:00', '09:03:00', 120), trade('09:04:00', '09:06:00', 120, ['Break of Candle'])]
  const r1 = score(5, one)
  check('one chase trade (the other had a fresh trigger): no cap', !r1.chaseCapped && r1.chaseTrades === 1 && r1.score === r1.uncapped, { score: r1.score, chase: r1.chaseTrades })
  const rb = score(3, two)
  check('a Breach day stays at 49: the chase cap never raises it, and says it did nothing', rb.score === 49 && rb.capped && !rb.chaseCapped && rb.chaseTrades === 2, { score: rb.score, capped: rb.capped, chaseCapped: rb.chaseCapped })
  const later = [trade('08:58:00', '09:00:00', 90), trade('09:06:00', '09:08:00', 120), trade('09:09:00', '09:11:00', 120)]
  check('re-entries past 5 minutes: not chase trades, no cap', score(5, later).chaseTrades === 0)
}

console.log('\nthe trade\'s Score: "Waited after a loss"')
{
  const win = trade('09:01:00', '09:03:00', 120)
  const g0 = tradeGrade(win)
  check('not a re-entry: Entry and Exit only, as before', g0.parts.waited === null && g0.reentry === null && g0.score === 100, { score: g0.score, waited: g0.parts.waited })
  const chase = { fresh: false, gapSec: 60, afterExit: PT('09:00:00'), afterStopOut: true, triggers: [] }
  const g1 = tradeGrade(win, { reentry: chase })
  check('a chase trade: Waited 0, averaged in (Exit 100 → Score 50)', g1.parts.waited === 0 && g1.score === 50, { score: g1.score, exit: g1.exit })
  const g2 = tradeGrade(win, { reentry: { ...chase, fresh: true, triggers: ['Break of Candle'] } })
  check('a fresh trigger: Waited 100', g2.parts.waited === 100 && g2.score === 100)
  // Oct 19 10:07:59 as measured: Entry 71, Exit 100, Waited 0 → 57
  check('Entry 71 · Exit 100 · Waited 0 averages to 57', Math.round((0.71 + 1 + 0) / 3 * 100) === 57)
}

console.log(failed ? `\n${failed} FAILED` : '\nall chase-trade checks passed')
process.exit(failed ? 1 : 0)
