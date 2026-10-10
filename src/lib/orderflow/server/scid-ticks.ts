/**
 * Full-record .scid tick reader for the order-flow workspace. Node-only (fs).
 *
 * Unlike scid-reader.ts (trade price + volume only), this keeps every field
 * the order-flow port needs: ask (High) / bid (Low) at the trade, NumTrades for
 * the bubble study's single-trade tie rule, and bid / ask volume.
 *
 * A record counts as a TRADE when its volume is > 0 and its price is > 0.
 * Zero-volume records are dropped as the reference's load_ticks() does. The
 * price test is ours, and deliberate: Sierra writes a marker record into these
 * files during the daily maintenance halt (14:45 PT most days: price 0,
 * volume 1). The reference keeps it, which gives a bar at price zero and a
 * "prior week low" of 0.00; scid-reader.ts skips it for the same reason.
 *
 * Record (40 bytes, time-ascending): int64 µs since 1899-12-30 UTC · f32 Open ·
 * f32 High (ask) · f32 Low (bid) · f32 Close (trade) · u32 NumTrades ·
 * u32 TotalVolume · u32 BidVolume · u32 AskVolume.
 */
import { openSync, readSync, fstatSync, closeSync } from 'fs'
import type { TickFrame } from '../ticks'
import { fillPtMinutes, floorDiv, SIERRA_EPOCH_OFFSET_US } from '../ticks'
import { ptOffsetMs } from '../pt-clock'

const HEADER = 56
const REC = 40
const HALF_HOUR_US = 1_800_000_000

/** A 30-minute bar. `utcMs` is the bucket start (30m buckets align in UTC and PT alike). */
export interface HalfHourBar { utcMs: number; o: number; h: number; l: number; c: number; v: number; bv: number; av: number }

