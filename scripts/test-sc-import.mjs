// Quick standalone test of the SC importer against the sample file.
// Run: node scripts/test-sc-import.mjs
import { readFileSync } from 'fs'
import Papa from 'papaparse'

// Inline copy of the parser logic — kept synchronized with src/lib/sc-importer.ts
// for verification only (this file is not shipped).

const SIM_RE = /^(None|Sim\d*)$/i
const isLive = a => a && !SIM_RE.test(a.trim()) && a.trim() !== ''

const MULTIPLIERS = {
  ES: 50, NQ: 20, RTY: 50, YM: 5,
  MES: 5, MNQ: 2, M2K: 5, MYM: 0.5,
  GC: 100, MGC: 10, SI: 5000, SIL: 1000,
  CL: 1000, MCL: 100, NG: 10000,
}

function symbolRoot(symbol) {
  return (symbol.split('.')[0] || '').replace(/[A-Z]\d{1,2}$/, '')
}

function parseDT(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec((raw || '').trim())
  if (!m) return null
  const [, y, mo, d, h, min, s, frac] = m
  const ms = frac ? Math.floor(Number(`0.${frac.padEnd(6, '0').slice(0, 6)}`) * 1000) : 0
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(min), Number(s), ms)
}

const round2 = n => Math.round(n * 100) / 100

const path = process.argv[2] || 'C:/Users/speci/Downloads/TradeActivityLog_2026-05-01.txt'
const text = readFileSync(path, 'utf8')

const parsed = Papa.parse(text, { delimiter: '\t', header: true, skipEmptyLines: true })

const fills = []
let skippedFiltered = 0, skippedNonFill = 0, skippedZeroQty = 0
const errs = []

for (let i = 0; i < parsed.data.length; i++) {
  const r = parsed.data[i]
  if (!r || !r.ActivityType) continue
  if (r.ActivityType !== 'Fills') { skippedNonFill++; continue }
  if (!isLive(r.TradeAccount)) { skippedFiltered++; continue }
  const ts = parseDT(r.DateTime)
  if (!ts) { errs.push(`Row ${i+2}: bad DateTime`); continue }
  const qty = Number(r.Quantity), fp = Number(r.FillPrice)
  if (!Number.isFinite(qty) || qty <= 0) { skippedZeroQty++; continue }
  if (!Number.isFinite(fp)) { errs.push(`Row ${i+2}: bad FillPrice`); continue }
  if (r.BuySell !== 'Buy' && r.BuySell !== 'Sell') { errs.push(`Row ${i+2}: bad BuySell`); continue }
  fills.push({ ts, symbol: r.Symbol, account: r.TradeAccount.trim(), qty, side: r.BuySell, fillPrice: fp, ioid: r.InternalOrderID, rowIndex: i+2 })
}

fills.sort((a, b) => (a.ts - b.ts) || (a.rowIndex - b.rowIndex))

const open = new Map()
const completed = []
for (const f of fills) {
  const key = `${f.account}|${f.symbol}`
  const sign = f.side === 'Buy' ? 1 : -1
  let g = open.get(key)
  if (!g) {
    g = { account: f.account, symbol: f.symbol, direction: sign > 0 ? 'long' : 'short', fills: [], firstOpenIOID: f.ioid, peak: 0, pos: 0 }
    open.set(key, g)
  }
  g.fills.push(f)
  g.pos += sign * f.qty
  g.peak = Math.max(g.peak, Math.abs(g.pos))
  if (g.pos === 0) { completed.push(g); open.delete(key) }
}

for (const g of open.values()) errs.push(`Unclosed: ${g.account} ${g.symbol} pos=${g.pos}`)

const rows = []
for (const g of completed) {
  const isLongTrade = g.direction === 'long'
  const opens = g.fills.filter(f => isLongTrade ? f.side === 'Buy' : f.side === 'Sell')
  const closes = g.fills.filter(f => isLongTrade ? f.side === 'Sell' : f.side === 'Buy')
  const totalO = opens.reduce((s, f) => s + f.qty, 0)
  const totalC = closes.reduce((s, f) => s + f.qty, 0)
  const oVal = opens.reduce((s, f) => s + f.qty * f.fillPrice, 0)
  const cVal = closes.reduce((s, f) => s + f.qty * f.fillPrice, 0)
  const eAvg = oVal / totalO, xAvg = cVal / totalC
  const pts = isLongTrade ? xAvg - eAvg : eAvg - xAvg
  const mult = MULTIPLIERS[symbolRoot(g.symbol)] ?? 1
  const pnl = pts * Math.min(totalO, totalC) * mult
  rows.push({
    sierra_trade_id: `${g.account}:${g.firstOpenIOID}`,
    symbol: g.symbol,
    direction: g.direction,
    entry_time: opens[0].ts.toISOString(),
    entry_price: round2(eAvg),
    exit_time: closes[closes.length - 1].ts.toISOString(),
    exit_price: round2(xAvg),
    quantity: g.peak,
    pnl: round2(pnl),
  })
}

console.log('=== Parse summary ===')
console.log('Fills parsed:', fills.length)
console.log('Trades emitted:', rows.length)
console.log('Skipped (non-Fills):', skippedNonFill)
console.log('Skipped (sim/none accounts):', skippedFiltered)
console.log('Skipped (zero qty):', skippedZeroQty)
console.log('Errors:', errs.length ? errs : '(none)')
console.log()
console.log('=== Trades ===')
for (const r of rows) console.log(JSON.stringify(r, null, 2))
