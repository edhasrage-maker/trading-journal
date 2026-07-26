/**
 * Unit tests for the tilt-cascade deep dive (src/lib/deep-dive/tilt-cascade.ts).
 *   npx tsx scripts/test-tilt-cascade.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import { analyzeTiltCascade, type TiltTrade } from '../src/lib/deep-dive/tilt-cascade.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Build N days each following a per-day pattern of [pnl, qty] trades.
const build = (days: number, pattern: [number, number][]): TiltTrade[] => {
  const out: TiltTrade[] = []
  for (let d = 0; d < days; d++) {
    const day = `2026-05-${String((d % 27) + 1).padStart(2, '0')}`
    pattern.forEach(([pnl, qty], i) => {
      out.push({ day, entryTime: `${day}T${String(9 + i).padStart(2, '0')}:00:00Z`, pnl, quantity: qty })
    })
  }
  return out
}

console.log('tilt-cascade')

// Clear cascade: after 2 losses WR collapses to 0 and size jumps 2→5.
// Per day: WIN(2), LOSS(2) [both streak0], LOSS(2) [streak1], LOSS(5), LOSS(5) [streak2+].
const cascade = analyzeTiltCascade(build(15, [[100, 2], [-100, 2], [-100, 2], [-120, 5], [-120, 5]]))
check('detects a real cascade', cascade !== null)
check('headline mentions the win-rate fall', !!cascade && /win rate falls/.test(cascade.headline))
check('tilt zone is the ≥2-loss bucket', !!cascade && cascade.segments[2].label === 'After 2+ losses' && cascade.segments[2].value === 0)
check('flags the size-up in detail', !!cascade && cascade.detail.some(d => /SIZE UP/.test(d)))
check('proposes a cooldown with positive modeled impact', !!cascade && cascade.test!.impactUsd > 0)
check('impact = skipped tilt-zone loss (15 days × 2 × $120)', !!cascade && cascade.test!.impactUsd === 3600)

// Stable trader: same WR after losses, flat size → no cascade (null).
const stable = analyzeTiltCascade(build(15, [[100, 2], [-100, 2], [100, 2], [-100, 2], [100, 2]]))
check('no cascade for a stable trader', stable === null)

// Too few trades → null.
check('null under the sample floor', analyzeTiltCascade(build(2, [[-100, 5], [-100, 5]])) === null)

// Cascade in WR but tilt zone NOT negative → not surfaced (don't nag).
const wrDropButGreen = analyzeTiltCascade(build(15, [[100, 2], [-100, 2], [-100, 2], [300, 5], [-50, 5]]))
check('needs the tilt zone to actually bleed', wrDropButGreen === null)

console.log(failures === 0 ? '\nAll tilt-cascade tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
