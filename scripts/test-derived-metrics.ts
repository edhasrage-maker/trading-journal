/**
 * Bounds / invariant tests for the derived-metric helpers in src/lib/analytics.
 *
 *   npm test           # (wired to this file)
 *   npx tsx scripts/test-derived-metrics.ts
 *
 * No test framework is installed — this is a plain tsx script that asserts the
 * mathematical invariants each helper must uphold and exits non-zero on the
 * first failure, so a regression fails loudly. Covers capture, heat, R,
 * expectancy, profit factor, and the render-time capture guard (formatCapturePct).
 *
 * The invariant that motivated Pt 20 / Ticket 1: realized PnL can never exceed
 * the peak-favorable-$ ceiling, so a capture/conversion ratio > 100% (+ε) is a
 * data mismatch and must never render as a raw number.
 */
import {
  captureRatio,
  captureComponents,
  avgCaptureRatio,
  maeHeatRatio,
  rMultiple,
  computeStats,
  formatCapturePct,
  CAPTURE_DISPLAY_EPSILON,
  type TradeWithExcursion,
  type TradeLike,
} from '../src/lib/analytics'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// ── Trade fixtures (MNQ, $2/pt) ──────────────────────────────────────────────
// A trade only needs the fields each helper reads; extras are harmless. Cast
// through the exact helper param types.
type T = TradeWithExcursion
const base = { symbol: 'MNQ', direction: 'long' as const, trading_day_id: 'd1' }

// Consistent winner: entry 100, peak 130 (MFE 30pt → $120 on 2 lots), booked
// $80 (capture 0.667). Stop 90 (risk 10pt → $40 → R = +2.0). Low 98 (MAE 2pt →
// heat 0.2).
const winner: T = { ...base, entry_price: 100, stop_price: 90, quantity: 2, pnl: 80, high_during_position: 130, low_during_position: 98 } as T

// Give-back loser: went +30pt favorable then closed −$60. Capture floors at 0.
const giveBack: T = { ...base, entry_price: 100, stop_price: 90, quantity: 2, pnl: -60, high_during_position: 130, low_during_position: 88 } as T

// CORRUPT winner: peak only +10pt ($40 ceiling) yet booked $100 → capture 2.5.
// The helper leaves this unclamped (surfaces the bug); the render guard hides it.
const corrupt: T = { ...base, entry_price: 100, stop_price: 95, quantity: 2, pnl: 100, high_during_position: 110, low_during_position: 100 } as T

// ── capture ──────────────────────────────────────────────────────────────────
console.log('capture:')
{
  const r = captureRatio(winner)
  check('winner capture in [0,1]', r != null && r >= 0 && r <= 1, `got ${r}`)
  check('winner capture ≈ 0.667', r != null && Math.abs(r - 80 / 120) < 1e-9, `got ${r}`)

  const g = captureRatio(giveBack)
  check('give-back capture floored at 0', g === 0, `got ${g}`)

  const c = captureRatio(corrupt)
  check('corrupt capture is >1 (bug surfaces, not silently clamped)', c != null && c > 1, `got ${c}`)

  const comp = captureComponents(winner)
  check('captureComponents pnl ≤ mfeDollars for consistent winner', comp != null && comp.pnl <= comp.mfeDollars, JSON.stringify(comp))
}

// ── formatCapturePct render guard ─────────────────────────────────────────────
console.log('formatCapturePct (render guard):')
eq('0.5 → "50%"', formatCapturePct(0.5), '50%')
eq('0 → "0%"', formatCapturePct(0), '0%')
eq('1 → "100%"', formatCapturePct(1), '100%')
eq('1+ε clamps to "100%"', formatCapturePct(1 + CAPTURE_DISPLAY_EPSILON), '100%')
eq('1.16 (116%) → null', formatCapturePct(1.16), null)
eq('2.18 (218%) → null', formatCapturePct(2.18), null)
eq('negative → null', formatCapturePct(-0.1), null)
eq('null → null', formatCapturePct(null), null)
eq('undefined → null', formatCapturePct(undefined), null)
eq('Infinity → null', formatCapturePct(Infinity), null)
eq('NaN → null', formatCapturePct(NaN), null)
eq('corrupt trade ratio → null (guard catches it)', formatCapturePct(captureRatio(corrupt)), null)

