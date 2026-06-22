import { listNqContracts } from './scid-discovery'
import { readScidBars } from '../../src/lib/scid-reader'
import { emaSeries } from './ema'
import { aggregate1mTo5m } from './aggregate'
import { writeFileSync } from 'fs'

// Visual + text study of one RTH day: how the 1m 9 EMA interacted with price,
// and when the ALERT would fire (slope>=2 + 07:00-11:00 PT + VWAP-aligned).
// Usage: DAY=2026-06-05 npx tsx research/ema-slope/inspect-day.ts
const DAY = process.env.DAY ?? '2026-06-09'
const dir = process.env.SIERRA_DATA_DIR ?? 'D:\\SierraCharts\\Data'
const MINSLOPE = 2, EMALEN = 9, LB = 3

const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit' })
const PTDATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
const ptHM = (iso: string) => PT.format(new Date(iso))
const ptMin = (iso: string) => { const [h, m] = ptHM(iso).split(':').map(Number); return h * 60 + m }
const ptDate = (iso: string) => PTDATE.format(new Date(iso))

const dayStartUtc = new Date(`${DAY}T00:00:00-07:00`).getTime()
const fromMs = dayStartUtc - 18 * 3600 * 1000
const toMs = dayStartUtc + 21 * 3600 * 1000

const contracts = listNqContracts(dir)
const c = contracts.find(x => dayStartUtc >= x.activeStartMs && dayStartUtc < x.activeEndMs)!
const probe = readScidBars(c.path, fromMs, fromMs + 3600_000, { priceDivisor: 100, bucketMs: 60_000 })
const divisor = probe.bars.length > 0 && probe.bars[0].close < 1000 ? 1 : 100
const { bars } = readScidBars(c.path, fromMs, toMs, { priceDivisor: divisor, bucketMs: 60_000 })

const ema1 = emaSeries(bars.map(b => b.close), EMALEN)
const { bars5m, ranges } = aggregate1mTo5m(bars)
const ema5arr = emaSeries(bars5m.map(b => b.close), EMALEN)
const ema5 = new Array<number>(bars.length).fill(NaN)
for (let k = 0; k < bars5m.length; k++) for (let j = ranges[k].start; j < ranges[k].end; j++) ema5[j] = k > 0 ? ema5arr[k - 1] : NaN

// 24h VWAP anchored 15:00 PT
const vwap = new Array<number>(bars.length).fill(NaN)
{
  let pv = 0, vv = 0, anchor = ''
  for (let i = 0; i < bars.length; i++) {
    const t = new Date(bars[i].ts).getTime()
    const key = PTDATE.format(new Date(t - 15 * 3600 * 1000))
    if (key !== anchor) { pv = 0; vv = 0; anchor = key }
    const vol = (bars[i] as { volume?: number }).volume ?? 0
    const tp = (bars[i].high + bars[i].low + bars[i].close) / 3
    pv += tp * vol; vv += vol
    vwap[i] = vv > 0 ? pv / vv : NaN
  }
}

type Row = { t: number; c: number; hi: number; lo: number; e1: number; e5: number; vw: number; slope: number; alert: number }
const rows: Row[] = []
for (let i = 0; i < bars.length; i++) {
  if (ptDate(bars[i].ts) !== DAY) continue
  const m = ptMin(bars[i].ts)
  if (m < 6 * 60 + 30 || m >= 13 * 60) continue
  const slope = i >= LB ? (ema1[i] - ema1[i - LB]) / LB : NaN
  const inWin = m >= 7 * 60 && m < 11 * 60
  let alert = 0
  if (inWin && Number.isFinite(vwap[i])) {
    if (slope >= MINSLOPE && bars[i].close > ema1[i] && bars[i].close > vwap[i]) alert = 1
    else if (slope <= -MINSLOPE && bars[i].close < ema1[i] && bars[i].close < vwap[i]) alert = -1
  }
  rows.push({ t: m, c: bars[i].close, hi: bars[i].high, lo: bars[i].low, e1: ema1[i], e5: ema5[i], vw: vwap[i], slope, alert })
}

