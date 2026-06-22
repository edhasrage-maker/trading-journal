import { listNqContracts } from './scid-discovery'
import { readScidBars } from '../../src/lib/scid-reader'
import { emaSeries } from './ema'
import { atrWilder } from './atr'

// Print 1m bars + 9 EMA + ATR + separation around a PT window, to inspect a trade.
const DAY = process.env.DAY ?? '2026-06-05'
const LO = process.env.LO ?? '08:16'
const HI = process.env.HI ?? '08:26'
const dir = 'D:\\SierraCharts\\Data'
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }

const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' })
const PTDATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
const ptHM = (iso: string) => PT.format(new Date(iso))
const ptMin = (iso: string) => { const [h, m] = ptHM(iso).split(':').map(Number); return h * 60 + m }

const dayStartUtc = new Date(`${DAY}T00:00:00-07:00`).getTime()
const c = listNqContracts(dir).find(x => dayStartUtc >= x.activeStartMs && dayStartUtc < x.activeEndMs)!
const probe = readScidBars(c.path, dayStartUtc - 18 * 3600e3, dayStartUtc - 18 * 3600e3 + 3600e3, { priceDivisor: 100, bucketMs: 60_000 })
const divisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
const { bars } = readScidBars(c.path, dayStartUtc - 18 * 3600e3, dayStartUtc + 21 * 3600e3, { priceDivisor: divisor, bucketMs: 60_000 })

const ema = emaSeries(bars.map(b => b.close), 9)
const atr = atrWilder(bars as { ts: string; open: number; high: number; low: number; close: number }[], 10)

console.log(`\n${DAY}  ${LO}-${HI} PT   (EMA=9 on 1m, ATR=10 1m)`)
console.log(`  time   open      high      low       close     EMA9      dist    ATR    sep(ATR)  pos`)
for (let i = 0; i < bars.length; i++) {
  if (PTDATE.format(new Date(bars[i].ts)) !== DAY) continue
  const m = ptMin(bars[i].ts)
  if (m < toMin(LO) || m > toMin(HI)) continue
  const dist = bars[i].close - ema[i]
  const sep = atr[i] > 0 ? Math.abs(dist) / atr[i] : 0
  const pos = dist > 0 ? 'above' : 'below'
  console.log(
    `  ${ptHM(bars[i].ts)}  ${bars[i].open.toFixed(2)} ${bars[i].high.toFixed(2)} ${bars[i].low.toFixed(2)} ` +
    `${bars[i].close.toFixed(2)} ${ema[i].toFixed(2)} ${dist.toFixed(2).padStart(7)} ${atr[i].toFixed(1).padStart(5)} ` +
    `${sep.toFixed(2).padStart(7)}   ${pos}`,
  )
}
