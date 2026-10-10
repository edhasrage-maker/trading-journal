/**
 * Where the snapshot builder gets its trades.
 *
 *  ScidTickSource — the local build: Sierra .scid files on this machine, front
 *    month per trading date from the shared roll table.
 *  TapeTickSource — the hosted build: the published tick tape (../tape.ts),
 *    already fetched and decoded into memory by the route.
 *
 * Both hand back the same tick frames, in file order, so buildSnapshot() is one
 * code path and the hosted charts are the local charts.
 */
import { join } from 'path'
import { contractFileForRoot } from '@/lib/futures-contracts'
import { ScidTickFile } from './scid-ticks'
import type { OfRoot, TickFrame } from '../ticks'
import { concatTicks, emptyTicks, utcMsToSierraUs } from '../ticks'
import { ptToUtcMs, tradingDate, ptMidnight, ptDate, PT_DAY_MS, PT_HOUR_MS } from '../pt-clock'
import { tapeChunkKey, type TapeIndex } from '../tape'

const HOUR = PT_HOUR_MS, DAY = PT_DAY_MS
const addDays = (date: string, n: number) => ptDate(ptMidnight(date) + n * DAY)
const usOfPt = (ptMs: number) => utcMsToSierraUs(ptToUtcMs(ptMs))

export interface TickSource {
  /** Trades (volume > 0) stamped in [startPt, endPt) PT-clock and before `endUsCap`, in file order. */
  readWindow(startPt: number, endPt: number, endUsCap: number): TickFrame
  /** Any trade in RTH (06:30–13:00 PT) on this trading date. */
  hasRthTrade(tdate: string): boolean
  /** Price of the first trade at/after `fromPt` (an hour boundary) and before `toPt`. */
  firstTradePrice(fromPt: number, toPt: number): number | null
  /** High / low of trading date `d`'s trades within [startPt, endPt) (hour boundaries). */
  extremes(d: string, startPt: number, endPt: number): { h: number | null; l: number | null }
  /** What the data came from (for the payload's `cut` proof). */
  names(): string[]
  close(): void
}

/** Most recent trading date before `tdate` with any RTH trade. */
export function priorRthDate(src: TickSource, tdate: string): string | null {
  for (let k = 1; k <= 14; k++) {
    const d = addDays(tdate, -k)
    if (src.hasRthTrade(d)) return d
  }
  return null
}

// ---------------------------------------------------------------- local .scid
// Settled history only, per process: prior-week extremes scan five sessions.
const extremesCache = new Map<string, { h: number | null; l: number | null }>()

export class ScidTickSource implements TickSource {
  private files = new Map<string, ScidTickFile | null>()
  constructor(private root: OfRoot, private dataDir: string) {}

  /** Front-month file for a trading date (null if out of table / missing). */
  private forTradingDate(tdate: string): ScidTickFile | null {
    const name = contractFileForRoot(this.root, tdate, this.dataDir)
    if (!name) return null
    if (!this.files.has(name)) {
      let f: ScidTickFile | null = null
      try { f = new ScidTickFile(join(this.dataDir, name)) } catch { f = null }
      this.files.set(name, f)
    }
    return this.files.get(name) ?? null
  }

  /** Split at trading-date boundaries onto each date's front month. */
  readWindow(startPt: number, endPt: number, endUsCap: number): TickFrame {
    const parts: TickFrame[] = []
    let d = tradingDate(startPt)
    const last = tradingDate(endPt - 1)
    while (d <= last) {
      const dStart = ptMidnight(d) - 9 * HOUR          // 15:00 PT the day before
      const dEnd = ptMidnight(d) + 15 * HOUR
      const s = Math.max(startPt, dStart), e = Math.min(endPt, dEnd)
      const f = s < e ? this.forTradingDate(d) : null
      if (f) parts.push(f.read(usOfPt(s), Math.min(usOfPt(e), endUsCap)))
      d = addDays(d, 1)
    }
    return parts.length ? concatTicks(parts) : emptyTicks()   // FILE order (may step backwards)
  }

  hasRthTrade(tdate: string): boolean {
    const f = this.forTradingDate(tdate)
    if (!f) return false
    return f.hasTrade(usOfPt(ptMidnight(tdate) + 6.5 * HOUR), usOfPt(ptMidnight(tdate) + 13 * HOUR))
  }

  firstTradePrice(fromPt: number, toPt: number): number | null {
    const f = this.forTradingDate(tradingDate(fromPt))
    if (!f) return null
    const t = f.read(usOfPt(fromPt), usOfPt(toPt), 4096)
    return t.n ? t.px[0] : null
  }

