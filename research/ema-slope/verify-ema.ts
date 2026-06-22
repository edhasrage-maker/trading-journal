import { listNqContracts } from './scid-discovery'
import { readScidBars } from '../../src/lib/scid-reader'
import { emaSeries } from './ema'
import { aggregate1mTo5m } from './aggregate'

// Verify the 9 EMA value used by the 08:10 trade on 6/16 was computable purely
// from bars that had already CLOSED before the entry (no lookahead).
const DAY = '2026-06-16'
const dir = 'D:\\SierraCharts\\Data'
const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' })
const PTDATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
const ptHM = (iso: string) => PT.format(new Date(iso))
const ptMin = (iso: string) => { const [h, m] = ptHM(iso).split(':').map(Number); return h * 60 + m }

const dayStartUtc = new Date(`${DAY}T00:00:00-07:00`).getTime()
const c = listNqContracts(dir).find(x => dayStartUtc >= x.activeStartMs && dayStartUtc < x.activeEndMs)!
const probe = readScidBars(c.path, dayStartUtc - 6 * 3600e3, dayStartUtc - 6 * 3600e3 + 3600e3, { priceDivisor: 100, bucketMs: 60_000 })
const divisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
const { bars } = readScidBars(c.path, dayStartUtc - 18 * 3600e3, dayStartUtc + 21 * 3600e3, { priceDivisor: divisor, bucketMs: 60_000 })

const ema1 = emaSeries(bars.map(b => b.close), 9)
const { bars5m, ranges } = aggregate1mTo5m(bars)
const ema5 = emaSeries(bars5m.map(b => b.close), 9)

console.log(`${DAY}  contract ${c.contract.trim()}  divisor=${divisor}\n`)
console.log('--- 1-minute bars + 1m 9 EMA (08:06-08:12 PT) ---')
console.log('  time   close      1m-EMA9')
for (let i = 0; i < bars.length; i++) {
  if (PTDATE.format(new Date(bars[i].ts)) !== DAY) continue
  const m = ptMin(bars[i].ts)
  if (m < 8 * 60 + 6 || m > 8 * 60 + 12) continue
  console.log(`  ${ptHM(bars[i].ts)}  ${bars[i].close.toFixed(2)}  ${ema1[i].toFixed(2)}`)
}

console.log('\n--- 5-minute bars + 5m 9 EMA (07:50-08:15 PT) ---')
console.log('  bar(start)  covers        closes-at  5m-close   5m-EMA9   <- known at close')
for (let k = 0; k < bars5m.length; k++) {
  if (PTDATE.format(new Date(bars5m[k].ts)) !== DAY) continue
  const m = ptMin(bars5m[k].ts)
  if (m < 7 * 60 + 50 || m > 8 * 60 + 15) continue
  const start = ptHM(bars5m[k].ts)
  const endM = m + 5
  const closesAt = `${String(Math.floor(endM / 60)).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`
  console.log(`  ${start}       ${start}-${closesAt}   ${closesAt}      ${bars5m[k].close.toFixed(2)}   ${ema5[k].toFixed(2)}`)
}
