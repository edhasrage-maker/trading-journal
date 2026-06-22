import { listNqContracts } from './scid-discovery'
import { readScidBars } from '../../src/lib/scid-reader'
import { emaSeries } from './ema'
import { aggregate1mTo5m } from './aggregate'

// Inspect the 5m 9 EMA slope vs 9-20 spread around the 10:43 PT trade on 6/16.
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

// 1m ATR(10) Wilder for normalization
const atr1m: number[] = []
let prevClose = bars[0].close, rmaTR = NaN
for (let i = 0; i < bars.length; i++) {
  const tr = i === 0 ? bars[i].high - bars[i].low : Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose))
  rmaTR = i === 0 ? tr : Number.isNaN(rmaTR) ? tr : (rmaTR * 9 + tr) / 10
  atr1m.push(rmaTR)
  prevClose = bars[i].close
}
const atrAt = (hm: string) => { for (let i = 0; i < bars.length; i++) { if (PTDATE.format(new Date(bars[i].ts)) === DAY && ptHM(bars[i].ts) === hm) return atr1m[i] } return NaN }
const atr1040 = atrAt('10:40')

const { bars5m } = aggregate1mTo5m(bars)
const closes5m = bars5m.map(b => b.close)
const ema9 = emaSeries(closes5m, 9)
const ema20 = emaSeries(closes5m, 20)
const slope3 = bars5m.map((_, i) => i >= 3 ? (ema9[i] - ema9[i - 3]) / 3 : NaN)
const slope5 = bars5m.map((_, i) => i >= 5 ? (ema9[i] - ema9[i - 5]) / 5 : NaN)

console.log(`${DAY}  contract ${c.contract.trim()}  divisor=${divisor}   1m ATR(10) @10:40 = ${atr1040.toFixed(2)}\n`)
console.log('5m bar  close      9EMA      20EMA   slope3(/bar)  slope5(/bar)  9-20spread   spread/ATR')
for (let i = 0; i < bars5m.length; i++) {
  if (PTDATE.format(new Date(bars5m[i].ts)) !== DAY) continue
  const m = ptMin(bars5m[i].ts)
  if (m < 9 * 60 + 50 || m > 10 * 60 + 45) continue
  const spread = ema9[i] - ema20[i]
  console.log(
    `${ptHM(bars5m[i].ts)}   ${bars5m[i].close.toFixed(2)}  ${ema9[i].toFixed(2)}  ${ema20[i].toFixed(2)}` +
    `      ${slope3[i].toFixed(2).padStart(6)}        ${slope5[i].toFixed(2).padStart(6)}      ${spread.toFixed(2).padStart(7)}      ${(spread / atr1040).toFixed(2).padStart(5)}`,
  )
}
console.log(`\nThe 10:43 fill uses the last CLOSED 5m bar = the one closing at 10:40 (start 10:35).`)
