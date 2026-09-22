/** Head-to-head runner variants (60% at 2xATR, 40% runner, BE floor on all):
 *  be4   : BE stop, fixed target 4xATR
 *  be5   : BE stop, fixed target 5xATR
 *  trail : original 1m trail (BE -> confirm close past TP1 -> exit on close
 *          beyond prior bar extreme)
 *  tr100 : original trail + hard cap at entry+100pts
 *  be100 : BE stop, fixed target entry+100pts (no ATR target)
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { readScidBars } from '../src/lib/scid-reader'
const ENTRIES = 'D:/Documents/NQ_backtest/entries_full2.csv', DATA_DIR = 'D:/SierraCharts/Data', MULT = 2
const FILES = ['NQH5.CME.scid', 'NQM5.CME.scid', 'NQU5.CME.scid', 'NQz5.CME.scid', 'NQH6.CME.scid', 'NQM6.CME.scid', 'NQU6.CME.scid', 'NQZ6.CME.scid']
interface Row { ms: number; date: string; hour: number; min: number; side: 'long' | 'short'; entry: number; riskPts: number | null; qty: number; pnl: number }
function parse(): Row[] { const L = readFileSync(ENTRIES, 'utf8').split(/\r?\n/).filter(l => l.trim()); const o: Row[] = []
  for (let i = 1; i < L.length; i++) { const c = L[i].split(','); if (+c[4] !== 1) continue; const e = +c[6], q = +c[9], p = +c[10], s = c[5]
    if (!(e > 15000 && e < 50000) || !(q > 0) || !isFinite(p) || (s !== 'long' && s !== 'short')) continue
    o.push({ ms: +c[0], date: c[1], hour: +c[2], min: +c[3], side: s, entry: e, riskPts: c[7] === '' ? null : +c[7], qty: q, pnl: p }) } return o }
interface Bar { ms: number; o: number; h: number; l: number; c: number }
function atrSeries(b: Bar[]) { const out = new Map<number, number>(); let a: number | null = null, pc: number | null = null; const sd: number[] = []
  for (const x of b) { const tr = pc == null ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)); if (a == null) { sd.push(tr); if (sd.length === 10) a = sd.reduce((s, v) => s + v, 0) / 10 } else a = (9 * a + tr) / 10; pc = x.c; if (a != null) out.set(x.ms, a) } return out }
const probe = new Map<string, number | null>()
function priceAt(f: string, ms: number) { const k = f + ':' + ms; if (probe.has(k)) return probe.get(k)!; let v: number | null = null; try { const b = readScidBars(join(DATA_DIR, f), ms - 120000, ms + 120000, { priceDivisor: 100, bucketMs: 60000 }).bars; if (b.length) v = b[Math.floor(b.length / 2)].close } catch {}; probe.set(k, v); return v }
function pick(ms: number, p: number) { let best: string | null = null, bd = 40; for (const f of FILES) { const x = priceAt(f, ms); if (x == null) continue; const d = Math.abs(x - p); if (d < bd) { bd = d; best = f } } return best }
// fixed target with BE floor
function beTarget(day: Bar[], k: number, entry: number, dir: number, target: number) {
  for (let j = k + 1; j < day.length; j++) { const b = day[j]
    if (dir > 0 ? b.h >= target : b.l <= target) return target
    if (dir > 0 ? b.l <= entry : b.h >= entry) return entry }
  return day[day.length - 1].c }
// original trail, optional hard cap
function origTrail(day: Bar[], k: number, entry: number, dir: number, tp1: number, cap: number | null) { let trailing = false
  for (let j = k; j < day.length; j++) { const b = day[j]
    if (cap != null && (dir > 0 ? b.h >= cap : b.l <= cap)) return cap
    if (j > k && (dir > 0 ? b.l <= entry : b.h >= entry)) return entry
    if (!trailing) { if (dir > 0 ? b.c > tp1 : b.c < tp1) trailing = true }
    else { const p = day[j - 1]; if (dir > 0 ? b.c < p.l : b.c > p.h) return b.c } }
  return day[day.length - 1].c }
function main() {
  const rows = parse(); const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const keys = ['flat', 'be4', 'be5', 'trail', 'tr100', 'be100']
  const tot: Record<string, number> = { sq: 0 }; keys.forEach(k => tot[k] = 0)
  const yk: Record<string, Record<string, number>> = {}
  const hit: Record<string, number> = { be4: 0, be5: 0, be100: 0, tr100cap: 0 }
  let n = 0, reached = 0
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!; const s0 = list[0]
    const off = Math.round((s0.ms - Date.parse(`${date}T${String(s0.hour).padStart(2, '0')}:${String(s0.min).padStart(2, '0')}:00Z`)) / 3600_000)
    const file = pick(s0.ms, s0.entry); if (!file) continue
    const warm = new Date(Date.parse(date + 'T00:00:00Z') - 4 * 86400000).toISOString().slice(0, 10)
    const closeMs = Date.parse(`${date}T13:00:00Z`) + off * 3600_000, rthStart = Date.parse(`${date}T06:30:00Z`) + off * 3600_000
    let all: Bar[]; try { all = readScidBars(join(DATA_DIR, file), Date.parse(warm + 'T00:00:00Z'), closeMs, { priceDivisor: 100, bucketMs: 60000 }).bars.map(x => ({ ms: Date.parse(x.ts), o: x.open, h: x.high, l: x.low, c: x.close })) } catch { continue }
    const atr = atrSeries(all); const day = all.filter(b => b.ms >= rthStart && b.ms < closeMs); if (!day.length) continue
    const Y = date.slice(0, 4); (yk[Y] ??= ((): Record<string, number> => { const o: Record<string, number> = { sq: 0 }; keys.forEach(k => o[k] = 0); return o })())
    for (const r of list) {
      let eatr = 0; for (const b of all) { if (b.ms <= r.ms && atr.has(b.ms)) eatr = atr.get(b.ms)! }; if (eatr <= 0) continue
      const dir = r.side === 'long' ? 1 : -1, R = r.riskPts ?? eatr, tp1 = r.entry + dir * 2 * eatr, stop0 = r.entry - dir * R
      let i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      let k = -1, ex: number | null = null
      for (let i = i0; i < day.length; i++) { const b = day[i]; if (dir > 0 ? b.l <= stop0 : b.h >= stop0) { ex = stop0; break } if (dir > 0 ? b.h >= tp1 : b.l <= tp1) { k = i; break } }
      n++; tot.sq += r.pnl; yk[Y].sq += r.pnl
      const add = (kk: string, v: number) => { tot[kk] += v; yk[Y][kk] += v }
      if (k < 0) { const px = ex ?? day[day.length - 1].c; const v = (px - r.entry) * dir * r.qty * MULT; for (const kk of keys) add(kk, v); continue }
      reached++
      const bank = (tp1 - r.entry) * dir * 0.6 * r.qty * MULT, run = (px: number) => (px - r.entry) * dir * 0.4 * r.qty * MULT
      add('flat', (tp1 - r.entry) * dir * r.qty * MULT)
      const t4 = r.entry + dir * 4 * eatr, t5 = r.entry + dir * 5 * eatr, t100 = r.entry + dir * 100
      const e4 = beTarget(day, k, r.entry, dir, t4); if (e4 === t4) hit.be4++
      const e5 = beTarget(day, k, r.entry, dir, t5); if (e5 === t5) hit.be5++
      const e100 = beTarget(day, k, r.entry, dir, t100); if (e100 === t100) hit.be100++
      const etr = origTrail(day, k, r.entry, dir, tp1, null)
      const etr100 = origTrail(day, k, r.entry, dir, tp1, t100); if (etr100 === t100) hit.tr100cap++
      add('be4', bank + run(e4)); add('be5', bank + run(e5)); add('be100', bank + run(e100))
      add('trail', bank + run(etr)); add('tr100', bank + run(etr100))
    }
  }
  const m = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString()
  const lab: Record<string, string> = { flat: 'Flat 2xATR (no runner)', be4: 'BE stop + 4xATR target', be5: 'BE stop + 5xATR target', trail: 'Your 1m candle trail', tr100: 'Trail + 100pt hard cap', be100: 'BE stop + 100pt target' }
  console.log(`evaluated ${n} (reached 2xATR ${reached})`)
  console.log(`\n${'method'.padEnd(26)} ${'total'.padStart(10)} ${'vs SQ'.padStart(9)} ${'2025 vsSQ'.padStart(10)} ${'2026 vsSQ'.padStart(10)}`)
  console.log(`${'Status quo'.padEnd(26)} ${m(tot.sq).padStart(10)}`)
  for (const k of keys) { const d25 = yk['2025'][k] - yk['2025'].sq, d26 = yk['2026'][k] - yk['2026'].sq; console.log(`${lab[k].padEnd(26)} ${m(tot[k]).padStart(10)} ${m(tot[k] - tot.sq).padStart(9)} ${m(d25).padStart(10)} ${m(d26).padStart(10)}`) }
  console.log(`\ntarget hit-rates (of ${reached} runners): 4xATR ${(100 * hit.be4 / reached).toFixed(0)}%  5xATR ${(100 * hit.be5 / reached).toFixed(0)}%  100pt ${(100 * hit.be100 / reached).toFixed(0)}%  trail-capped-at-100pt ${(100 * hit.tr100cap / reached).toFixed(0)}%`)
}
main()