// ── aggregate capture ─────────────────────────────────────────────────────────
console.log('avgCaptureRatio:')
{
  const clean = avgCaptureRatio([winner, giveBack])
  check('clean aggregate in [0,1]', clean.avg != null && clean.avg >= 0 && clean.avg <= 1, `got ${clean.avg}`)
  check('clean aggregate passes render guard', formatCapturePct(clean.avg) != null, `got ${clean.avg}`)

  const dirty = avgCaptureRatio([corrupt])
  check('aggregate built from corrupt trade is caught by render guard', formatCapturePct(dirty.avg) == null, `got ${dirty.avg}`)
}

// ── MAE heat ──────────────────────────────────────────────────────────────────
console.log('maeHeatRatio:')
{
  const h = maeHeatRatio(winner)
  check('heat ≥ 0', h != null && h >= 0, `got ${h}`)
  check('winner heat ≈ 0.2', h != null && Math.abs(h - 0.2) < 1e-9, `got ${h}`)
  // Heat legitimately exceeds 1.0 (price ran past the stop) — must NOT be bounded.
  const blew: T = { ...base, entry_price: 100, stop_price: 95, quantity: 2, pnl: -50, high_during_position: 101, low_during_position: 80 } as T
  const hb = maeHeatRatio(blew)
  check('heat may exceed 1.0 (past-stop is real, not clamped)', hb != null && hb > 1, `got ${hb}`)
}

// ── R multiple ────────────────────────────────────────────────────────────────
console.log('rMultiple:')
{
  const rw = rMultiple(winner as TradeLike)
  check('winner R positive', rw != null && rw > 0, `got ${rw}`)
  check('winner R ≈ +2.0', rw != null && Math.abs(rw - 2) < 1e-9, `got ${rw}`)
  const rl = rMultiple(giveBack as TradeLike)
  check('loser R negative', rl != null && rl < 0, `got ${rl}`)
  check('R sign matches pnl sign', (rw ?? 0) > 0 === ((winner.pnl ?? 0) > 0) && (rl ?? 0) < 0 === ((giveBack.pnl ?? 0) < 0))
}

// ── expectancy + profit factor (computeStats) ─────────────────────────────────
console.log('computeStats (expectancy / profit factor):')
{
  const stats = computeStats([winner, giveBack] as unknown as TradeLike[])
  // 1 win (+80), 1 loss (−60): PF = 80/60, expectancy = mean pnl = 10.
  check('profit_factor finite & = 80/60', Math.abs((stats.profit_factor as number) - 80 / 60) < 1e-9, `got ${stats.profit_factor}`)
  check('expectancy = mean pnl (10)', Math.abs(stats.expectancy - 10) < 1e-9, `got ${stats.expectancy}`)
  check('win_rate = 0.5', Math.abs(stats.win_rate - 0.5) < 1e-9, `got ${stats.win_rate}`)
  check('avg_capture (mixed, clean) passes render guard', formatCapturePct(stats.avg_capture) != null, `got ${stats.avg_capture}`)

  const winnersOnly = computeStats([winner] as unknown as TradeLike[])
  check('profit_factor = Infinity when no losers', winnersOnly.profit_factor === Infinity, `got ${winnersOnly.profit_factor}`)

  const empty = computeStats([])
  check('empty set: expectancy 0, PF 0', empty.expectancy === 0 && empty.profit_factor === 0)
}

// ── result ────────────────────────────────────────────────────────────────────
console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('All derived-metric bounds tests passed.')