  extremes(d: string, startPt: number, endPt: number) {
    const s = Math.max(startPt, ptMidnight(d) - 9 * HOUR), e = Math.min(endPt, ptMidnight(d) + 15 * HOUR)
    const f = s < e ? this.forTradingDate(d) : null
    if (!f) return { h: null, l: null }
    const key = `${f.path}|${s}|${e}`
    const hit = extremesCache.get(key)
    if (hit) return hit
    const out = f.priceExtremes(usOfPt(s), usOfPt(e))
    if (endPt <= Date.now() - DAY) extremesCache.set(key, out)
    return out
  }

  names(): string[] { return [...this.files.entries()].filter(([, f]) => f).map(([k]) => k) }
  close() { for (const f of this.files.values()) f?.close() }
}

// ---------------------------------------------------------------- published tape
/** PT clock hours [startPt, endPt) as { ptDate, hour, startPt } entries. */
export function ptHours(startPt: number, endPt: number): { ptDate: string; hour: number; startPt: number }[] {
  const out: { ptDate: string; hour: number; startPt: number }[] = []
  for (let h = Math.floor(startPt / HOUR) * HOUR; h < endPt; h += HOUR) {
    out.push({ ptDate: ptDate(h), hour: new Date(h).getUTCHours(), startPt: h })
  }
  return out
}

export class TapeTickSource implements TickSource {
  /** `chunks`: decoded hour frames keyed by tapeChunkKey — only the window's hours are needed. */
  constructor(private root: OfRoot, private index: TapeIndex, private chunks: Map<string, TickFrame> = new Map()) {}

  private stat(ptDateStr: string, hour: number) {
    return this.index.days[ptDateStr]?.hours[String(hour).padStart(2, '0')] ?? null
  }

  /** Chunk keys that hold trades for [startPt, endPt) — what the route must fetch. */
  chunkKeys(startPt: number, endPt: number): string[] {
    return ptHours(startPt, endPt).filter(h => this.stat(h.ptDate, h.hour)).map(h => tapeChunkKey(this.root, h.ptDate, h.hour))
  }

  readWindow(startPt: number, endPt: number, endUsCap: number): TickFrame {
    const lo = usOfPt(startPt), hi = Math.min(usOfPt(endPt), endUsCap)
    const parts: TickFrame[] = []
    for (const h of ptHours(startPt, endPt)) {
      const t = this.chunks.get(tapeChunkKey(this.root, h.ptDate, h.hour))
      if (!t || !t.n) continue
      // whole hour inside the window: take it as is; edge hours are filtered by time
      let whole = true
      for (let i = 0; i < t.n; i++) if (t.us[i] < lo || t.us[i] >= hi) { whole = false; break }
      if (whole) { parts.push(t); continue }
      let n = 0
      for (let i = 0; i < t.n; i++) if (t.us[i] >= lo && t.us[i] < hi) n++
      const o: TickFrame = {
        n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n), hh: new Float64Array(n),
        ll: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
      }
      let j = 0
      for (let i = 0; i < t.n; i++) {
        if (t.us[i] < lo || t.us[i] >= hi) continue
        o.us[j] = t.us[i]; o.ptMin[j] = t.ptMin[i]; o.px[j] = t.px[i]; o.hh[j] = t.hh[i]; o.ll[j] = t.ll[i]
        o.v[j] = t.v[i]; o.bv[j] = t.bv[i]; o.av[j] = t.av[i]; o.nt[j] = t.nt[i]; j++
      }
      if (n) parts.push(o)
    }
    return parts.length ? concatTicks(parts) : emptyTicks()
  }

  hasRthTrade(tdate: string): boolean { return !!this.index.days[tdate]?.rth }

  firstTradePrice(fromPt: number, toPt: number): number | null {
    for (const h of ptHours(fromPt, toPt)) { const s = this.stat(h.ptDate, h.hour); if (s && s.n) return s.first }
    return null
  }

  extremes(d: string, startPt: number, endPt: number) {
    const s = Math.max(startPt, ptMidnight(d) - 9 * HOUR), e = Math.min(endPt, ptMidnight(d) + 15 * HOUR)
    let h: number | null = null, l: number | null = null
    if (s < e) for (const x of ptHours(s, e)) {
      const st = this.stat(x.ptDate, x.hour); if (!st || !st.n) continue
      if (h == null || st.hi > h) h = st.hi
      if (l == null || st.lo < l) l = st.lo
    }
    return { h, l }
  }

  names(): string[] { return [`tape:${this.root}`] }
  close() { /* nothing held open */ }
}
