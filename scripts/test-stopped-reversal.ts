/**
 * Unit tests for the stopped-then-reversed deep dive
 * (src/lib/deep-dive/stopped-reversal.ts).
 *   npx tsx scripts/test-stopped-reversal.ts
 * Plain tsx asserts; exits non-zero on first failure.
 */
import { analyzeStoppedReversal, type StopReversalTrade, type PostExitPath } from '../src/lib/deep-dive/stopped-reversal.ts'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// Canonical stopped-out long: MNQ ($2/pt), 1 lot, entry 100, stopped at 95 at the
// trade's own low ⇒ riskPts 5, pnl −$10, ATR 10 (so the loss clears the noise
// floor of 0.25×ATR = 2.5 pts). Widenings modelled: 1.5 / 3 / 5 pts.
const path = (o: Partial<PostExitPath> = {}): PostExitPath => ({
  reachedEntry: false,
  adverseBeforeEntryPts: null,
  reachedTarget: false,
  adverseBeforeTargetPts: null,
  maxAdversePts: 0,
  maxFavorablePts: 0,
  horizonMin: 30,
  ...o,
})
const stop = (o: Partial<StopReversalTrade> = {}, i = 0): StopReversalTrade => ({
  id: `s${i}`,
  direction: 'long',
  entryPrice: 100,
  exitPrice: 95,
  quantity: 1,
  pnl: -10,
  symbol: 'MNQM6.CME',
  highDuringPosition: 101,
  lowDuringPosition: 95,
  atrPts: 10,
  path: path(),
  ...o,
})
const many = (o: Partial<StopReversalTrade>, n = 20) => Array.from({ length: n }, (_, i) => stop(o, i))

/** Snapped straight back to a full 1R with almost no further heat first. */
const cleanReversal = path({
  reachedEntry: true, adverseBeforeEntryPts: 0.5,
  reachedTarget: true, adverseBeforeTargetPts: 0.5,
  maxAdversePts: 0.5, maxFavorablePts: 12,
})
/** Just kept going against them. */
const keptRunning = path({ maxAdversePts: 8, maxFavorablePts: 0 })

console.log('stopped-reversal')

const reversed = analyzeStoppedReversal(many({ path: cleanReversal }))
check('detects the stopped-then-reversed pattern', reversed !== null)
check('headline quotes the reversal rate + horizon', !!reversed && /100% of your stop-outs reversed back through your entry within 30 minutes/.test(reversed.headline))
check('picks the SMALLEST width that wins ties', !!reversed?.test && /0\.15×ATR/.test(reversed.test.rule))
check('impact = 20 × ($10 target + $10 loss avoided) = $400', reversed?.test?.impactUsd === 400)
check('basis accounts for every trade', !!reversed?.test && /20 reached \+1R before the wider stop/.test(reversed.test.basis))
check('reframes the stop as inside the noise band', !!reversed?.reframe && /noise band/.test(reversed.reframe))
check('baseline segment carries the current cost', reversed?.segments[0]?.pnl === -200)
check('one segment per width + baseline', reversed?.segments.length === 4)

const keptGoing = analyzeStoppedReversal(many({ path: keptRunning }))
check('reassures when stops are placed right', !!keptGoing && /placed about right/.test(keptGoing.headline))
check('no test when widening loses money', keptGoing?.test === undefined)
check('reassurance never leads the opener', keptGoing?.severity === 0.08)
check('points at the entry instead of the stop', !!keptGoing?.reframe && /at the entry, not the stop/.test(keptGoing.reframe))

// PATH ORDER IS THE WHOLE POINT: this one DID reach 1R, but only after 4 pts of
// further heat — so 1.5- and 3-pt widenings are stopped anyway and only the
// 5-pt (0.50×ATR) widening actually captures the recovery.
const heatFirst = analyzeStoppedReversal(many({
  path: path({
    reachedEntry: true, adverseBeforeEntryPts: 4,
    reachedTarget: true, adverseBeforeTargetPts: 4,
    maxAdversePts: 4, maxFavorablePts: 12,
  }),
}))
check('a recovery that came AFTER more heat needs the wider stop', !!heatFirst?.test && /0\.50×ATR/.test(heatFirst.test.rule))
check('narrower widenings are scored as stopped anyway', heatFirst?.segments[1]?.extra?.stoppedAnyway === 20)
check('impact still $400 at the width that survives', heatFirst?.test?.impactUsd === 400)