export class ScidTickFile {
  readonly count: number
  private fd: number
  private probe = Buffer.alloc(8)

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r')
    const size = fstatSync(this.fd).size
    const hdr = Buffer.alloc(HEADER)
    readSync(this.fd, hdr, 0, HEADER, 0)
    if (size >= HEADER && hdr.toString('ascii', 0, 4) !== 'SCID') throw new Error(`${path}: not a SCID file`)
    const recSize = hdr.readUInt32LE(8) || REC
    if (recSize !== REC) throw new Error(`${path}: record size ${recSize}, expected ${REC}`)
    this.count = size >= HEADER + REC ? Math.floor((size - HEADER) / REC) : 0
  }

  /** Record time (Sierra µs) at index i. */
  timeAt(i: number): number {
    readSync(this.fd, this.probe, 0, 8, HEADER + i * REC)
    return this.probe.readUInt32LE(0) + this.probe.readInt32LE(4) * 4294967296
  }

  /** First record index with time >= us. */
  lowerBound(us: number): number {
    let lo = 0, hi = this.count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.timeAt(mid) < us) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Trades with startUs <= time < endUs, prices scaled to index points.
   * `ptMin` is filled with each trade's PT-clock minute.
   */
  read(startUs: number, endUs: number, maxRecords = Infinity): TickFrame {
    const i0 = this.lowerBound(startUs)
    const i1 = Math.min(this.lowerBound(endUs), i0 + maxRecords)
    const total = Math.max(0, i1 - i0)
    const ab = new ArrayBuffer(total * REC)
    const bytes = new Uint8Array(ab)
    const CHUNK = 1 << 26 // 64 MB per read call
    for (let off = 0; off < bytes.length; off += CHUNK) {
      readSync(this.fd, bytes, off, Math.min(CHUNK, bytes.length - off), HEADER + i0 * REC + off)
    }
    const u32 = new Uint32Array(ab), i32 = new Int32Array(ab), f32 = new Float32Array(ab)
    let n = 0
    for (let r = 0; r < total; r++) if (u32[r * 10 + 7] > 0 && f32[r * 10 + 5] > 0) n++
    const out: TickFrame = {
      n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n),
      hh: new Float64Array(n), ll: new Float64Array(n), v: new Uint32Array(n),
      bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
    }
    let j = 0
    for (let r = 0; r < total; r++) {
      const b = r * 10
      const v = u32[b + 7]
      if (v === 0 || !(f32[b + 5] > 0)) continue
      out.us[j] = u32[b] + i32[b + 1] * 4294967296
      out.px[j] = f32[b + 5]; out.hh[j] = f32[b + 3]; out.ll[j] = f32[b + 4]
      out.nt[j] = u32[b + 6]; out.v[j] = v; out.bv[j] = u32[b + 8]; out.av[j] = u32[b + 9]
      j++
    }
    fillPtMinutes(out.us, out.ptMin, n, ptOffsetMs)
    // Prices are stored scaled (x100 on these files). Same test as the reference:
    // divide when the median price is above 100,000. A sample settles it — real
    // values sit orders of magnitude from the boundary either way.
    if (n > 0) {
      const step = Math.max(1, Math.floor(n / 4097))
      const sample: number[] = []
      for (let k = 0; k < n; k += step) sample.push(out.px[k])
      sample.sort((a, b) => a - b)
      if (sample[sample.length >> 1] > 100000) {
        for (let k = 0; k < n; k++) { out.px[k] /= 100; out.hh[k] /= 100; out.ll[k] /= 100 }
      }
    }
    return out
  }

  /** Stream trades in [startUs, endUs) without building a frame. `div` = price divisor. */
  private scan(startUs: number, endUs: number, each: (us: number, px: number, v: number, bv: number, av: number) => void): number {
    const i0 = this.lowerBound(startUs), i1 = this.lowerBound(endUs)
    const CH = 1 << 20
    const ab = new ArrayBuffer(Math.min(CH, Math.max(0, i1 - i0)) * REC)
    const bytes = new Uint8Array(ab), u32 = new Uint32Array(ab), i32 = new Int32Array(ab), f32 = new Float32Array(ab)
    let div = 0
    for (let i = i0; i < i1; i += CH) {
      const cnt = Math.min(CH, i1 - i)
      readSync(this.fd, bytes, 0, cnt * REC, HEADER + i * REC)
      if (div === 0) {
        // same price scaling rule as read(), decided on the first chunk
        const sample: number[] = []
        const step = Math.max(1, Math.floor(cnt / 4097))
        for (let r = 0; r < cnt; r += step) if (u32[r * 10 + 7] > 0 && f32[r * 10 + 5] > 0) sample.push(f32[r * 10 + 5])
        sample.sort((a, b) => a - b)
        div = sample.length && sample[sample.length >> 1] > 100000 ? 100 : 1
      }
      for (let r = 0; r < cnt; r++) {
        const b = r * 10
        if (u32[b + 7] === 0 || !(f32[b + 5] > 0)) continue
        each(u32[b] + i32[b + 1] * 4294967296, f32[b + 5], u32[b + 7], u32[b + 8], u32[b + 9])
      }
    }
    return div || 1
  }

  /** High / low trade price in [startUs, endUs) — the prior-week range scans five sessions. */
  priceExtremes(startUs: number, endUs: number): { h: number | null; l: number | null } {
    let h = -Infinity, l = Infinity
    const div = this.scan(startUs, endUs, (_us, p) => { if (p > h) h = p; if (p < l) l = p })
    return h === -Infinity ? { h: null, l: null } : { h: h / div, l: l / div }
  }

  /** 30-minute OHLCV bars (trade prices, file order) for [startUs, endUs). */
  halfHourBars(startUs: number, endUs: number): HalfHourBar[] {
    const out: HalfHourBar[] = []
    const byKey = new Map<number, HalfHourBar>()
    const div = this.scan(startUs, endUs, (us, p, v, bv, av) => {
      const k = floorDiv(us - SIERRA_EPOCH_OFFSET_US, HALF_HOUR_US)
      let b = byKey.get(k)
      if (!b) { b = { utcMs: k * 1_800_000, o: p, h: p, l: p, c: p, v: 0, bv: 0, av: 0 }; byKey.set(k, b); out.push(b) }
      if (p > b.h) b.h = p
      if (p < b.l) b.l = p
      b.c = p; b.v += v; b.bv += bv; b.av += av
    })
    if (div !== 1) for (const b of out) { b.o /= div; b.h /= div; b.l /= div; b.c /= div }
    return out.sort((a, b) => a.utcMs - b.utcMs)
  }

  /** True if any trade is stamped in [startUs, endUs). */
  hasTrade(startUs: number, endUs: number): boolean {
    let i = this.lowerBound(startUs)
    const buf = Buffer.alloc(REC)
    for (; i < this.count; i++) {
      readSync(this.fd, buf, 0, REC, HEADER + i * REC)
      const us = buf.readUInt32LE(0) + buf.readInt32LE(4) * 4294967296
      if (us >= endUs) return false
      if (buf.readUInt32LE(28) > 0 && buf.readFloatLE(20) > 0) return true
    }
    return false
  }

  close() { closeSync(this.fd) }
}
