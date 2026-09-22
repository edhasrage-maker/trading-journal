/** Hour-by-hour (entry hour, PT) with a FIXED 1xATR stop / 2xATR target frame
 * (ignores the trade's real stop). Per hour:
 *   - n
 *   - reached +2xATR BEFORE the -1xATR stop (first-touch, stop-first within a bar = conservative)
 *   - expectancy (mean R) of the 2R-target/1R-stop system (win +2R, stop -1R, else mark-to-close)
 *   - median R of that same system (the "median expectancy")
 *   - of the REACHERS: median MFE (in ATR/R) = how far the good ones run
 * Split 2025 vs 2026 for robustness. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { readScidBars } from '../src/lib/scid-reader'
const ENTRIES = 'D:/Documents/NQ_backtest/entries_full2.csv', DATA_DIR = 'D:/SierraCharts/Data'
const FILES = ['NQH5.CME.scid', 'NQM5.CME.scid', 'NQU5.CME.scid', 'NQz5.CME.scid', 'NQH6.CME.scid', 'NQM6.CME.scid', 'NQU6.CME.scid', 'NQZ6.CME.scid']
interface Row { ms: number; date: string; hour: number; min: number; side: 'long' | 'short'; entry: number }
function parse(): Row[] { const L = readFileSync(ENTRIES, 'utf8').split(/\r?\n/).filter(l => l.trim()); const o: Row[] = []
  for (let i = 1; i < L.length; i++) { const c = L[i].split(','); if (+c[4] !== 1) continue; const e = +c[6], q = +c[9], s = c[5]
    if (!(e > 15000 && e < 50000) || !(q > 0) || (s !== 'long' && s !== 'short')) continue
    o.push({ ms: +c[0], date: c[1], hour: +c[2], min: +c[3], side: s, entry: e }) } return o }
interface Bar { ms: number; o: number; h: number; l: number; c: number }
function atrSeries(b: Bar[]) { const out = new Map<number, number>(); let a: number | null = null, pc: number | null = null; const sd: number[] = []
  for (const x of b) { const tr = pc == null ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)); if (a == null) { sd.push(tr); if (sd.length === 10) a = sd.reduce((s, v) => s + v, 0) / 10 } else a = (9 * a + tr) / 10; pc = x.c; if (a != null) out.set(x.ms, a) } return out }
const probe = new Map<string, number | null>()
function priceAt(f: string, ms: number) { const k = f + ':' + ms; if (probe.has(k)) return probe.get(k)!; let v: number | null = null; try { const b = readScidBars(join(DATA_DIR, f), ms - 120000, ms + 120000, { priceDivisor: 100, bucketMs: 60000 }).bars; if (b.length) v = b[Math.floor(b.length / 2)].close } catch {}; probe.set(k, v); return v }
function pick(ms: number, p: number) { let best: string | null = null, bd = 40; for (const f of FILES) { const x = priceAt(f, ms); if (x == null) continue; const d = Math.abs(x - p); if (d < bd) { bd = d; best = f } } return best }
const med = (a: number[]) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2 }
interface Rec { yr: string; hour: number; reached: boolean; r: number; mfe: number }
function main() {
  const rows = parse(); const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const recs: Rec[] = []
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
      const dir = r.side === 'long' ? 1 : -1, stop = r.entry - dir * eatr, tgt = r.entry + dir * 2 * eatr
      const i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      let mfe = 0, outcome: 'win' | 'loss' | null = null, rR = 0
      for (let j = i0; j < day.length; j++) { const b = day[j]
        const fav = (dir > 0 ? b.h - r.entry : r.entry - b.l) / eatr; if (fav > mfe) mfe = fav
        if (outcome == null) { const stopHit = dir > 0 ? b.l <= stop : b.h >= stop; const tgtHit = dir > 0 ? b.h >= tgt : b.l <= tgt
          if (stopHit) { outcome = 'loss'; rR = -1 }          // conservative: stop checked before target in same bar
          else if (tgtHit) { outcome = 'win'; rR = 2 } } }
      if (outcome == null) rR = (day[day.length - 1].c - r.entry) * dir / eatr   // neither → mark to close, in R (1R = 1xATR)
      recs.push({ yr: date.slice(0, 4), hour: r.hour, reached: outcome === 'win', r: rR, mfe })
    }
  }
  const hours = [...new Set(recs.map(r => r.hour))].sort((a, b) => a - b)
  console.log(`total ${recs.length} | frame: 1xATR stop, 2xATR target, first-touch (stop-first within bar)`)
  console.log(`\n${'hr(PT)'.padEnd(7)} ${'n'.padStart(4)} ${'reach2R'.padStart(8)} ${'rate'.padStart(5)} ${'exp(R)'.padStart(7)} ${'medR'.padStart(6)} ${'reachMedMFE'.padStart(11)} ${'25rate'.padStart(7)} ${'26rate'.padStart(7)}`)
  for (const h of hours) {
    const a = recs.filter(r => r.hour === h); if (a.length < 10) continue
    const reach = a.filter(r => r.reached)
    const exp = a.reduce((s, r) => s + r.r, 0) / a.length
    const a25 = a.filter(r => r.yr === '2025'), a26 = a.filter(r => r.yr === '2026')
    const rate = (x: Rec[]) => x.length ? (100 * x.filter(r => r.reached).length / x.length).toFixed(0) + '%' : '-'
    const label = `${String(h).padStart(2, '0')}:00`
    console.log(`${label.padEnd(7)} ${String(a.length).padStart(4)} ${String(reach.length).padStart(8)} ${(100 * reach.length / a.length).toFixed(0).padStart(4)}% ${exp.toFixed(2).padStart(7)} ${med(a.map(r => r.r)).toFixed(2).padStart(6)} ${med(reach.map(r => r.mfe)).toFixed(1).padStart(11)} ${rate(a25).padStart(7)} ${rate(a26).padStart(7)}`)
  }
  // grouped windows
  console.log('\ngrouped:')
  const grp: [string, (h: number) => boolean][] = [['pre-08', h => h < 8], ['08-09', h => h === 8 || h === 9], ['10-11', h => h === 10 || h === 11], ['12+', h => h >= 12]]
  for (const [name, f] of grp) { const a = recs.filter(r => f(r.hour)); if (!a.length) continue
    const reach = a.filter(r => r.reached); const exp = a.reduce((s, r) => s + r.r, 0) / a.length
    console.log(`  ${name.padEnd(6)} n=${String(a.length).padStart(4)}  reach2R ${(100 * reach.length / a.length).toFixed(0)}%  exp ${exp.toFixed(2)}R  medR ${med(a.map(r => r.r)).toFixed(2)}  reacher-medMFE ${med(reach.map(r => r.mfe)).toFixed(1)}xATR`) }
}
main()