// Mixed: 12 clean reversals, 8 that keep running.
const mixed = analyzeStoppedReversal([...many({ path: cleanReversal }, 12), ...many({ path: keptRunning }, 8)])
// 12 × +$20, 8 × −(1.5 pts × $2) = −$3 each ⇒ 240 − 24 = 216
check('nets winners against deeper losers', mixed?.test?.impactUsd === 216)
check('reversal rate is 60%', !!mixed && /60% of your stop-outs/.test(mixed.headline))
check('segment extras split the outcomes', mixed?.segments[1]?.extra?.toTarget === 12 && mixed?.segments[1]?.extra?.stoppedAnyway === 8)

// Back to entry but never a full 1R ⇒ scored flat, recovering the loss only.
const scratch = analyzeStoppedReversal(many({
  path: path({ reachedEntry: true, adverseBeforeEntryPts: 0.5, maxAdversePts: 0.5, maxFavorablePts: 7 }),
}))
check('a snap-back to entry is scored flat, not a win', scratch?.test?.impactUsd === 200)
check('and lands in the breakeven bucket', scratch?.segments[1]?.extra?.breakeven === 20)

// Never recovered, never reached the wider stop either ⇒ unresolved, scored as
// the deeper loss (conservative), so widening looks bad.
const unresolved = analyzeStoppedReversal(many({ path: path({ maxAdversePts: 1, maxFavorablePts: 1 }) }))
check('unresolved trades are scored against the wider stop', unresolved?.test === undefined)
check('and are counted separately from real stop-outs', unresolved?.segments[1]?.extra?.unresolved === 20)

// ── Exclusions ─────────────────────────────────────────────────────────────
check('excludes losses that did not exit at their extreme',
  analyzeStoppedReversal(many({ lowDuringPosition: 90, path: cleanReversal })) === null)
check('excludes micro-losses below 0.25×ATR',
  analyzeStoppedReversal(many({ exitPrice: 99, pnl: -2, lowDuringPosition: 99, path: cleanReversal })) === null)
check('excludes winners', analyzeStoppedReversal(many({ pnl: 40, exitPrice: 120, lowDuringPosition: 99.5, path: cleanReversal })) === null)
check('excludes rows with no measured path', analyzeStoppedReversal(many({ path: null })) === null)
check('excludes rows without ATR', analyzeStoppedReversal(many({ atrPts: null, path: cleanReversal })) === null)
check('null under the stop-out floor', analyzeStoppedReversal(many({ path: cleanReversal }, 11)) === null)

// Shorts: entry 100, stopped at 105 at the trade's own high.
const shorts = analyzeStoppedReversal(many({
  direction: 'short', exitPrice: 105, highDuringPosition: 105, lowDuringPosition: 99, path: cleanReversal,
}))
check('mirrors correctly for shorts', shorts?.test?.impactUsd === 400)

// A logged stop_price confirms the stop-out even when the extreme test misses
// (exited at the stop, then price wicked further before the fill was recorded).
const viaStopPrice = analyzeStoppedReversal(many({ stopPrice: 95, lowDuringPosition: 90, path: cleanReversal }))
check('stop_price confirms a stop-out the extreme test misses', viaStopPrice?.test?.impactUsd === 400)

// Size scales the dollars: 4 lots ⇒ 4× the impact.
const sized = analyzeStoppedReversal(many({ quantity: 4, pnl: -40, path: cleanReversal }))
check('impact scales with contracts', sized?.test?.impactUsd === 1600)

// Horizon is reported from the measurement, not hardcoded.
const shortHorizon = analyzeStoppedReversal(many({ path: { ...cleanReversal, horizonMin: 15 } }))
check('quotes the horizon it was actually given', !!shortHorizon && /within 15 minutes/.test(shortHorizon.headline))

console.log(failures === 0 ? '\nAll stopped-reversal tests passed.' : `\n${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
