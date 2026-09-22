/** HTF-context conditioning of the TP2 hold (manager = BE stop + 4xATR target).
 * Dimensions (all computable at entry, no tags):
 *   - absolute 1m ATR band (<12 / 12-16 / 16-20 / >=20 pt)
 *   - position vs prior-day RTH range, direction-aware (breakout / inside / against)
 *   - overnight gap vs prior RTH close, direction-aware (in ATR)
 *   - day drift: entry vs today's RTH open, with/against trade direction
 *   - VWAP side: trade direction with/against session VWAP
 *   - move spent: RTH range consumed before entry, in ATR (<3 fresh / 3-6 / >6 extended)
 * Metric: hold-advantage $ = (runnerExit - TP1) * dir * 0.4 * qty * $2/pt. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { readScidBars } from '../src/lib/scid-reader'
const ENTRIES = 'D:/Documents/NQ_backtest/entries_full2.csv', DATA_DIR = 'D:/SierraCharts/Data', MULT = 2
const FILES = ['NQH5.CME.scid', 'NQM5.CME.scid', 'NQU5.CME.scid', 'NQz5.CME.scid', 'NQH6.CME.scid', 'NQM6.CME.scid', 'NQU6.CME.scid', 'NQZ6.CME.scid']
interface Row { ms: number; date: string; hour: number; min: number; side: 'long' | 'short'; entry: number; riskPts: number | null; qty: number }
function parse(): Row[] { const L = readFileSync(ENTRIES, 'utf8').split(/\r?\n/).filter(l => l.trim()); const o: Row[] = []
  for (let i = 1; i < L.length; i++) { const c = L[i].split(','); if (+c[4] !== 1) continue; const e = +c[6], q = +c[9], s = c[5]
    if (!(e > 15000 && e < 50000) || !(q > 0) || (s !== 'long' && s !== 'short')) continue
    o.push({ ms: +c[0], date: c[1], hour: +c[2], min: +c[3], side: s, entry: e, riskPts: c[7] === '' ? null : +c[7], qty: q }) } return o }
interface Bar { ms: number; o: number; h: number; l: number; c: number; v: number }
function atrSeries(b: Bar[]) { const out = new Map<number, number>(); let a: number | null = null, pc: number | null = null; const sd: number[] = []
  for (const x of b) { const tr = pc == null ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)); if (a == null) { sd.push(tr); if (sd.length === 10) a = sd.reduce((s, v) => s + v, 0) / 10 } else a = (9 * a + tr) / 10; pc = x.c; if (a != null) out.set(x.ms, a) } return out }
const probe = new Map<string, number | null>()
function priceAt(f: string, ms: number) { const k = f + ':' + ms; if (probe.has(k)) return probe.get(k)!; let v: number | null = null; try { const b = readScidBars(join(DATA_DIR, f), ms - 120000, ms + 120000, { priceDivisor: 100, bucketMs: 60000 }).bars; if (b.length) v = b[Math.floor(b.length / 2)].close } catch {}; probe.set(k, v); return v }
function pick(ms: number, p: number) { let best: string | null = null, bd = 40; for (const f of FILES) { const x = priceAt(f, ms); if (x == null) continue; const d = Math.abs(x - p); if (d < bd) { bd = d; best = f } } return best }
function beTarget(day: Bar[], k: number, entry: number, dir: number, target: number) {
  for (let j = k + 1; j < day.length; j++) { const b = day[j]
    if (dir > 0 ? b.h >= target : b.l <= target) return target
    if (dir > 0 ? b.l <= entry : b.h >= entry) return entry }
  return day[day.length - 1].c }
interface R { yr: string; adv: number; atrBand: string; pdPos: string; gap: string; drift: string; vwap: string; spent: string }
function main() {
  const rows = parse(); const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const recs: R[] = []
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!; const s0 = list[0]
    const off = Math.round((s0.ms - Date.parse(`${date}T${String(s0.hour).padStart(2, '0')}:${String(s0.min).padStart(2, '0')}:00Z`)) / 3600_000)
    const file = pick(s0.ms, s0.entry); if (!file) continue
    const warm = new Date(Date.parse(date + 'T00:00:00Z') - 5 * 86400000).toISOString().slice(0, 10)
    const closeMs = Date.parse(`${date}T13:00:00Z`) + off * 3600_000, rthStart = Date.parse(`${date}T06:30:00Z`) + off * 3600_000
    let all: Bar[]; try { all = readScidBars(join(DATA_DIR, file), Date.parse(warm + 'T00:00:00Z'), closeMs, { priceDivisor: 100, bucketMs: 60000 }).bars.map(x => ({ ms: Date.parse(x.ts), o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume })) } catch { continue }
    const atr = atrSeries(all); const day = all.filter(b => b.ms >= rthStart && b.ms < closeMs); if (!day.length) continue
    // prior-day RTH high/low/close (search back up to 4 days)
    let PDH = NaN, PDL = NaN, PDC = NaN
    for (let d = 1; d <= 4; d++) { const ps = rthStart - d * 86400000, pe = ps + 6.5 * 3600_000; const pb = all.filter(b => b.ms >= ps && b.ms < pe)
      if (pb.length) { PDH = Math.max(...pb.map(b => b.h)); PDL = Math.min(...pb.map(b => b.l)); PDC = pb[pb.length - 1].c; break } }
    const rthOpen = day[0].o
    for (const r of list) {
      let eatr = 0; for (const b of all) { if (b.ms <= r.ms && atr.has(b.ms)) eatr = atr.get(b.ms)! }; if (eatr <= 0) continue
      const dir = r.side === 'long' ? 1 : -1, R2 = r.riskPts ?? eatr, tp1 = r.entry + dir * 2 * eatr, stop0 = r.entry - dir * R2
      let i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      let k = -1; for (let i = i0; i < day.length; i++) { const b = day[i]; if (dir > 0 ? b.l <= stop0 : b.h >= stop0) { k = -2; break } if (dir > 0 ? b.h >= tp1 : b.l <= tp1) { k = i; break } }
      if (k < 0) continue
      const exit = beTarget(day, k, r.entry, dir, r.entry + dir * 4 * eatr)
      const adv = (exit - tp1) * dir * 0.4 * r.qty * MULT
      // features at entry
      const atrBand = eatr < 12 ? '<12pt' : eatr < 16 ? '12-16pt' : eatr < 20 ? '16-20pt' : '>=20pt'
      let pdPos = 'no-pd'
      if (isFinite(PDH)) { const above = r.entry > PDH, below = r.entry < PDL
        pdPos = above || below ? ((above && dir > 0) || (below && dir < 0) ? 'breakout-with' : 'outside-against') : 'inside-PD' }
      let gap = 'no-pd'
      if (isFinite(PDC)) { const g = (rthOpen - PDC) / eatr; gap = Math.abs(g) < 0.75 ? 'flat-open' : (g > 0) === (dir > 0) ? 'gap-with' : 'gap-against' }
      const drift = ((r.entry - rthOpen) * dir) > 0 ? 'with-drift' : 'against-drift'
      // session VWAP up to entry
      let pv = 0, vv = 0; for (let j = 0; j <= i0 && j < day.length; j++) { const b = day[j]; const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v }
      const vwap = vv > 0 ? (((r.entry - pv / vv) * dir) > 0 ? 'with-vwap' : 'against-vwap') : 'no-vwap'
      // move spent: RTH range consumed before entry, in ATR
      let hi = -Infinity, lo = Infinity; for (let j = 0; j <= i0 && j < day.length; j++) { if (day[j].h > hi) hi = day[j].h; if (day[j].l < lo) lo = day[j].l }
      const spentATR = (hi - lo) / eatr
      const spent = spentATR < 3 ? 'fresh(<3ATR)' : spentATR < 6 ? 'mid(3-6ATR)' : 'extended(>6ATR)'
      recs.push({ yr: date.slice(0, 4), adv, atrBand, pdPos, gap, drift, vwap, spent })
    }
  }
  const m = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString()
  const table = (name: string, fn: (r: R) => string, minN = 25) => {
    const g = new Map<string, R[]>(); for (const r of recs) (g.get(fn(r)) ?? g.set(fn(r), []).get(fn(r))!).push(r)
    console.log(`\n== ${name} ==`)
    console.log(`   ${'bucket'.padEnd(18)} ${'n'.padStart(4)} ${'$/trade'.padStart(8)} ${'win%'.padStart(5)} ${'2025'.padStart(8)} ${'2026'.padStart(8)}`)
    for (const [k, a] of [...g.entries()].filter(([, a]) => a.length >= minN).sort((x, y) => y[1].reduce((s, r) => s + r.adv, 0) / y[1].length - x[1].reduce((s, r) => s + r.adv, 0) / x[1].length)) {
      const a25 = a.filter(r => r.yr === '2025'), a26 = a.filter(r => r.yr === '2026')
      const s25 = a25.reduce((s, r) => s + r.adv, 0), s26 = a26.reduce((s, r) => s + r.adv, 0)
      const flag = s25 > 0 && s26 > 0 ? ' <BOTH+' : s25 < 0 && s26 < 0 ? ' <both-' : ''
      console.log(`   ${k.padEnd(18)} ${String(a.length).padStart(4)} ${m(a.reduce((s, r) => s + r.adv, 0) / a.length).padStart(8)} ${(100 * a.filter(r => r.adv > 0).length / a.length).toFixed(0).padStart(4)}% ${m(s25).padStart(8)} ${m(s26).padStart(8)}${flag}`)
    }
  }
  console.log(`runners (reached 2xATR): ${recs.length} | manager: BE stop + 4xATR target`)
  table('ABSOLUTE ATR BAND', r => r.atrBand)
  table('POSITION vs PRIOR-DAY RANGE (direction-aware)', r => r.pdPos)
  table('OVERNIGHT GAP (direction-aware, 0.75 ATR threshold)', r => r.gap)
  table('DAY DRIFT (entry vs RTH open, direction-aware)', r => r.drift)
  table('VWAP SIDE (direction-aware)', r => r.vwap)
  table('MOVE ALREADY SPENT (RTH range before entry / ATR)', r => r.spent)
}
main()
