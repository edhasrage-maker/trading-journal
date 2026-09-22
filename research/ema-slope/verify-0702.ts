import { listNqContracts } from './scid-discovery'
import { readScidBars } from '../../src/lib/scid-reader'
import { emaSeries } from './ema'
import { atrWilder } from './atr'
import { aggregate1mTo5m } from './aggregate'

// Actual 5m 9 EMA slope / 9-20 spread / separation for the 7/2/26 morning.
const DAY = '2026-07-02'
const dir = 'D:\\SierraCharts\\Data'
const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' })
const PTDATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
const ptHM = (iso: string) => PT.format(new Date(iso))
const ptMin = (iso: string) => { const [h, m] = ptHM(iso).split(':').map(Number); return h * 60 + m }

const dayStartUtc = new Date(`${DAY}T00:00:00-07:00`).getTime()
const c = listNqContracts(dir).find(x => dayStartUtc >= x.activeStartMs && dayStartUtc < x.activeEndMs)!
const probe = readScidBars(c.path, dayStartUtc - 6 * 3600e3, dayStartUtc - 6 * 3600e3 + 3600e3, { priceDivisor: 100, bucketMs: 60_000 })
const divisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
const { bars, fileLastMs } = readScidBars(c.path, dayStartUtc - 18 * 3600e3, dayStartUtc + 21 * 3600e3, { priceDivisor: divisor, bucketMs: 60_000 })

const atr1m = atrWilder(bars, 10)
const { bars5m, ranges } = aggregate1mTo5m(bars)
const closes5m = bars5m.map(b => b.close)
const ema9 = emaSeries(closes5m, 9)
const ema20 = emaSeries(closes5m, 20)
const slope3 = bars5m.map((_, i) => i >= 3 ? (ema9[i] - ema9[i - 3]) / 3 : NaN)

console.log(`${DAY}  contract ${c.contract.trim()}  divisor=${divisor}  last data: ${fileLastMs ? ptHM(new Date(fileLastMs).toISOString()) : 'n/a'} PT\n`)
console.log('5m bar  close      9EMA      20EMA   slope3/bar  9-20sprd  sprd/ATR   sep(px-9EMA)  sep/ATR   atr1m')
for (let i = 0; i < bars5m.length; i++) {
  if (PTDATE.format(new Date(bars5m[i].ts)) !== DAY) continue
  const m = ptMin(bars5m[i].ts)
  if (m < 6 * 60 + 55 || m > 8 * 60 + 15) continue
  const atr = atr1m[ranges[i].end - 1]
  const spread = ema9[i] - ema20[i]
  const sep = closes5m[i] - ema9[i]
  console.log(
    `${ptHM(bars5m[i].ts)}   ${closes5m[i].toFixed(2)}  ${ema9[i].toFixed(2)}  ${ema20[i].toFixed(2)}` +
    `    ${slope3[i].toFixed(2).padStart(6)}    ${spread.toFixed(1).padStart(6)}    ${(spread / atr).toFixed(2).padStart(5)}` +
    `      ${sep.toFixed(1).padStart(6)}     ${(sep / atr).toFixed(2).padStart(5)}    ${atr.toFixed(1)}`,
  )
}
