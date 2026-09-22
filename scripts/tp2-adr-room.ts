/** RANGE-EXHAUSTION conditioning of the TP2 hold (manager = BE stop + 4xATR).
 * All features knowable AT ENTRY, no tags:
 *   ADR10        = trailing 10-day RTH (06:30-13:00 PT) high-low range mean, in pts
 *   adrUsedPct   = (today's RTH range so far)/ADR10 -> how much fuel already burned
 *   roomAheadADR = direction-aware room to the ADR envelope, in ADR units
 *                  long : (dayLowSoFar + ADR10 - entry)/ADR10
 *                  short: (entry - (dayHighSoFar - ADR10))/ADR10
 *   extFromOpen  = (entry - RTHopen)*dir / ADR10  (how far in your dir from open)
 *   rvol         = today's RTH volume-to-entry / trailing-10d avg vol same window
 * Metric: hold-adv $ = (runnerExit - TP1)*dir*0.4*qty*2. Split 2025/2026. */
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
interface R { yr: string; adv: number; used: string; room: string; ext: string; rvol: string }
function main() {
  const rows = parse(); const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  const recs: R[] = []
  for (const date of [...byDate.keys()].sort()) {
    const list = byDate.get(date)!; const s0 = list[0]
    const off = Math.round((s0.ms - Date.parse(`${date}T${String(s0.hour).padStart(2, '0')}:${String(s0.min).padStart(2, '0')}:00Z`)) / 3600_000)
    const file = pick(s0.ms, s0.entry); if (!file) continue
    const warm = new Date(Date.parse(date + 'T00:00:00Z') - 22 * 86400000).toISOString().slice(0, 10)
    const closeMs = Date.parse(`${date}T13:00:00Z`) + off * 3600_000, rthStart = Date.parse(`${date}T06:30:00Z`) + off * 3600_000
    let all: Bar[]; try { all = readScidBars(join(DATA_DIR, file), Date.parse(warm + 'T00:00:00Z'), closeMs, { priceDivisor: 100, bucketMs: 60000 }).bars.map(x => ({ ms: Date.parse(x.ts), o: x.open, h: x.high, l: x.low, c: x.close, v: x.volume })) } catch { continue }
    const atr = atrSeries(all); const day = all.filter(b => b.ms >= rthStart && b.ms < closeMs); if (!day.length) continue
    // trailing 10-day RTH ranges + same-time-of-day volume baseline
    const ranges: number[] = []
    for (let d = 1; d <= 20 && ranges.length < 10; d++) { const ps = rthStart - d * 86400000, pe = ps + 6.5 * 3600_000; const pb = all.filter(b => b.ms >= ps && b.ms < pe)
      if (pb.length > 30) ranges.push(Math.max(...pb.map(b => b.h)) - Math.min(...pb.map(b => b.l))) }
    if (ranges.length < 5) continue
    const ADR10 = ranges.reduce((s, v) => s + v, 0) / ranges.length
    const rthOpen = day[0].o
    for (const r of list) {
      let eatr = 0; for (const b of all) { if (b.ms <= r.ms && atr.has(b.ms)) eatr = atr.get(b.ms)! }; if (eatr <= 0) continue
      const dir = r.side === 'long' ? 1 : -1, R2 = r.riskPts ?? eatr, tp1 = r.entry + dir * 2 * eatr, stop0 = r.entry - dir * R2
      const i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      // range so far + rvol
      let hi = -Infinity, lo = Infinity, vol = 0; for (let j = 0; j <= i0 && j < day.length; j++) { const b = day[j]; if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; vol += b.v }
      const usedPct = 100 * (hi - lo) / ADR10
      const roomADR = dir > 0 ? (lo + ADR10 - r.entry) / ADR10 : (r.entry - (hi - ADR10)) / ADR10
      const extOpen = (r.entry - rthOpen) * dir / ADR10
      // rvol: today's vol-to-entry vs trailing-10d avg vol over the SAME elapsed RTH minutes
      const elapsed = Math.max(1, Math.round((day[Math.min(i0, day.length - 1)].ms - rthStart) / 60000) + 1)
      const bvols: number[] = []
      for (let d = 1; d <= 20 && bvols.length < 10; d++) { const ps = rthStart - d * 86400000; const pb = all.filter(b => b.ms >= ps && b.ms < ps + elapsed * 60000)
        if (pb.length > 5) bvols.push(pb.reduce((s, b) => s + b.v, 0)) }
      const rv = bvols.length ? vol / (bvols.reduce((s, v) => s + v, 0) / bvols.length) : NaN
      // resolve runner
      let k = -1; for (let i = i0; i < day.length; i++) { const b = day[i]; if (dir > 0 ? b.l <= stop0 : b.h >= stop0) { k = -2; break } if (dir > 0 ? b.h >= tp1 : b.l <= tp1) { k = i; break } }
      if (k < 0) continue
      const exit = beTarget(day, k, r.entry, dir, r.entry + dir * 4 * eatr)
      recs.push({ yr: date.slice(0, 4), adv: (exit - tp1) * dir * 0.4 * r.qty * MULT,
        used: usedPct < 40 ? 'a:<40%' : usedPct < 70 ? 'b:40-70%' : usedPct < 100 ? 'c:70-100%' : 'd:>100%(expansion)',
        room: roomADR < 0.5 ? 'a:<0.5ADR' : roomADR < 1.0 ? 'b:0.5-1.0' : roomADR < 1.5 ? 'c:1.0-1.5' : 'd:>1.5ADR',
        ext: extOpen < 0 ? 'a:below open' : extOpen < 0.5 ? 'b:0-0.5ADR' : extOpen < 1.0 ? 'c:0.5-1.0' : 'd:>1.0ADR',
        rvol: !isFinite(rv) ? 'z:na' : rv < 0.8 ? 'a:<0.8 quiet' : rv < 1.2 ? 'b:0.8-1.2 normal' : rv < 1.6 ? 'c:1.2-1.6 busy' : 'd:>1.6 heavy' })
    }
  }
  const m = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString()
  const table = (name: string, fn: (r: R) => string, minN = 25) => {
    const g = new Map<string, R[]>(); for (const r of recs) (g.get(fn(r)) ?? g.set(fn(r), []).get(fn(r))!).push(r)
    console.log(`\n== ${name} ==`)
    console.log(`   ${'bucket'.padEnd(20)} ${'n'.padStart(4)} ${'$/trade'.padStart(8)} ${'win%'.padStart(5)} ${'2025'.padStart(8)} ${'2026'.padStart(8)}`)
    for (const [k, a] of [...g.entries()].filter(([, a]) => a.length >= minN).sort((x, y) => x[0] < y[0] ? -1 : 1)) {
      const s25 = a.filter(r => r.yr === '2025').reduce((s, r) => s + r.adv, 0), s26 = a.filter(r => r.yr === '2026').reduce((s, r) => s + r.adv, 0)
      const flag = s25 > 0 && s26 > 0 ? ' <BOTH+' : s25 < 0 && s26 < 0 ? ' <both-' : ''
      console.log(`   ${k.padEnd(20)} ${String(a.length).padStart(4)} ${m(a.reduce((s, r) => s + r.adv, 0) / a.length).padStart(8)} ${(100 * a.filter(r => r.adv > 0).length / a.length).toFixed(0).padStart(4)}% ${m(s25).padStart(8)} ${m(s26).padStart(8)}${flag}`)
    }
  }
  console.log(`runners (reached 2xATR): ${recs.length} | manager: BE + 4xATR`)
  table('ADR USED BEFORE ENTRY (fuel burned)', r => r.used)
  table('ROOM AHEAD TO ADR ENVELOPE (direction-aware)', r => r.room)
  table('EXTENSION FROM RTH OPEN (in your direction)', r => r.ext)
  table('RVOL AT ENTRY (vol vs trailing-10d same time)', r => r.rvol)
}
main()
