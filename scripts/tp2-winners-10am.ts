/** Of WINNERS (recorded pnl>0) entered >=10am PT: how many reached 2xATR
 * (the TP1/scale), and how far beyond (3x, 4x=TP2, 6x)? Plus 4xATR-before-BE. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { readScidBars } from '../src/lib/scid-reader'
const ENTRIES = 'D:/Documents/NQ_backtest/entries_full2.csv', DATA_DIR = 'D:/SierraCharts/Data'
const FILES = ['NQH5.CME.scid', 'NQM5.CME.scid', 'NQU5.CME.scid', 'NQz5.CME.scid', 'NQH6.CME.scid', 'NQM6.CME.scid', 'NQU6.CME.scid', 'NQZ6.CME.scid']
interface Row { ms: number; date: string; hour: number; min: number; side: 'long' | 'short'; entry: number; riskPts: number | null; pnl: number }
function parse(): Row[] { const L = readFileSync(ENTRIES, 'utf8').split(/\r?\n/).filter(l => l.trim()); const o: Row[] = []
  for (let i = 1; i < L.length; i++) { const c = L[i].split(','); if (+c[4] !== 1) continue; const e = +c[6], q = +c[9], p = +c[10], s = c[5]
    if (!(e > 15000 && e < 50000) || !(q > 0) || !isFinite(p) || (s !== 'long' && s !== 'short')) continue
    o.push({ ms: +c[0], date: c[1], hour: +c[2], min: +c[3], side: s, entry: e, riskPts: c[7] === '' ? null : +c[7], pnl: p }) } return o }
interface Bar { ms: number; o: number; h: number; l: number; c: number }
function atrSeries(b: Bar[]) { const out = new Map<number, number>(); let a: number | null = null, pc: number | null = null; const sd: number[] = []
  for (const x of b) { const tr = pc == null ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc)); if (a == null) { sd.push(tr); if (sd.length === 10) a = sd.reduce((s, v) => s + v, 0) / 10 } else a = (9 * a + tr) / 10; pc = x.c; if (a != null) out.set(x.ms, a) } return out }
const probe = new Map<string, number | null>()
function priceAt(f: string, ms: number) { const k = f + ':' + ms; if (probe.has(k)) return probe.get(k)!; let v: number | null = null; try { const b = readScidBars(join(DATA_DIR, f), ms - 120000, ms + 120000, { priceDivisor: 100, bucketMs: 60000 }).bars; if (b.length) v = b[Math.floor(b.length / 2)].close } catch {}; probe.set(k, v); return v }
function pick(ms: number, p: number) { let best: string | null = null, bd = 40; for (const f of FILES) { const x = priceAt(f, ms); if (x == null) continue; const d = Math.abs(x - p); if (d < bd) { bd = d; best = f } } return best }
function main() {
  const rows = parse().filter(r => r.hour >= 10 && r.pnl > 0)
  const byDate = new Map<string, Row[]>(); for (const r of rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r)
  interface Rec { yr: string; mfe: number; reachedBeforeStop: boolean; hit4beforeBE: boolean }
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
      const dir = r.side === 'long' ? 1 : -1, R = r.riskPts ?? eatr
      const tp1 = r.entry + dir * 2 * eatr, tp2 = r.entry + dir * 4 * eatr, stop0 = r.entry - dir * R
      const i0 = day.findIndex(b => b.ms >= r.ms); if (i0 < 0) continue
      let mfe = 0, k = -1, resolved = false
      for (let j = i0; j < day.length; j++) { const b = day[j]
        const fav = (dir > 0 ? b.h - r.entry : r.entry - b.l) / eatr; if (fav > mfe) mfe = fav
        if (!resolved) { if (dir > 0 ? b.l <= stop0 : b.h >= stop0) resolved = true
          else if (dir > 0 ? b.h >= tp1 : b.l <= tp1) { k = j; resolved = true } } }
      let hit4 = false
      if (k >= 0) { for (let j = k + 1; j < day.length; j++) { const b = day[j]
        if (dir > 0 ? b.h >= tp2 : b.l <= tp2) { hit4 = true; break }
        if (dir > 0 ? b.l <= r.entry : b.h >= r.entry) break } }
      recs.push({ yr: date.slice(0, 4), mfe, reachedBeforeStop: k >= 0, hit4beforeBE: hit4 })
    }
  }
  const n = recs.length
  const pc = (x: number) => `${x}  (${(100 * x / n).toFixed(0)}%)`
  console.log(`WINNERS entered >=10am PT: ${n}`)
  console.log(`  reached 2xATR (your scale) BEFORE initial stop: ${pc(recs.filter(r => r.reachedBeforeStop).length)}`)
  console.log(`  MFE ever >= 2 ATR: ${pc(recs.filter(r => r.mfe >= 2).length)}`)
  console.log(`  MFE ever >= 3 ATR: ${pc(recs.filter(r => r.mfe >= 3).length)}`)
  console.log(`  MFE ever >= 4 ATR (TP2): ${pc(recs.filter(r => r.mfe >= 4).length)}`)
  console.log(`  MFE ever >= 6 ATR: ${pc(recs.filter(r => r.mfe >= 6).length)}`)
  const reach = recs.filter(r => r.reachedBeforeStop)
  console.log(`  of the ${reach.length} that reached the scale: hit 4xATR (TP2) BEFORE touching BE: ${reach.filter(r => r.hit4beforeBE).length} (${(100 * reach.filter(r => r.hit4beforeBE).length / reach.length).toFixed(0)}%)`)
  for (const y of ['2025', '2026']) { const a = recs.filter(r => r.yr === y); if (!a.length) continue
    console.log(`  ${y}: n=${a.length}  >=2ATR ${(100 * a.filter(r => r.mfe >= 2).length / a.length).toFixed(0)}%  >=4ATR ${(100 * a.filter(r => r.mfe >= 4).length / a.length).toFixed(0)}%`) }
}
main()
