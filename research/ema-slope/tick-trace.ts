import { makeTickReader } from '../../src/lib/scid-reader'
import { listNqContracts } from './scid-discovery'

// For specific fill bars, compare the OHLC verdict (optimistic) with the true
// tick-ordered verdict, and show WHY they differ.
const DAY = '2026-06-05'
// Same-bar "wins" from the optimistic 06/05 trade list (all SHORT). entry=limit@EMA.
const TRADES = [
  { hm: '07:02', side: 'short' as const, entry: 29818.87, stop: 29852.38, target: 29785.36 },
  { hm: '08:05', side: 'short' as const, entry: 29821.31, stop: 29847.57, target: 29795.05 },
  { hm: '08:23', side: 'short' as const, entry: 29736.94, stop: 29760.93, target: 29712.96 },
  { hm: '08:43', side: 'short' as const, entry: 29660.95, stop: 29685.86, target: 29636.03 }, // multi-bar (control)
]

const dir = 'D:\\SierraCharts\\Data'
const dayStartUtc = new Date(`${DAY}T00:00:00-07:00`).getTime()
const c = listNqContracts(dir).find(x => dayStartUtc >= x.activeStartMs && dayStartUtc < x.activeEndMs)!
// detect divisor
const probe = makeTickReader(c.path, 100)
const sample = probe.read(dayStartUtc + 14.5 * 3600e3, dayStartUtc + 14.5 * 3600e3 + 60_000)
probe.close()
const divisor = sample.length > 0 && sample[0] < 1000 ? 1 : 100
const tr = makeTickReader(c.path, divisor)

for (const t of TRADES) {
  const [h, m] = t.hm.split(':').map(Number)
  const barMs = new Date(`${DAY}T${t.hm}:00-07:00`).getTime()
  const ticks = tr.read(barMs, barMs + 60_000)
  // fill tick: first tick reaching the limit (short → price rises to entry)
  let f = -1
  for (let i = 0; i < ticks.length; i++) { if (ticks[i] >= t.entry) { f = i; break } }
  // did the target get visited BEFORE the fill?
  let preFillMin = Infinity
  for (let i = 0; i < (f < 0 ? ticks.length : f); i++) preFillMin = Math.min(preFillMin, ticks[i])
  const targetHitPreFill = preFillMin <= t.target
  // tick verdict from the fill onward
  let tickVerdict = 'open'
  for (let i = Math.max(0, f); i < ticks.length; i++) {
    if (ticks[i] >= t.stop) { tickVerdict = 'STOP (−1R)'; break }
    if (ticks[i] <= t.target) { tickVerdict = 'target (+1R)'; break }
  }
  const last = ticks[ticks.length - 1]
  console.log(`\n${t.hm} SHORT  entry@${t.entry}  target ${t.target}  stop ${t.stop}  (${ticks.length} ticks)`)
  console.log(`  OHLC says: bar low ${Math.min(...ticks).toFixed(2)} ≤ target → +1R WIN`)
  console.log(`  fill tick: #${f} of ${ticks.length}  (price first reached ${t.entry} at tick ${f})`)
  console.log(`  before the fill, price had already dropped to ${preFillMin === Infinity ? 'n/a' : preFillMin.toFixed(2)}  → target touched pre-fill? ${targetHitPreFill}`)
  console.log(`  TRUE (tick order): ${tickVerdict}${tickVerdict === 'open' ? ` (bar ended @ ${last.toFixed(2)}, target not reached after fill)` : ''}`)
}
tr.close()
