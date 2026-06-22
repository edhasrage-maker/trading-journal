import { listNqContracts } from './scid-discovery'
import { readScidBars, makeTickReader } from '../../src/lib/scid-reader'
import { emaSeries } from './ema'
import { aggregate1mTo5m } from './aggregate'

// Reproduce Sierra's LIVE 5m 9 EMA at 8:09:12 PT on 6/16 from ticks, to compare
// against the chart's 30658.00.
const DAY = '2026-06-16'
const dir = 'D:\\SierraCharts\\Data'
const PTD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })

const dayStartUtc = new Date(`${DAY}T00:00:00-07:00`).getTime()
const c = listNqContracts(dir).find(x => dayStartUtc >= x.activeStartMs && dayStartUtc < x.activeEndMs)!
const probe = readScidBars(c.path, dayStartUtc - 6 * 3600e3, dayStartUtc - 6 * 3600e3 + 3600e3, { priceDivisor: 100, bucketMs: 60_000 })
const divisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
const { bars } = readScidBars(c.path, dayStartUtc - 18 * 3600e3, dayStartUtc + 21 * 3600e3, { priceDivisor: divisor, bucketMs: 60_000 })

const { bars5m } = aggregate1mTo5m(bars)
const ema5 = emaSeries(bars5m.map(b => b.close), 9)
// prior CLOSED 5m EMA = the bar that closed at 08:05 (the 08:00-08:05 bar)
let priorClosed = NaN
for (let k = 0; k < bars5m.length; k++) {
  if (PTD.format(new Date(bars5m[k].ts)) === DAY && new Date(bars5m[k].ts).getTime() === new Date(`${DAY}T08:00:00-07:00`).getTime()) priorClosed = ema5[k]
}

// forming 08:05-08:10 bar's running close as of 8:09:12 = last tick at/before then
const tr = makeTickReader(c.path, divisor)
const ticks = tr.read(new Date(`${DAY}T08:05:00-07:00`).getTime(), new Date(`${DAY}T08:09:13-07:00`).getTime())
tr.close()
const formingClose = ticks[ticks.length - 1]

const k = 2 / (9 + 1)
const liveEma = priorClosed + k * (formingClose - priorClosed)

console.log(`6/16  prior closed 5m 9 EMA (08:00 bar, known at 08:05): ${priorClosed.toFixed(2)}`)
console.log(`forming-bar running close at 8:09:12 (last tick): ${formingClose.toFixed(2)}`)
console.log(`=> LIVE 5m 9 EMA at 8:09:12 = ${priorClosed.toFixed(2)} + 0.2*(${formingClose.toFixed(2)} - ${priorClosed.toFixed(2)}) = ${liveEma.toFixed(2)}`)
console.log(`chart shows: 30658.00`)
