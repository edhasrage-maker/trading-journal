/**
 * Full-record .scid tick reader for the order-flow workspace. Node-only (fs).
 *
 * Unlike scid-reader.ts (trade price + volume only), this keeps every field
 * the order-flow port needs: ask (High) / bid (Low) at the trade, NumTrades for
 * the bubble study's single-trade tie rule, and bid / ask volume. Records with
 * zero volume are dropped, as the reference's load_ticks() does.
 *
 * Record (40 bytes, time-ascending): int64 µs since 1899-12-30 UTC · f32 Open ·
 * f32 High (ask) · f32 Low (bid) · f32 Close (trade) · u32 NumTrades ·
 * u32 TotalVolume · u32 BidVolume · u32 AskVolume.
 */
import { openSync, readSync, fstatSync, closeSync } from 'fs'
import type { TickFrame } from '../ticks'
import { sierraUsToUtcMinMs } from '../ticks'
import { ptOffsetMs } from '../pt-clock'

const HEADER = 56
const REC = 40

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
   * Trade records with startUs <= time < endUs and volume > 0, prices scaled
   * to index points. `ptMin` is filled with each trade's PT-clock minute.
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
    for (let r = 0; r < total; r++) if (u32[r * 10 + 7] > 0) n++
    const out: TickFrame = {
      n, us: new Float64Array(n), ptMin: new Float64Array(n), px: new Float64Array(n),
      hh: new Float64Array(n), ll: new Float64Array(n), v: new Uint32Array(n),
      bv: new Uint32Array(n), av: new Uint32Array(n), nt: new Uint32Array(n),
    }
    let j = 0
    let hourKey = NaN, off = 0
    for (let r = 0; r < total; r++) {
      const b = r * 10
      const v = u32[b + 7]
      if (v === 0) continue
      const us = u32[b] + i32[b + 1] * 4294967296
      out.us[j] = us
      out.px[j] = f32[b + 5]; out.hh[j] = f32[b + 3]; out.ll[j] = f32[b + 4]
      out.nt[j] = u32[b + 6]; out.v[j] = v; out.bv[j] = u32[b + 8]; out.av[j] = u32[b + 9]
      // PT-clock minute: UTC minute shifted by the PT offset (whole hours, cached per UTC hour)
      const utcMinMs = sierraUsToUtcMinMs(us)
      const hk = Math.floor(utcMinMs / 3_600_000)
      if (hk !== hourKey) { hourKey = hk; off = ptOffsetMs(utcMinMs) }
      out.ptMin[j] = utcMinMs + off
      j++
    }
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

  /**
   * High / low trade price (volume > 0) in [startUs, endUs), streamed in chunks
   * without building a tick frame — the prior-week range scans five sessions.
   * Same price scaling rule as read(), decided on the first chunk.
   */
  priceExtremes(startUs: number, endUs: number): { h: number | null; l: number | null } {
    const i0 = this.lowerBound(startUs), i1 = this.lowerBound(endUs)
    const CH = 1 << 20
    const ab = new ArrayBuffer(Math.min(CH, Math.max(0, i1 - i0)) * REC)
    const bytes = new Uint8Array(ab), u32 = new Uint32Array(ab), f32 = new Float32Array(ab)
    let h = -Infinity, l = Infinity, div = 0
    for (let i = i0; i < i1; i += CH) {
      const cnt = Math.min(CH, i1 - i)
      readSync(this.fd, bytes, 0, cnt * REC, HEADER + i * REC)
      if (div === 0) {
        const sample: number[] = []
        const step = Math.max(1, Math.floor(cnt / 4097))
        for (let r = 0; r < cnt; r += step) if (u32[r * 10 + 7] > 0) sample.push(f32[r * 10 + 5])
        sample.sort((a, b) => a - b)
        div = sample.length && sample[sample.length >> 1] > 100000 ? 100 : 1
      }
      for (let r = 0; r < cnt; r++) {
        if (u32[r * 10 + 7] === 0) continue
        const p = f32[r * 10 + 5]
        if (p > h) h = p
        if (p < l) l = p
      }
    }
    return h === -Infinity ? { h: null, l: null } : { h: h / div, l: l / div }
  }

  /** True if any trade (volume > 0) is stamped in [startUs, endUs). */
  hasTrade(startUs: number, endUs: number): boolean {
    let i = this.lowerBound(startUs)
    const buf = Buffer.alloc(REC)
    for (; i < this.count; i++) {
      readSync(this.fd, buf, 0, REC, HEADER + i * REC)
      const us = buf.readUInt32LE(0) + buf.readInt32LE(4) * 4294967296
      if (us >= endUs) return false
      if (buf.readUInt32LE(28) > 0) return true
    }
    return false
  }

  close() { closeSync(this.fd) }
}
