/** FINAL DECISION MAP: hold-advantage (original trail: TP1->BE, confirm close
 * past TP1, 1m bar-close trail) across every dimension at once:
 * setup x side, day type, time, side, year — with both-years robustness flags. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { readScidBars } from '../src/lib/scid-reader'
const ENTRIES = 'D:/Documents/NQ_backtest/entries_full2.csv', DATA_DIR = 'D:/SierraCharts/Data', NQB = 'D:/Documents/NQ_backtest', DL = 'C:/Users/lamed/Downloads', MULT = 2
const FILES = ['NQH5.CME.scid', 'NQM5.CME.scid', 'NQU5.CME.scid', 'NQz5.CME.scid', 'NQH6.CME.scid', 'NQM6.CME.scid', 'NQU6.CME.scid', 'NQZ6.CME.scid']
function parseCSV(t: string) { const r: string[][] = []; let i = 0, f = '', row: string[] = [], q = false; while (i < t.length) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i += 2; continue } q = false; i++; continue } f += c; i++; continue } if (c === '"') { q = true; i++; continue } if (c === ',') { row.push(f); f = ''; i++; continue } if (c === '\r') { i++; continue } if (c === '\n') { row.push(f); r.push(row); row = []; f = ''; i++; continue } f += c; i++ } if (f.length || row.length) { row.push(f); r.push(row) } return r }
function load(f: string) { const r = parseCSV(readFileSync(f, 'utf8')).filter(x => x.some(c => c !== '')); const H = r[0].map(h => h.trim()); return r.slice(1).map(c => { const o: Record<string, string> = {}; H.forEach((h, i) => o[h] = (c[i] || '').trim()); return o }) }
// lookups: setup + day type, keyed date|side|round(entry)
const setupLU = new Map<string, string>(), dayLU = new Map<string, string>()
function addTZ(file: string) { try { for (const r of load(file)) { const side = (r['Side'] || '').toLowerCase(); const e = parseFloat(r['Entry Price']); if (!r['Open Date'] || !(e > 0)) continue; const k = `${r['Open Date']}|${side}|${Math.round(e)}`
  if ((r['Setups'] || '').trim()) setupLU.set(k, r['Setups'].trim()); if ((r['Day Type'] || '').trim()) dayLU.set(k, r['Day Type'].trim()) } } catch {} }
function addJ(file: string) { try { for (const r of load(file)) { const side = (r['direction'] || '').toLowerCase(); const e = parseFloat(r['entry_price']); const d = (r['date'] || '').slice(0, 10); if (!d || !(e > 0)) continue; const k = `${d}|${side}|${Math.round(e)}`
  if ((r['setups'] || '').trim()) setupLU.set(k, r['setups'].trim()); const dt = (r['day_day_type'] || r['trade_day_type'] || '').trim(); if (dt) dayLU.set(k, dt) } } catch {} }
addTZ(join(NQB, '2025_YTD_Trades.csv')); addTZ(join(NQB, 'TZ_trades_20260504103020_2025-YTD2026.csv'))
addJ(join(NQB, 'trades-2026-06-24.csv')); addJ(join(NQB, 'trades-2026-06-19 (2).csv')); addJ(join(DL, 'trades-2026-06-27.csv'))
interface Row { ms: number; date: string; hour: number; min: number; side: 'long' | 'short'; entry: number; riskPts: number | null; qty: number }
function parse(): Row[] { const L = readFileSync(ENTRIES, 'utf8').split(/\r?\n/).filter(l => l.trim()); const o: Row[] = []
  for (let i = 1; i < L.length; i++) { const c = L[i].split(','); if (+c[4] !== 1) continue; const e = +c[6], q = +c[9], s = c[5]
    if (!(e > 15000 && e < 50000) || !(q > 0) || (s !== 'long' && s !== 'short')) continue
    o.push({ ms: +c[0], date: c[1], hour: +c[2], min: +c[3], side: s, entry: e, riskPts: c[7] === '' ? null : +c[7], qty: q }) } return o }
interface Bar { ms: number; o: number; h: number; l: number; c: number }
function atrSeries(b: Bar[]) { const out = new Map<number, number>(); let a: number | null = null, pc: number | null = null; const sd: number[] = []
  for (const x of b) { const tr = pc == null ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)); if (a == null) { sd.push(tr); if (sd.length === 10) a = sd.reduce((s, v) => s + v, 0) / 10 } else a = (9 * a + tr) / 10; pc = x.c; if (a != null) out.set(x.ms, a) } return out }
const probe = new Map<string, number | null>()
function priceAt(f: string, ms: number) { const k = f + ':' + ms; if (probe.has(k)) return probe.get(k)!; let v: number | null = null; try { const b = readScidBars(join(DATA_DIR, f), ms - 120000, ms + 120000, { priceDivisor: 100, bucketMs: 60000 }).bars; if (b.length) v = b[Math.floor(b.length / 2)].close } catch {}; probe.set(k, v); return v }
function pick(ms: number, p: number) { let best: string | null = null, bd = 40; for (const f of FILES) { const x = priceAt(f, ms); if (x == null) continue; const d = Math.abs(x - p); if (d < bd) { bd = d; best = f } } return best }
function origTrail(day: Bar[], k: number, entry: number, dir: number, tp1: number) { let trailing = false
  for (let j = k; j < day.length; j++) { const b = day[j]; if (j > k && (dir > 0 ? b.l <= entry : b.h >= entry)) return entry; if (!trailing) { if (dir > 0 ? b.c > tp1 : b.c < tp1) trailing = true } else { const p = day[j - 1]; if (dir > 0 ? b.c < p.l : b.c > p.h) return b.c } } return day[day.length - 1].c }
const normSetup = (s: string) => { s = s.toLowerCase(); if (s.includes('break and retest')) return 'break&retest'; if (s.includes('supply and demand')) return 'supply&demand'; if (s.includes('lvn')) return 'lvn'; if (s.includes('initial balance fade')) return 'IBfade'; if (s.includes('mgi')) return 'mgi'; if (s.includes('discretionary')) return 'discretionary'; return 'other' }
const normDay = (s: string) => { s = s.toLowerCase()
  if (s.includes('trend')) return 'trend'
  if (s.includes('distribution')) return 'distribution'
  if (s.includes('accumulation')) return 'accumulation'
  if (s.includes('neutral')) return 'neutral'
  if (s.includes('range') || s.includes('balance')) return 'range/balance'
  if (s.includes('gbx')) return 'gbx'
  return 'other' }
interface R { yr: string; side: string; hour: number; setup: string | null; day: string | null; adv: number }
function main() {
  const rows = parse(); const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const recs: R[] = []
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!; const s0 = list[0]
    const off = Math.round((s0.ms - Date.parse(`${date}T${String(s0.hour).padStart(2, '0')}:${String(s0.min).padStart(2, '0')}:00Z`)) / 3600_000)
    const file = pick(s0.ms, s0.entry); if (!file) continue
    const warm = new Date(Date.parse(date + 'T00:00:00Z') - 4 * 86400000).toISOString().slice(0, 10)
    const closeMs = Date.parse(`${date}T13:00:00Z`) + off * 3600_000, rthStart = Date.parse(`${date}T06:30:00Z`) + off * 3600_000
    let all: Bar[]; try { all = readScidBars(join(DATA_DIR, file), Date.parse(warm + 'T00:00:00Z'), closeMs, { priceDivisor: 100, bucketMs: 60000 }).bars.map(x => ({ ms: Date.parse(x.ts), o: x.open, h: x.high, l: x.low, c: x.close })) } catch { continue }
    const atr = atrSeries(all); const day = all.filter(b => b.ms >= rthStart && b.ms < closeMs); if (!day.length) continue
    for (const r of list) {
      let eatr = 0; for (const b of all) { if (b.ms <= r.ms && atr.has(b.ms)) eatr = atr.get(b.ms)! }; if (eatr <= 0) continue
      const dir = r.side === 'long' ? 1 : -1, R2 = r.riskPts ?? eatr, tp1 = r.entry + dir * 2 * eatr, stop0 = r.entry - dir * R2
      let i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      let k = -1; for (let i = i0; i < day.length; i++) { const b = day[i]; if (dir > 0 ? b.l <= stop0 : b.h >= stop0) { k = -2; break } if (dir > 0 ? b.h >= tp1 : b.l <= tp1) { k = i; break } }
      if (k < 0) continue
      const key = `${date}|${r.side}|${Math.round(r.entry)}`
      const ex = origTrail(day, k, r.entry, dir, tp1)
      recs.push({ yr: date.slice(0, 4), side: r.side, hour: r.hour, setup: setupLU.has(key) ? normSetup(setupLU.get(key)!) : null, day: dayLU.has(key) ? normDay(dayLU.get(key)!) : null, adv: (ex - tp1) * dir * 0.4 * r.qty * MULT })
    }
  }
  const m = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString()
  const table = (name: string, fn: (r: R) => string | null, minN = 15) => {
    const g = new Map<string, R[]>(); for (const r of recs) { const k = fn(r); if (k == null) continue; (g.get(k) ?? g.set(k, []).get(k)!).push(r) }
    console.log(`\n== ${name} ==`)
    console.log(`   ${'bucket'.padEnd(24)} ${'n'.padStart(4)} ${'$/trade'.padStart(8)} ${'win%'.padStart(5)} ${'2025'.padStart(8)} ${'2026'.padStart(8)}`)
    for (const [k, a] of [...g.entries()].filter(([, a]) => a.length >= minN).sort((x, y) => y[1].reduce((s, r) => s + r.adv, 0) / y[1].length - x[1].reduce((s, r) => s + r.adv, 0) / x[1].length)) {
      const a25 = a.filter(r => r.yr === '2025'), a26 = a.filter(r => r.yr === '2026')
      const s25 = a25.reduce((s, r) => s + r.adv, 0), s26 = a26.reduce((s, r) => s + r.adv, 0)
      const both = s25 > 0 && s26 > 0 ? ' <BOTH+' : s25 < 0 && s26 < 0 ? ' <both-' : ''
      console.log(`   ${k.padEnd(24)} ${String(a.length).padStart(4)} ${m(a.reduce((s, r) => s + r.adv, 0) / a.length).padStart(8)} ${(100 * a.filter(r => r.adv > 0).length / a.length).toFixed(0).padStart(4)}% ${m(s25).padStart(8)} ${m(s26).padStart(8)}${both}`)
    }
  }
  console.log(`reached-2xATR runners: ${recs.length} | setup-tagged ${recs.filter(r => r.setup).length} | daytype-tagged ${recs.filter(r => r.day).length}`)
  table('SETUP x SIDE', r => r.setup ? `${r.setup} ${r.side}` : null)
  table('DAY TYPE', r => r.day)
  table('DAY TYPE x SIDE', r => r.day ? `${r.day} ${r.side}` : null)
  table('TIME x SIDE', r => `${r.hour < 10 ? '<10am' : '>=10am'} ${r.side}`)
  table('SETUP x TIME', r => r.setup ? `${r.setup} ${r.hour < 10 ? '<10am' : '>=10am'}` : null, 20)
}
main()
