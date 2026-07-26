/**
 * Unit tests for the style-inference engine (src/lib/trading-style.ts).
 *
 *   npx tsx scripts/test-trading-style.ts
 *
 * Plain tsx asserts, exits non-zero on first failure (same style as the other
 * test scripts). Covers the deterministic inference from synthetic trade sets.
 */
import { inferTradingStyle, type StyleTrade } from '../src/lib/trading-style.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Helper: a trade N seconds long, optional stop / legs / pnl / structure.
let base = Date.parse('2026-05-01T16:30:00Z')
const mk = (holdSec: number, o: Partial<StyleTrade> = {}): StyleTrade => {
  const entry = base; base += 3600_000
  return {
    entry_time: new Date(entry).toISOString(),
    exit_time: new Date(entry + holdSec * 1000).toISOString(),
    stop_price: null, pnl: 50, direction: 'long', entry_price: 100,
    high_during_position: 101, low_during_position: 99, structure_5m_regime: null,
    exits_json: null, ...o,
  }
}

console.log('timeframe')
check('scalp from sub-5min holds', inferTradingStyle(Array.from({ length: 30 }, () => mk(120))).timeframe.value === 'scalp')
check('intraday from ~20min holds', inferTradingStyle(Array.from({ length: 30 }, () => mk(1200))).timeframe.value === 'intraday')
check('swing from multi-hour holds', inferTradingStyle(Array.from({ length: 30 }, () => mk(7200))).timeframe.value === 'swing')
check('no times → null + not confident', (() => { const r = inferTradingStyle([mk(0, { entry_time: null, exit_time: null })]); return r.timeframe.value === null && !r.timeframe.confident })())

console.log('uses_stops')
check('always when >80% have stops', inferTradingStyle(Array.from({ length: 20 }, (_, i) => mk(120, { stop_price: i < 19 ? 98 : null }))).uses_stops.value === 'always')
check('never when <20% have stops', inferTradingStyle(Array.from({ length: 20 }, (_, i) => mk(120, { stop_price: i < 2 ? 98 : null }))).uses_stops.value === 'never')
check('sometimes in between', inferTradingStyle(Array.from({ length: 20 }, (_, i) => mk(120, { stop_price: i < 10 ? 98 : null }))).uses_stops.value === 'sometimes')

console.log('scales_out')
check('true when many multi-leg', inferTradingStyle(Array.from({ length: 20 }, () => mk(120, { exits_json: [{ qty: 2, time: 't', price: 1 }, { qty: 3, time: 't', price: 1 }] }))).scales_out.value === true)
check('false when all single-leg', inferTradingStyle(Array.from({ length: 20 }, () => mk(120, { exits_json: [{ qty: 5, time: 't', price: 1 }] }))).scales_out.value === false)
check('null when no leg data', inferTradingStyle(Array.from({ length: 20 }, () => mk(120, { exits_json: null })).map(t => t)).scales_out.value === null)

console.log('exit_style')
check('scale_out when scaling', inferTradingStyle(Array.from({ length: 20 }, () => mk(120, { exits_json: [{ qty: 2, time: 't', price: 1 }, { qty: 3, time: 't', price: 1 }] }))).exit_style.value === 'scale_out')
check('let_run on right-skewed winners', inferTradingStyle([
  ...Array.from({ length: 18 }, () => mk(120, { pnl: 50 })),
  ...Array.from({ length: 2 }, () => mk(120, { pnl: 900 })),
]).exit_style.value === 'let_run')
check('fixed_target on clustered winners', inferTradingStyle(Array.from({ length: 20 }, () => mk(120, { pnl: 100 }))).exit_style.value === 'fixed_target')

console.log('edge_style')
const longBull = (n: number) => Array.from({ length: n }, () => mk(120, { direction: 'long', structure_5m_regime: 'bull' }))
const longBear = (n: number) => Array.from({ length: n }, () => mk(120, { direction: 'long', structure_5m_regime: 'bear' }))
check('trend when mostly following', inferTradingStyle(longBull(25)).edge_style.value === 'trend')
check('mean_reversion when mostly fading', inferTradingStyle(longBear(25)).edge_style.value === 'mean_reversion')
check('null when too few structured', inferTradingStyle(longBull(5)).edge_style.value === null)

console.log(failures === 0 ? '\nAll trading-style tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
