/** Two tests:
 * A) 5m EMA ALIGNMENT (price vs 9EMA vs 20EMA at entry, direction-aware) as a
 *    condition for (1) runner hold-advantage (BE+4xATR) and (2) max extension.
 * B) EXTENSION analysis: MFE in ATR (entry->close, all trades) conditioned on
 *    EMA alignment, time of day, and the robust HTF features — what predicts
 *    the BIG extensions (>=4, >=6 ATR)?
 */
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
interface Bar { ms: number; o: number; h: number; l: number; c: number }
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
interface R { yr: string; mfe: number; reached: boolean; adv: number | null; ema: string; hour: number }
function main() {
  const rows = parse(); const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const recs: R[] = []
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!; const s0 = list[0]
    const off = Math.round((s0.ms - Date.parse(`${date}T${String(s0.hour).padStart(2, '0')}:${String(s0.min).padStart(2, '0')}:00Z`)) / 3600_000)
    const file = pick(s0.ms, s0.entry); if (!file) continue
    const warm = new Date(Date.parse(date + 'T00:00:00Z') - 5 * 86400000).toISOString().slice(0, 10)
    const closeMs = Date.parse(`${date}T13:00:00Z`) + off * 3600_000, rthStart = Date.parse(`${date}T06:30:00Z`) + off * 3600_000
    let all: Bar[]; try { all = readScidBars(join(DATA_DIR, file), Date.parse(warm + 'T00:00:00Z'), closeMs, { priceDivisor: 100, bucketMs: 60000 }).bars.map(x => ({ ms: Date.parse(x.ts), o: x.open, h: x.high, l: x.low, c: x.close })) } catch { continue }
    const atr = atrSeries(all); const day = all.filter(b => b.ms >= rthStart && b.ms < closeMs); if (!day.length) continue
    // 5m bars + 9/20 EMA (standard alpha), from the warm window for seeding
    const b5: Bar[] = []; { let cur: Bar | null = null
      for (const b of all) { const m5 = Math.floor(b.ms / 300000) * 300000
        if (!cur || cur.ms !== m5) { if (cur) b5.push(cur); cur = { ms: m5, o: b.o, h: b.h, l: b.l, c: b.c } }
        else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c } }
      if (cur) b5.push(cur) }
    const e9: number[] = [], e20: number[] = []; { let a9: number | null = null, a20: number | null = null
      for (const b of b5) { a9 = a9 == null ? b.c : (2 / 10) * b.c + (8 / 10) * a9; a20 = a20 == null ? b.c : (2 / 21) * b.c + (19 / 21) * a20; e9.push(a9); e20.push(a20) } }
    for (const r of list) {
      let eatr = 0; for (const b of all) { if (b.ms <= r.ms && atr.has(b.ms)) eatr = atr.get(b.ms)! }; if (eatr <= 0) continue
      const dir = r.side === 'long' ? 1 : -1, R2 = r.riskPts ?? eatr, tp1 = r.entry + dir * 2 * eatr, stop0 = r.entry - dir * R2
      const i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      // EMA alignment at entry (last completed 5m bar at/before entry)
      let ei = -1; for (let j = 0; j < b5.length; j++) { if (b5[j].ms + 300000 <= r.ms) ei = j; else break }
      let ema = 'mixed'
      if (ei >= 0) { const p = r.entry, x9 = e9[ei], x20 = e20[ei]
        const withE = dir > 0 ? (p > x9 && x9 > x20) : (p < x9 && x9 < x20)
        const againstE = dir > 0 ? (p < x9 && x9 < x20) : (p > x9 && x9 > x20)
        ema = withE ? 'with-EMAs' : againstE ? 'against-EMAs' : 'mixed' }
      // MFE (unconditional) + reached-2xATR-before-stop + be4 hold-advantage
      let mfe = 0, k = -1, resolved = false
      for (let j = i0; j < day.length; j++) { const b = day[j]
        const fav = (dir > 0 ? b.h - r.entry : r.entry - b.l) / eatr; if (fav > mfe) mfe = fav
        if (!resolved) { if (dir > 0 ? b.l <= stop0 : b.h >= stop0) resolved = true
          else if (dir > 0 ? b.h >= tp1 : b.l <= tp1) { k = j; resolved = true } } }
      let adv: number | null = null
      if (k >= 0) { const exit = beTarget(day, k, r.entry, dir, r.entry + dir * 4 * eatr); adv = (exit - tp1) * dir * 0.4 * r.qty * MULT }
      recs.push({ yr: date.slice(0, 4), mfe, reached: k >= 0, adv, ema, hour: r.hour })
    }
  }
  const m = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString()
  const med = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN }
  console.log(`trades ${recs.length} | reached 2xATR ${recs.filter(r => r.reached).length}`)
  // A) EMA alignment: hold-advantage (runners only)
  console.log('\n== A) 5m 9/20 EMA ALIGNMENT — runner hold-advantage (BE+4xATR) ==')
  console.log(`   ${'bucket'.padEnd(14)} ${'n'.padStart(4)} ${'$/trade'.padStart(8)} ${'win%'.padStart(5)} ${'2025'.padStart(8)} ${'2026'.padStart(8)}`)
  { const g = new Map<string, R[]>(); for (const r of recs.filter(r => r.adv != null)) (g.get(r.ema) ?? g.set(r.ema, []).get(r.ema)!).push(r)
    for (const [k, a] of [...g.entries()].sort((x, y) => y[1].reduce((s, r) => s + r.adv!, 0) / y[1].length - x[1].reduce((s, r) => s + r.adv!, 0) / x[1].length)) {
      const a25 = a.filter(r => r.yr === '2025'), a26 = a.filter(r => r.yr === '2026')
      const s25 = a25.reduce((s, r) => s + r.adv!, 0), s26 = a26.reduce((s, r) => s + r.adv!, 0)
      const f = s25 > 0 && s26 > 0 ? ' <BOTH+' : s25 < 0 && s26 < 0 ? ' <both-' : ''
      console.log(`   ${k.padEnd(14)} ${String(a.length).padStart(4)} ${m(a.reduce((s, r) => s + r.adv!, 0) / a.length).padStart(8)} ${(100 * a.filter(r => r.adv! > 0).length / a.length).toFixed(0).padStart(4)}% ${m(s25).padStart(8)} ${m(s26).padStart(8)}${f}`) } }
  // B) extension (all trades): MFE ladder by bucket
  const ext = (name: string, fn: (r: R) => string) => {
    console.log(`\n== B) MAX EXTENSION (MFE in ATR, all trades) by ${name} ==`)
    console.log(`   ${'bucket'.padEnd(14)} ${'n'.padStart(4)} ${'medMFE'.padStart(7)} ${'%>=4'.padStart(5)} ${'%>=6'.padStart(5)} ${'med25'.padStart(6)} ${'med26'.padStart(6)}`)
    const g = new Map<string, R[]>(); for (const r of recs) (g.get(fn(r)) ?? g.set(fn(r), []).get(fn(r))!).push(r)
    for (const [k, a] of [...g.entries()].filter(([, a]) => a.length >= 40).sort((x, y) => med(y[1].map(r => r.mfe)) - med(x[1].map(r => r.mfe)))) {
      const a25 = a.filter(r => r.yr === '2025'), a26 = a.filter(r => r.yr === '2026')
      console.log(`   ${k.padEnd(14)} ${String(a.length).padStart(4)} ${med(a.map(r => r.mfe)).toFixed(1).padStart(7)} ${(100 * a.filter(r => r.mfe >= 4).length / a.length).toFixed(0).padStart(4)}% ${(100 * a.filter(r => r.mfe >= 6).length / a.length).toFixed(0).padStart(4)}% ${med(a25.map(r => r.mfe)).toFixed(1).padStart(6)} ${med(a26.map(r => r.mfe)).toFixed(1).padStart(6)}`) } }
  ext('EMA alignment', r => r.ema)
  ext('time of day', r => r.hour < 8 ? '0630-0800' : r.hour < 10 ? '0800-1000' : r.hour < 12 ? '1000-1200' : '1200-1300')
  ext('EMA x time', r => `${r.ema === 'with-EMAs' ? 'withEMA' : r.ema === 'against-EMAs' ? 'againstEMA' : 'mixed'} ${r.hour < 10 ? '<10' : '>=10'}`)
}
main()