// ---- text summary ----
const opn = rows[0]?.c, cls = rows[rows.length - 1]?.c
const hi = Math.max(...rows.map(r => r.hi)), lo = Math.min(...rows.map(r => r.lo))
const litLong = rows.filter(r => r.alert === 1).length
const litShort = rows.filter(r => r.alert === -1).length
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
// lit windows (runs)
const runs: string[] = []
let runStart = -1, runDir = 0
for (let i = 0; i <= rows.length; i++) {
  const a = i < rows.length ? rows[i].alert : 0
  if (a !== runDir) {
    if (runDir !== 0) runs.push(`${runDir > 0 ? 'LONG ' : 'SHORT'} ${hm(rows[runStart].t)}-${hm(rows[i - 1].t)} (${i - runStart}m)`)
    runDir = a; runStart = i
  }
}
console.log(`\n==== ${DAY}  (${c.contract.trim()}) ====`)
console.log(`RTH open ${opn?.toFixed(2)}  high ${hi.toFixed(2)}  low ${lo.toFixed(2)}  close ${cls?.toFixed(2)}  net ${(cls - opn >= 0 ? '+' : '') + (cls - opn).toFixed(2)} pts`)
console.log(`Alert lit: ${litLong}m long, ${litShort}m short (of ${rows.length} RTH minutes; window 07:00-11:00)`)
console.log(`Lit windows:`)
for (const r of runs) console.log(`  ${r}`)

// ---- SVG ----
const W = 900, H = 460, L = 58, R = 14, T = 38, B = 26
const n = rows.length
const pmin = lo - (hi - lo) * 0.04, pmax = hi + (hi - lo) * 0.04
const X = (i: number) => L + (i / (n - 1)) * (W - L - R)
const Y = (p: number) => T + (1 - (p - pmin) / (pmax - pmin)) * (H - T - B)
const idxAtMin = (mm: number) => { let best = 0; for (let i = 0; i < n; i++) if (Math.abs(rows[i].t - mm) < Math.abs(rows[best].t - mm)) best = i; return i_clamp(best) }
function i_clamp(i: number) { return Math.max(0, Math.min(n - 1, i)) }
const path = (sel: (r: Row) => number) => {
  let d = '', pen = false
  for (let i = 0; i < n; i++) { const v = sel(rows[i]); if (!Number.isFinite(v)) { pen = false; continue } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true }
  return d.trim()
}
// colored EMA as grouped polylines (one per run of same alert state)
let emaSeg = ''
{
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && rows[j + 1].alert === rows[i].alert) j++
    const a = rows[i].alert
    const col = a === 1 ? '#16a34a' : a === -1 ? '#dc2626' : '#94a3b8'
    const w = a === 0 ? 1.6 : 3.4
    let pts = ''
    for (let k = Math.max(0, i - 1); k <= j; k++) pts += `${X(k).toFixed(0)},${Y(rows[k].e1).toFixed(1)} `
    emaSeg += `<polyline points="${pts.trim()}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
    i = j + 1
  }
}
// window shade 07:00-11:00
const wx0 = X(idxAtMin(7 * 60)), wx1 = X(idxAtMin(11 * 60))
// axis ticks
let xticks = ''
for (let mm = 6 * 60 + 30; mm <= 13 * 60; mm += 60) {
  const x = X(idxAtMin(mm))
  xticks += `<line x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${H - B}" stroke="#9ca3af" stroke-width="1" opacity="0.5"/><text x="${x.toFixed(1)}" y="${H - 8}" font-size="11" fill="#9ca3af" text-anchor="middle">${hm(mm)}</text>`
}
let yticks = ''
for (let k = 0; k <= 4; k++) { const p = pmin + (pmax - pmin) * k / 4; const y = Y(p); yticks += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#9ca3af" stroke-width="1" opacity="0.5"/><text x="${L - 6}" y="${(y + 3).toFixed(1)}" font-size="11" fill="#9ca3af" text-anchor="end">${p.toFixed(0)}</text>` }

const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="${wx0.toFixed(1)}" y="${T}" width="${(wx1 - wx0).toFixed(1)}" height="${H - T - B}" fill="#3b82f6" opacity="0.06"/>
${yticks}${xticks}
<path d="${path(r => r.vw)}" fill="none" stroke="#a855f7" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.9"/>
<path d="${path(r => r.e5)}" fill="none" stroke="#f59e0b" stroke-width="1.4" opacity="0.85"/>
<path d="${path(r => r.c)}" fill="none" stroke="#6b7280" stroke-width="1.1" opacity="0.6"/>
${emaSeg}
</svg>`
writeFileSync(`research/ema-slope/chart-${DAY}.svg`, svg)
console.log(`\nwrote research/ema-slope/chart-${DAY}.svg`)
