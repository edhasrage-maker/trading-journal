/**
 * The trade Score ("five facts", version flow-5) — order flow at the fill.
 *
 * A line-for-line port of the frozen research scorer
 * (NQ_backtest/xy_playbook/xy_grade_v3.py: ticks → bars → day_ctx → grade() →
 * g["facts"] / g["flow_total"], plus run()'s fill-time snap). PARITY WITH THAT
 * FILE IS THE CONTRACT: thresholds, wording and point values are not to be
 * changed here. scripts/test-flow-score-parity.ts checks it against the scores
 * the Python wrote.
 *
 * Pure: tick arrays in, score out. No I/O, no clock. The loader
 * (./server/flow-score-loader.ts) fetches the ticks and caches the per-session
 * numbers.
 *
 * Only what the five facts depend on is ported. Left out on purpose: the value
 * "frame" / ADR, the Risk / Target / Management sections, the 100-point
 * score + tier, and the control trades.
 *
 * TIME. Everything here is on the PT clock in MICROSECONDS ("PT µs": PT wall
 * time as if it were UTC epoch time), the unit the Python works in after
 * to_pt(). Ticks stay in FILE order — Sierra files can step back in time and
 * the Python reads them as they lie.
 *
 * NUMBERS. Python rounds halves to even, in round() and in format specs; JS
 * rounds them up. Every rounded or printed number goes through pymath.
 */
import type { TradeFlowFact } from '@/lib/supabase/types'
import type { TickFrame } from './ticks'
import { SIERRA_EPOCH_OFFSET_US, sierraUsToUtcMinMs } from './ticks'
import { pyRound, rint } from './pymath'

export { FLOW_VERSION, flowFingerprint, flowScoreIsCurrent } from './flow-score-meta'

export const US_MIN = 60_000_000
export const US_HOUR = 3_600_000_000
export const US_DAY = 86_400_000_000

// ── thresholds (a priori — copied from the Python, do not tune) ──────────────
const PB_MIN = 10            // "their attempt" = the counter-move since your side's last push, inside 10 minutes
const TEAM_BARS = 4          // 5m bars read for who is getting forward progress
const DEFEND_MIN = 15        // minutes before the fill searched for your side pushing price away from your entry
const OUT_K = 1.0            // outlier = ONE minute carrying a whole normal 5-minute bar of delta
const OUT_WINDOW = 30        // minutes of outliers that still count
const PROGRESS = 0.25        // forward progress: close-to-close >= 0.25x the median 5m range
const PUSH_MIN = 0.5         // a 5m bar counts as a push at >= 0.5x the normal 5m |delta|
const HEAVY = 1.5            // heavy effort: >= 1.5x normal 5m |delta|
const FLIP = 1.0             // delta your way since the turn >= 1x normal 5m |delta|
const VALUE_AREA = 0.70
const SD = { min_zone_atr: 0.075, min_expl_atr: 0.112, ext: 1.9, window: 15, lookback: 3, dominant: 0.7, dedup: 0.5 }
/** Points per fact (sum 100). */
const W = { who: 33, their: 22, answered: 22, reference: 16, pressing: 7 } as const

/**
 * "prior-week low" and Sierra's halt marker — a known difference in the INPUT,
 * not in the maths.
 *
 * The Python reads the raw .scid, which carries Sierra's maintenance-halt marker
 * (a record with price 0, volume 1, written at 14:45 PT on the Mon–Thu that
 * Sierra was running). When the prior week holds one, the marker lands in the
 * Python's profile and its "prior-week low" comes out as 0.00 — a reference
 * nothing can be near. When the week holds none, the Python has the true low.
 * The tick tape never carries the marker, so this port always has the true low.
 *
 * false (default): the plain port — the true prior-week low. Differs from the
 *   Python only for a trade taken AT last week's low in a week whose .scid had a
 *   marker (the Python then misses the level).
 * true: reproduce the marker weeks instead — the reference is pinned to 0.00, so
 *   it never counts. Differs from the Python in weeks without a marker.
 *
 * On the founder's 177 Python-graded trades of Jul 20 – Oct 13 2026 the plain
 * port matches all 177; pinning to 0.00 misses one (2026-07-29, a week with no
 * marker). Neither setting changes any of the 32 stored flow-4 scores.
 */
export const PRIOR_WEEK_LOW_HALT_MARKER_QUIRK = false

// ── ticks ────────────────────────────────────────────────────────────────────
/** Trade prints (volume > 0, trade price), file order. `t` = PT µs. */
export interface FlowTicks {
  n: number
  t: Float64Array
  px: Float64Array
  v: Uint32Array
  bv: Uint32Array
  av: Uint32Array
}

export function emptyFlowTicks(): FlowTicks {
  return { n: 0, t: new Float64Array(0), px: new Float64Array(0), v: new Uint32Array(0), bv: new Uint32Array(0), av: new Uint32Array(0) }
}

/** A tick frame (one tape hour, or a .scid read) as flow ticks. Frames already hold only real trades. */
export function flowTicksFromFrame(f: TickFrame): FlowTicks {
  const t = new Float64Array(f.n)
  // ptMin is the trade's PT-clock minute (ms); its distance from the UTC minute is the PT offset.
  for (let i = 0; i < f.n; i++) t[i] = f.us[i] - SIERRA_EPOCH_OFFSET_US + (f.ptMin[i] - sierraUsToUtcMinMs(f.us[i])) * 1000
  return { n: f.n, t, px: f.px, v: f.v, bv: f.bv, av: f.av }
}

export function concatFlowTicks(parts: FlowTicks[]): FlowTicks {
  const live = parts.filter(p => p.n > 0)
  if (live.length === 1) return live[0]
  const n = live.reduce((s, p) => s + p.n, 0)
  const out: FlowTicks = { n, t: new Float64Array(n), px: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n) }
  let o = 0
  for (const p of live) {
    out.t.set(p.t.subarray(0, p.n), o); out.px.set(p.px.subarray(0, p.n), o); out.v.set(p.v.subarray(0, p.n), o)
    out.bv.set(p.bv.subarray(0, p.n), o); out.av.set(p.av.subarray(0, p.n), o)
    o += p.n
  }
  return out
}

/** Boolean-mask selection, file order kept (numpy `x[mask]`). */
function pick(tk: FlowTicks, keep: (i: number) => boolean): FlowTicks {
  let n = 0
  for (let i = 0; i < tk.n; i++) if (keep(i)) n++
  if (n === tk.n) return tk
  const out: FlowTicks = { n, t: new Float64Array(n), px: new Float64Array(n), v: new Uint32Array(n), bv: new Uint32Array(n), av: new Uint32Array(n) }
  let j = 0
  for (let i = 0; i < tk.n; i++) {
    if (!keep(i)) continue
    out.t[j] = tk.t[i]; out.px[j] = tk.px[i]; out.v[j] = tk.v[i]; out.bv[j] = tk.bv[i]; out.av[j] = tk.av[i]; j++
  }
  return out
}

/** numpy searchsorted(side="left"): plain lower-bound bisection, also on a not-quite-sorted array. */
function searchsorted(a: ArrayLike<number>, n: number, x: number): number {
  let lo = 0, hi = n
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1)
    if (a[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ── Python semantics ─────────────────────────────────────────────────────────
/** Python `a or b` for a number that may be None: 0 and None are falsy, NaN is truthy. */
const pyOr = (a: number | null | undefined, b: number): number => (a == null || a === 0 ? b : a)
/** Python builtin max(a, b): `b if b > a else a` (so a NaN first argument wins). */
const pyMax = (a: number, b: number): number => (b > a ? b : a)
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0)

/** pandas Series.median(): NaN when empty; the mean of the two middle values on an even count. */
function median(xs: number[]): number {
  if (!xs.length) return NaN
  const a = Float64Array.from(xs).sort()
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** f"{x:.{nd}f}" — correctly rounded on the exact binary value, ties to even. */
function pyFixed(x: number, nd: number): string {
  return pyRound(x, nd).toFixed(nd)
}
/** f"{x:+.{nd}f}" — the sign of the VALUE is kept even when it prints as zero (and for -0.0). */
function pySignedFixed(x: number, nd: number): string {
  return (x < 0 || Object.is(x, -0) ? '-' : '+') + pyFixed(Math.abs(x), nd)
}
/** f"{x:,.0f}" */
function pyComma0(x: number): string {
  return pyFixed(x, 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
/** Python's "{:g}" for the two pressure lines (6.0 → "6", 6.4 → "6.4"). */
const pyG = (x: number): string => String(x)

const pad2 = (n: number) => String(n).padStart(2, '0')
/** strftime("%H:%M") / ("%H:%M:%S") of a PT µs instant. */
export function ptHm(tUs: number): string {
  const sod = Math.floor((((tUs % US_DAY) + US_DAY) % US_DAY) / 1_000_000)
  return `${pad2(Math.floor(sod / 3600))}:${pad2(Math.floor(sod / 60) % 60)}`
}
export function ptHms(tUs: number): string {
  const sod = Math.floor((((tUs % US_DAY) + US_DAY) % US_DAY) / 1_000_000)
  return `${ptHm(tUs)}:${pad2(sod % 60)}`
}

// ── bars ─────────────────────────────────────────────────────────────────────
/** OHLC + volume bars keyed by bucket start (PT µs), ascending. `d` = ask volume − bid volume. */
export interface FlowBars {
  n: number
  t: number[]
  o: number[]; h: number[]; l: number[]; c: number[]
  v: number[]; bv: number[]; av: number[]; d: number[]
}

/**
 * bars(): group ticks by floor(time / freq). Within a bucket the ticks keep
 * FILE order (open = first seen, close = last seen), as pandas groupby does.
 */
export function flowBars(tk: FlowTicks, freqUs: number): FlowBars {
  const at = new Map<number, number>()
  const b: FlowBars = { n: 0, t: [], o: [], h: [], l: [], c: [], v: [], bv: [], av: [], d: [] }
  let lastKey = NaN, j = -1
  for (let i = 0; i < tk.n; i++) {
    const key = Math.floor(tk.t[i] / freqUs) * freqUs
    if (key !== lastKey) {
      const hit = at.get(key)
      if (hit === undefined) {
        j = b.n++
        at.set(key, j)
        const p = tk.px[i]
        b.t.push(key); b.o.push(p); b.h.push(p); b.l.push(p); b.c.push(p); b.v.push(0); b.bv.push(0); b.av.push(0); b.d.push(0)
      } else j = hit
      lastKey = key
    }
    const p = tk.px[i]
    if (p > b.h[j]) b.h[j] = p
    if (p < b.l[j]) b.l[j] = p
    b.c[j] = p; b.v[j] += tk.v[i]; b.bv[j] += tk.bv[i]; b.av[j] += tk.av[i]
  }
  for (let k = 0; k < b.n; k++) b.d[k] = b.av[k] - b.bv[k]
  let sorted = true
  for (let k = 1; k < b.n; k++) if (b.t[k] < b.t[k - 1]) { sorted = false; break }
  if (sorted) return b
  const order = b.t.map((_, k) => k).sort((x, y) => b.t[x] - b.t[y])
  const re = (a: number[]) => order.map(k => a[k])
  return { n: b.n, t: re(b.t), o: re(b.o), h: re(b.h), l: re(b.l), c: re(b.c), v: re(b.v), bv: re(b.bv), av: re(b.av), d: re(b.d) }
}

/** 5-minute OHLC bars as plain columns — what the zones are built from, and what is cached per session. */
export interface Ohlc5 { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] }

/**
 * b1.resample("5min", label="left", closed="left").agg(first/max/min/last, d=sum).dropna():
 * the 1-minute bars folded into the 5-minute buckets that hold at least one of them.
 */
function resample5(b1: FlowBars): { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; d: number[] } {
  const out = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], d: [] as number[] }
  const F = 5 * US_MIN
  let j = -1
  for (let i = 0; i < b1.n; i++) {
    const key = Math.floor(b1.t[i] / F) * F
    if (j < 0 || out.t[j] !== key) {
      j = out.t.length
      out.t.push(key); out.o.push(b1.o[i]); out.h.push(b1.h[i]); out.l.push(b1.l[i]); out.c.push(b1.c[i]); out.d.push(0)
    }
    if (b1.h[i] > out.h[j]) out.h[j] = b1.h[i]
    if (b1.l[i] < out.l[j]) out.l[j] = b1.l[i]
    out.c[j] = b1.c[i]; out.d[j] += b1.d[i]
  }
  return out
}

// ── volume profile / low-volume areas ────────────────────────────────────────
export interface FlowProfile { poc: number; vah: number; val: number }

/** profile(): POC + 70% value area of a volume histogram whose bin i is price (i + k0) * row. */
export function profileOf(hist: ArrayLike<number>, k0: number, row: number): FlowProfile {
  const n = hist.length
  let poc = 0, tot = 0
  for (let i = 0; i < n; i++) { tot += hist[i]; if (hist[i] > hist[poc]) poc = i }   // argmax: first maximum
  let lo = poc, hi = poc, acc = hist[poc]
  while (acc < VALUE_AREA * tot && (lo > 0 || hi < n - 1)) {
    const up = hi < n - 1 ? hist[hi + 1] : -1
    const dn = lo > 0 ? hist[lo - 1] : -1
    if (up >= dn) { hi += 1; acc += hist[hi] } else { lo -= 1; acc += hist[lo] }
  }
  return { poc: (poc + k0) * row, vah: (hi + k0) * row, val: (lo + k0) * row }
}

/** lvns(): local minima of the smoothed histogram at or below a quarter of its peak. */
export function lvnsOf(hist: ArrayLike<number>, k0: number, row: number, smooth = 2, maxFrac = 0.25): number[] {
  const n = hist.length
  if (n < 10) return []
  const sm = new Float64Array(n)
  let peak = -Infinity
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - smooth), b = Math.min(n, i + smooth + 1)
    let s = 0
    for (let k = a; k < b; k++) s += hist[k]
    sm[i] = s / (b - a)
    if (sm[i] > peak) peak = sm[i]
  }
  const out: number[] = []
  for (let i = 3; i < n - 3; i++) {
    let mn = Infinity
    for (let k = i - 3; k < i + 4; k++) if (sm[k] < mn) mn = sm[k]
    if (sm[i] === mn && sm[i] <= maxFrac * peak) out.push((i + k0) * row)
  }
  return out
}

// ── 5m supply / demand zones ─────────────────────────────────────────────────
export interface FlowZone { type: 'demand' | 'supply'; high: number; low: number; confirmed: number; base_t: number; vi: number }

/**
 * find_zones(): a base candle followed by an explosive candle the other way,
 * valid once price extends 1.9x the base range within 15 bars. A zone only
 * exists from the close of the bar that validated it.
 */
export function findZones(b5: Ohlc5): FlowZone[] {
  const { o, h, l, c, t } = b5
  const n = t.length
  const atr = new Float64Array(n)
  let a = 0.0
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14
    atr[i] = a
  }
  const out: FlowZone[] = []
  for (let ci = 1; ci < n; ci++) {
    const bull = c[ci] > o[ci], bear = c[ci] < o[ci]
    if (!(bull || bear)) continue
    const rng = h[ci] - l[ci]
    if (rng < SD.min_expl_atr * atr[ci]) continue
    let base = -1
    for (let k = ci - 1; k >= Math.max(0, ci - SD.lookback); k--) {
      const opp = bull ? c[k] < o[k] : c[k] > o[k]
      const same = bull ? c[k] > o[k] : c[k] < o[k]
      if (opp) { base = k; break }
      if (same && h[k] - l[k] > SD.dominant * rng) break
    }
    if (base < 0) continue
    if (base !== ci - 1) {
      let against = false
      for (let k = base + 1; k < ci; k++) if (bull ? c[k] < o[k] : c[k] > o[k]) { against = true; break }
      if (against) continue
    }
    const zh = h[base], zl = l[base], zr = zh - zl
    if (zr <= 0 || zr < SD.min_zone_atr * atr[ci]) continue
    const req = bull ? zh + SD.ext * zr : zl - SD.ext * zr
    let v = -1, run = bull ? -Infinity : Infinity
    for (let k = ci; k <= Math.min(n - 1, ci + SD.window); k++) {
      run = bull ? Math.max(run, h[k]) : Math.min(run, l[k])
      if (bull ? run >= req : run <= req) { v = k; break }
    }
    if (v < 0) continue
    const z: FlowZone = { type: bull ? 'demand' : 'supply', high: zh, low: zl, confirmed: t[v] + 5 * US_MIN, base_t: t[base], vi: v }
    // An older zone only absorbs a new overlapping one while it is still standing. If a 5m close
    // already went through it by the time the new base candle closed, the new zone is a new zone.
    const standing = (q: FlowZone) => {
      for (let k = q.vi + 1; k <= base; k++) if (q.type === 'demand' ? c[k] < q.low : c[k] > q.high) return false
      return true
    }
    const dup = out.findIndex(q => q.type === z.type && Math.abs((q.base_t - z.base_t) / US_HOUR) < 12 && standing(q) &&
      Math.min(q.high, zh) - Math.max(q.low, zl) >= SD.dedup * Math.min(q.high - q.low, zr))
    if (dup >= 0) {
      if (zr > out[dup].high - out[dup].low) out[dup] = z
      continue
    }
    out.push(z)
  }
  return out
}

// ── per-session and per-week numbers (independent of the trade; cached by the loader) ──
/** sess_stats(): what later days reuse from one session (15:00 PT the day before → 13:00 PT). */
export interface FlowSessionStats {
  /** Lowest price row (price / scale, rounded half to even). */
  k0: number
  /** Volume per row from k0 up. */
  hist: number[]
  b5: Ohlc5
  /** RTH (06:30–13:00) high / low — absent when the session had no RTH trade. */
  hi?: number
  lo?: number
  /** Median |5m delta| of the first 90 RTH minutes. NaN when RTH traded but not before 08:00. */
  n5?: number
}

/** `tk` = the session's ticks [day − 9h, day + 13h), file order. `dayUs` = PT midnight (µs). null = no usable session. */
export function sessionStats(tk: FlowTicks, dayUs: number, scale: number): FlowSessionStats | null {
  if (tk.n < 1000) return null
  let k0 = Infinity, k1 = -Infinity
  for (let i = 0; i < tk.n; i++) { const k = rint(tk.px[i] / scale); if (k < k0) k0 = k; if (k > k1) k1 = k }
  const hist = new Array<number>(k1 - k0 + 1).fill(0)
  for (let i = 0; i < tk.n; i++) hist[rint(tk.px[i] / scale) - k0] += tk.v[i]
  const all5 = flowBars(tk, 5 * US_MIN)
  const out: FlowSessionStats = { k0, hist, b5: { t: all5.t, o: all5.o, h: all5.h, l: all5.l, c: all5.c } }
  const rth = pick(tk, i => tk.t[i] >= dayUs + 6.5 * US_HOUR)
  if (rth.n) {
    let hi = -Infinity, lo = Infinity
    for (let i = 0; i < rth.n; i++) { const p = rth.px[i]; if (p > hi) hi = p; if (p < lo) lo = p }
    out.hi = hi; out.lo = lo
    const f = flowBars(rth, 5 * US_MIN)
    const early: number[] = []
    for (let i = 0; i < f.n; i++) if (f.t[i] < dayUs + 8 * US_HOUR) early.push(Math.abs(f.d[i]))
    out.n5 = median(early)
  }
  return out
}

/** Prior-week profile (Sunday 15:00 PT → Friday 14:00 PT) and the week's opening print. */
export interface FlowWeekStats {
  /** First trade of this week's opening half hour (Sunday 15:00–15:30 PT). */
  weekOpen?: number
  priorWeek?: { high: number; low: number; close: number; poc: number; vah: number; val: number }
}

/** Streaming accumulator for the prior-week profile — a week of ticks need not sit in memory at once. */
export class WeekProfileBuilder {
  private rows = new Map<number, number>()
  private n = 0
  private hi = -Infinity
  private lo = Infinity
  private last = NaN
  constructor(private scale: number) {}
  /** Feed ticks in file order. */
  add(tk: FlowTicks) {
    for (let i = 0; i < tk.n; i++) {
      const p = tk.px[i], k = rint(p / this.scale)
      this.rows.set(k, (this.rows.get(k) ?? 0) + tk.v[i])
      if (p > this.hi) this.hi = p
      if (p < this.lo) this.lo = p
    }
    if (tk.n) { this.n += tk.n; this.last = tk.px[tk.n - 1] }
  }
  /** undefined unless the week holds more than 1,000 trades (the Python's floor). */
  finish(): FlowWeekStats['priorWeek'] {
    if (!(this.n > 1000)) return undefined
    let k0 = Infinity, k1 = -Infinity
    for (const k of this.rows.keys()) { if (k < k0) k0 = k; if (k > k1) k1 = k }
    const hist = new Float64Array(k1 - k0 + 1)
    for (const [k, v] of this.rows) hist[k - k0] = v
    const w = profileOf(hist, k0, this.scale)
    return { high: this.hi, low: this.lo, close: this.last, poc: w.poc, vah: w.vah, val: w.val }
  }
}

/** day_ctx() minus today's own ticks: everything about the session that does not depend on the trade. */
export interface FlowDayContext {
  /** 4 for NQ, 1 for ES — tolerances and profile rows scale by it. */
  scale: number
  /** PT midnight of the session date (µs). */
  day: number
  /** References fixed before the session: prior day high/low, 5-day low-volume areas, week open, prior-week levels. */
  refs: Record<string, number>
  /** Yesterday's normal 5m |delta| (first 90 RTH minutes). null when there is none. */
  n5Prior: number | null
  /** Three prior sessions of 5m bars, oldest first — zones older than today. null when no prior session. */
  priorB5: Ohlc5 | null
}

export const flowScale = (root: 'NQ' | 'ES'): number => (root === 'NQ' ? 4.0 : 1.0)

/**
 * `sessions`: the most recent prior sessions that have data, NEWEST first — the
 * Python walks back up to 25 calendar days over weekdays and skips sessions with
 * under 1,000 trades. Five are enough for everything the facts read.
 */
export function buildDayContext(dayUs: number, scale: number, sessions: FlowSessionStats[], week: FlowWeekStats): FlowDayContext {
  const refs: Record<string, number> = {}
  let n5Prior: number | null = null
  let priorB5: Ohlc5 | null = null
  if (sessions.length) {
    const s0 = sessions[0]
    if (s0.hi !== undefined && s0.lo !== undefined) { refs['prior day high'] = s0.hi; refs['prior day low'] = s0.lo }
    n5Prior = s0.n5 === undefined ? null : s0.n5
    const three = sessions.slice(0, 3).reverse()
    priorB5 = { t: [], o: [], h: [], l: [], c: [] }
    for (const st of three) {
      priorB5.t.push(...st.b5.t); priorB5.o.push(...st.b5.o); priorB5.h.push(...st.b5.h); priorB5.l.push(...st.b5.l); priorB5.c.push(...st.b5.c)
    }
    const five = sessions.slice(0, 5)
    const k0 = Math.min(...five.map(st => st.k0)), k1 = Math.max(...five.map(st => st.k0 + st.hist.length))
    const h5 = new Float64Array(k1 - k0)
    for (const st of five) for (let i = 0; i < st.hist.length; i++) h5[st.k0 - k0 + i] += st.hist[i]
    for (const p of lvnsOf(h5, k0, scale)) refs[`5-day low-volume area ${pyFixed(p, 0)}`] = p
  }
  if (week.weekOpen !== undefined) refs['week open'] = week.weekOpen
  if (week.priorWeek) {
    const w = week.priorWeek
    refs['prior-week high'] = w.high
    refs['prior-week low'] = PRIOR_WEEK_LOW_HALT_MARKER_QUIRK ? 0.0 : w.low
    refs['prior-week close'] = w.close
    refs['prior-week POC'] = w.poc; refs['prior-week VAH'] = w.vah; refs['prior-week VAL'] = w.val
  }
  return { scale, day: dayUs, refs, n5Prior, priorB5 }
}

// ── the fill ─────────────────────────────────────────────────────────────────
/** The Python only scores fills in the day session: 06:30 ≤ PT time < 13:00. */
export function inDaySession(ePtUs: number): boolean {
  const tod = (ePtUs - Math.floor(ePtUs / US_DAY) * US_DAY) / US_MIN
  return tod >= 390 && tod < 780
}

/**
 * run()'s time fix: a journal time rounded to the minute (zero seconds) is moved
 * to the first trade at the entry price (within one tick) inside that minute.
 */
export function snapEntry(ePtUs: number, entryPrice: number, day: FlowTicks): { e: number; fixed: boolean } {
  if (ePtUs % US_MIN !== 0) return { e: ePtUs, fixed: false }
  for (let i = 0; i < day.n; i++) {
    if (day.t[i] >= ePtUs && day.t[i] < ePtUs + US_MIN && Math.abs(day.px[i] - entryPrice) <= 0.25) return { e: day.t[i], fixed: true }
  }
  return { e: ePtUs, fixed: false }
}

export class FlowNotScorable extends Error {}

export interface FlowTrade {
  /** The fill, PT µs — after snapEntry(). */
  e: number
  sgn: 1 | -1
  px: number
}

export interface FlowGrade {
  facts: TradeFlowFact[]
  total: number
  /** HH:MM:SS PT of the fill the tape was read at. */
  read_at: string
  /** The intermediate reads, for the parity test and debugging. Not stored. */
  detail: Record<string, unknown>
}

interface OutlierEv { t: number; side: number; d: number; price: number; under: boolean }

/**
 * grade(): the five facts for one fill.
 * `day` = the session's ticks from 15:00 PT the day before, file order; only
 * prints stamped BEFORE the fill are read.
 */
export function gradeFlow(x: FlowTrade, day: FlowTicks, ctx: FlowDayContext): FlowGrade {
  const s = x.sgn, long = s > 0, e = x.e, scale = ctx.scale
  const rth0 = ctx.day + 6.5 * US_HOUR
  const tk = pick(day, i => day.t[i] < e)
  if (!tk.n) throw new FlowNotScorable('no trades on the tape before the fill')
  const { t: tt, px } = tk
  const b1 = flowBars(tk, US_MIN)
  const last = px[tk.n - 1]
  // ATR(1m, 10) over completed bars; the first bar's true range is its own range
  const tr = (i: number) => (i === 0 ? b1.h[0] - b1.l[0] : Math.max(b1.h[i], b1.c[i - 1]) - Math.min(b1.l[i], b1.c[i - 1]))
  const eMin = Math.floor(e / US_MIN) * US_MIN
  const nDone1 = b1.t[b1.n - 1] === eMin ? b1.n - 1 : b1.n              // completed 1m bars
  let atr = NaN
  if (nDone1 > 0) {
    const a = Math.max(0, nDone1 - 10)
    let sum = 0
    for (let i = a; i < nDone1; i++) sum += tr(i)
    atr = sum / (nDone1 - a)
  }
  const tol = pyMax(0.25 * atr, 1.0 * scale)
  const b5 = resample5(b1)
  let nDone5 = b5.t.length
  while (nDone5 > 0 && !(b5.t[nDone5 - 1] + 5 * US_MIN <= e)) nDone5--     // completed 5m bars (sorted, so a suffix is cut)
  const absD = (from: number, to: number) => { const a: number[] = []; for (let i = from; i < to; i++) a.push(Math.abs(b5.d[i])); return a }
  let rthFrom = 0
  while (rthFrom < nDone5 && b5.t[rthFrom] < rth0) rthFrom++
  // a normal 5-minute |delta|: today's RTH bars once there are 3, else yesterday's first 90 minutes
  let n5 = nDone5 - rthFrom >= 3
    ? median(absD(rthFrom, nDone5))
    : (ctx.n5Prior == null || ctx.n5Prior === 0 ? median(absD(Math.max(0, nDone5 - 12), nDone5)) : ctx.n5Prior)
  n5 = pyOr(n5, 1.0)
  const them = long ? 'sellers' : 'buyers', us_ = long ? 'buyers' : 'sellers'

  // ── references on his chart, as they stood at the fill ───────────────────
  const refs: Record<string, number> = { ...ctx.refs }
  {
    let onHi = -Infinity, onLo = Infinity, sawOn = false, lon: number | undefined
    for (let i = 0; i < day.n; i++) {
      const p = day.px[i]
      if (day.t[i] < rth0) { sawOn = true; if (p > onHi) onHi = p; if (p < onLo) onLo = p }
      if (lon === undefined && day.t[i] >= ctx.day) lon = p
    }
    if (sawOn) { refs['overnight high'] = onHi; refs['overnight low'] = onLo }
    if (lon !== undefined) refs['London open'] = lon
  }
  let anyRth = false
  {
    let open: number | undefined, ibh = -Infinity, ibl = Infinity, sawIb = false
    const ibEnd = ctx.day + 7.5 * US_HOUR
    for (let i = 0; i < tk.n; i++) {
      if (tt[i] < rth0) continue
      if (open === undefined) open = px[i]
      if (tt[i] < ibEnd) { sawIb = true; if (px[i] > ibh) ibh = px[i]; if (px[i] < ibl) ibl = px[i] }
    }
    if (open !== undefined) {
      anyRth = true
      if (!sawIb) throw new FlowNotScorable('no trade inside the initial balance hour before the fill')
      refs['Open'] = open
      refs['IB high'] = ibh; refs['IB low'] = ibl
      if (e >= ibEnd) { refs['IB +50%'] = ibh + 0.5 * (ibh - ibl); refs['IB -50%'] = ibl - 0.5 * (ibh - ibl) }
    }
  }
  {
    let pv = 0, vv = 0
    for (let i = 0; i < tk.n; i++) { pv += px[i] * tk.v[i]; vv += tk.v[i] }
    refs['VWAP'] = pv / vv
  }
  const near = (p: number): string | null => {
    let best: string | null = null, bestD = Infinity
    for (const k of Object.keys(refs)) {
      const d = Math.abs(refs[k] - p)
      if (d < bestD || (d === bestD && best !== null && k < best)) { best = k; bestD = d }
    }
    return best !== null && bestD <= tol ? best : null
  }

  // ── WHO IS GETTING FORWARD PROGRESS (last 4 five-minute bars) ────────────
  const ranges: number[] = []
  for (let i = Math.max(0, nDone5 - 12); i < nDone5; i++) ranges.push(b5.h[i] - b5.l[i])
  const rng5 = pyOr(median(ranges), atr)
  const rec = { b_rew: 0, b_fail: 0, s_rew: 0, s_fail: 0 }
  const n5b = b5.t.length
  for (let i = Math.max(1, n5b - TEAM_BARS); i < n5b; i++) {                // includes the bar in progress — he reads it live
    const d = b5.d[i]
    if (Math.abs(d) < PUSH_MIN * n5 || b5.t[i] < rth0) continue
    const move = (b5.c[i] - b5.c[i - 1]) * sign(d)                          // close-to-close, in the push's direction
    const ok = move >= PROGRESS * rng5
    if (d > 0) rec[ok ? 'b_rew' : 'b_fail'] += 1
    else rec[ok ? 's_rew' : 's_fail'] += 1
  }
  const win = rec.b_rew >= 2 && rec.b_rew > rec.s_rew ? 1 : rec.s_rew >= 2 && rec.s_rew > rec.b_rew ? -1 : 0

  // ── THEIR ATTEMPT: the pullback against you right before the fill ────────
  // Tick level: the last push your way inside PB_MIN minutes, then the furthest price traded
  // against you since it. That counter-move is "their attempt"; its extreme is "their price".
  const w = pick(tk, i => tt[i] >= e - PB_MIN * US_MIN)
  if (!w.n) throw new FlowNotScorable('no trades in the 10 minutes before the fill')
  let pi = 0
  for (let i = 0; i < w.n; i++) if (s * w.px[i] >= s * w.px[pi]) pi = i     // last tick at the push extreme
  let xi = pi
  for (let i = pi; i < w.n; i++) if (s * w.px[i] <= s * w.px[xi]) xi = i    // last tick at their extreme
  const ext = w.px[xi], extT = w.t[xi]
  const minsSince = (e - extT) / US_MIN
  let theirSum = 0, flipSum = 0
  for (let i = pi; i <= xi; i++) theirSum += -s * (w.av[i] - w.bv[i])
  for (let i = xi + 1; i < w.n; i++) flipSum += s * (w.av[i] - w.bv[i])
  const their = theirSum / n5                                               // effort against you, in normal-5m units
  const flip = flipSum / n5                                                 // delta your way since their extreme
  const retrace = s * (last - ext)
  const through = retrace >= 0.5 * atr                                      // traded back through them
  const held = minsSince >= 2 && flip > 0                                   // no continuation, delta against them
  const extMin = Math.floor(extT / US_MIN) * US_MIN
  const ei = Math.max(0, searchsorted(b1.t, b1.n, extMin))

  // ── OUTLIER DELTA, and whether price is now above or below it ────────────
  // An outlier = a 1m bar whose delta is >= a whole normal 5-minute bar. Its price = where that
  // aggression traded (volume-weighted). Under water = price is now on the wrong side of it.
  const uw = pyMax(0.1 * atr, 0.5)
  const ev: OutlierEv[] = []
  for (let bi = 0; bi < b1.n; bi++) {
    const ts = b1.t[bi]
    if (!(ts >= e - OUT_WINDOW * US_MIN)) continue
    const d = b1.d[bi]
    if (Math.abs(d) < OUT_K * n5) continue
    const lo = searchsorted(tt, tk.n, ts), hi = searchsorted(tt, tk.n, ts + US_MIN)
    const vol = d > 0 ? tk.av : tk.bv
    let vs = 0, pvs = 0
    for (let i = lo; i < hi; i++) { vs += vol[i]; pvs += px[i] * vol[i] }
    if (vs <= 0) continue
    const price = pvs / vs
    const under = d > 0 ? last < price - uw : last > price + uw
    ev.push({ t: ts, side: sign(d), d, price, under })
  }
  let stuckThem = 0, stuckUs = 0
  for (const v of ev) {
    if (v.side === -s && v.under) stuckThem += Math.abs(v.d)
    if (v.side === s && v.under) stuckUs += Math.abs(v.d)
  }
  stuckThem /= n5; stuckUs /= n5
  const theirs = ev.filter(v => v.side === -s)                               // their real efforts, oldest first
  const trap = theirs.length && theirs[theirs.length - 1].under ? theirs[theirs.length - 1] : null   // their LAST real effort is now under water
  const sinceT = trap ? trap.t : extMin
  const answer = ev.filter(v => v.side === s && v.t >= sinceT && !v.under)   // your side stepping in after, still holding
  const oursLast = ev.length > 0 && ev[ev.length - 1].side === s && !ev[ev.length - 1].under   // the last real effort on the tape is yours and holding

  // reversal evidence: their heaviest recent 5m effort got no extension, then delta flipped
  let heavyV = 0.0
  if (nDone5 > 0) {
    let mx = -Infinity
    for (let i = Math.max(0, nDone5 - 3); i < nDone5; i++) { const q = -s * b5.d[i]; if (q > mx) mx = q }
    heavyV = mx / n5
  }
  let priorExt = ext
  {
    const a = Math.max(0, ei - 45), b = Math.max(0, ei - 5)
    if (b > a) {
      let m = long ? Infinity : -Infinity
      for (let i = a; i < b; i++) m = long ? Math.min(m, b1.l[i]) : Math.max(m, b1.h[i])
      priorExt = m
    }
  }
  const extension = s * (priorExt - ext)                                    // + = they pushed past the earlier extreme
  const unrewarded = extension <= atr
  const reversal = heavyV >= HEAVY && unrewarded && flip >= FLIP

  // ── DIRECTION: only the forward-progress points feed the facts ───────────
  let team: number
  if (win === s) team = 15
  else if (win === -s && reversal) team = 12
  else if (win === -s) team = 0
  else if (stuckThem >= 1 && stuckThem >= 1.5 * stuckUs) team = 12
  else if (stuckUs >= 1 && stuckUs >= 1.5 * stuckThem) team = 4
  else team = 8

  // ── SETUP: A (their attempt failed), B (your side answered), D (at a reference) ──
  const kind = win === s ? 'continuation' : reversal ? 'reversal' : 'none'
  let sA: number
  if (trap) sA = 10
  else if (theirs.length && through) sA = 4
  else if (theirs.length) sA = 0
  else if (through) sA = 10
  else if (held) sA = 10
  else if (minsSince >= 2) sA = 3
  else sA = 0
  let sB: number
  if (answer.length) sB = 10
  else if (flip >= FLIP) sB = 10
  else if (kind === 'continuation' && oursLast) sB = 10
  else if (flip >= 0.5 * FLIP) sB = 5
  else sB = 0
  let ref: string | null = near(ext) ?? near(x.px)
  // The trader's own 5m supply/demand zones count as key levels too: an unbroken zone on the
  // right side (supply for a short, demand for a long), built only from 5m bars closed before the fill.
  const all5 = mergeOhlc5(ctx.priorB5, { t: b5.t.slice(0, nDone5), o: b5.o.slice(0, nDone5), h: b5.h.slice(0, nDone5), l: b5.l.slice(0, nDone5), c: b5.c.slice(0, nDone5) })
  // The 5-minute 9 EMA counts as a key level too (founder, 2026-10-25: "it should technically be
  // a level"): its value on the last 5m bar closed before the fill, on the same 5m bars as the
  // zones. Checked only when no fixed level is near; a zone still wins. (xy_grade_v3.py, flow-5.)
  if (!ref && all5.t.length) {
    const ema9 = ewmLast(all5.c, 9)
    if ([ext, x.px].some(p => Math.abs(ema9 - p) <= tol)) ref = '5m 9 EMA'
  }
  let zone: FlowZone | null = null
  for (const z of findZones(all5)) {
    if (z.type !== (long ? 'demand' : 'supply') || z.confirmed > e) continue
    let gone = false
    for (let i = searchsorted(all5.t, all5.t.length, z.confirmed); i < all5.t.length; i++) {
      if (long ? all5.c[i] < z.low : all5.c[i] > z.high) { gone = true; break }   // a 5m close through it: gone
    }
    if (gone) continue
    if ([ext, x.px].some(p => z.low - tol <= p && p <= z.high + tol)) zone = z
  }
  if (zone) ref = `5m ${zone.type} zone`
  // "Had your side stepped in?" — second way to say yes (the trader's definition): in the 15 minutes
  // before the fill your side PUSHED PRICE AWAY from where you are entering.
  //   size      net delta your way >= a normal 5-minute bar across two consecutive minutes
  //   location  the push started within reach of your entry price, or inside the zone you are trading
  //   effect    price moved your way by at least half an ATR during it
  const defended: number[] = []
  let w15 = 0
  while (w15 < b1.n && b1.t[w15] < eMin - DEFEND_MIN * US_MIN) w15++
  for (let i = w15; i < b1.n - 1; i++) {
    if (s * b1.d[i] + s * b1.d[i + 1] < n5) continue
    const start = long ? Math.min(b1.l[i], b1.l[i + 1]) : Math.max(b1.h[i], b1.h[i + 1])   // where the push started
    const atEntry = Math.abs(start - x.px) <= tol
    const inZone = !!zone && zone.low - tol <= start && start <= zone.high + tol
    if (!(atEntry || inZone)) continue
    if (s * (b1.c[i + 1] - start) < 0.5 * atr) continue
    if (!defended.length || b1.t[i] - defended[defended.length - 1] >= 2 * US_MIN) defended.push(b1.t[i])
  }
  if (defended.length && sB < 10) sB = 10
  const defendedHm = defended.map(ptHm)
  const sD = ref ? 7 : 0

  // Tape reader, exactly as the trader's study draws it (1-minute chart): per bar, ask share of
  // the last 8 bars minus 50; the last bar is the one forming at the fill.
  const dom = new Float64Array(b1.n)
  for (let i = 0; i < b1.n; i++) {
    let ra = 0, rb = 0
    for (let k = Math.max(0, i - 7); k <= i; k++) { ra += b1.av[k]; rb += b1.bv[k] }
    const q = (ra / (ra + rb)) * 100 - 50
    dom[i] = Number.isNaN(q) ? 0.0 : Math.min(50, Math.max(-50, q))
  }
  const domLast = dom[b1.n - 1]
  const tape = pyRound(s * domLast, 2)                                      // + = your way
  // Persistence border: at least 3 of the last 5 bars at pressure, in the current bar's direction.
  const press = scale === 4 ? 6.0 : 6.4, dead = scale === 4 ? 2.0 : 2.1
  const curDir = sign(domLast)
  let nPress = 0
  for (let i = Math.max(0, b1.n - 5); i < b1.n; i++) {
    if (curDir > 0 ? dom[i] >= press : curDir < 0 ? dom[i] <= -press : false) nPress++
  }
  const per = nPress < 3 ? 0 : s * curDir * nPress                          // +n your way, -n against you

  // ── THE FIVE FACTS (what the product shows): points out of 100, a state, one plain line ──
  type St = TradeFlowFact['state']
  const cap = (z: string) => z.charAt(0).toUpperCase() + z.slice(1)
  const Us = cap(us_), Them = cap(them)                                     // "Sellers", "Buyers"
  const ourAct = long ? 'buying' : 'selling', theirAct = long ? 'selling' : 'buying'
  const ourWay = long ? 'up' : 'down', theirWay = long ? 'down' : 'up'
  const theirTurn = long ? 'low' : 'high'                                   // the extreme their push made
  const where = (v: OutlierEv) => `at ${pyComma0(v.price)} (${ptHm(v.t)})`
  const pushes = (nOk: number, nBad: number, way: string) =>
    nBad === 0 ? `Their last ${nOk} pushes moved price ${way}.` : `${nOk} of their last ${nOk + nBad} pushes moved price ${way}.`
  const [rw, rf] = win === 1 ? [rec.b_rew, rec.b_fail] : [rec.s_rew, rec.s_fail]
  let who: [St, string]
  if (win === s) who = ['with', `${Us}. ${pushes(rw, rf, ourWay)}`]
  else if (win === -s && reversal) who = ['with', `${Them} had been, but their biggest push went nowhere and ${us_} took over.`]
  else if (win === -s) who = ['against', `${Them}. ${pushes(rw, rf, theirWay)}`]
  else if (team === 12) who = ['with', `Nobody clearly, but big ${them} were losing.`]
  else if (team === 4) who = ['against', `Nobody clearly, and big ${us_} were losing.`]
  else who = ['neutral', 'Nobody clearly.']
  let th: [St, string]
  if (trap) th = ['with', `Yes. Heavy ${theirAct} ${where(trap)} was losing: price had moved back ${ourWay} through it.`]
  else if (theirs.length) th = ['against', `No. Heavy ${theirAct} ${where(theirs[theirs.length - 1])} was still in profit.`]
  else if (through) th = ['with', `There were no big ${them}. Their push was weak and had already failed.`]
  else if (held) th = ['with', `There were no big ${them}. Their push had stalled for ${pyFixed(minsSince, 0)} min.`]
  else if (minsSince >= 2) th = ['neutral', `There were no big ${them}. Their ${theirTurn} had held ${pyFixed(minsSince, 0)} min, but nothing had pushed back yet.`]
  else th = ['against', `No. The ${them} had not failed yet when you got in.`]
  let an: [St, string]
  if (answer.length) an = ['with', `Yes. Heavy ${ourAct} ${where(answer[answer.length - 1])}, still in profit.`]
  else if (flip >= FLIP) an = ['with', `Yes. ${cap(ourAct)} had picked up since the ${them}' ${theirTurn}.`]
  else if (kind === 'continuation' && oursLast) an = ['with', `Yes. The most recent heavy trading was ${ourAct}, and it was still in profit.`]
  else if (defended.length) {
    const place = zone ? 'this zone' : ref ? 'this level' : 'this price'
    an = ['with', `Yes. ${Us} pushed price ${ourWay} from ${place} at ${defendedHm.slice(-2).join(' and ')}.`]
  }
  else if (flip >= 0.5 * FLIP) an = ['neutral', `Partly. Some ${ourAct} since the ${them}' ${theirTurn}, but not much.`]
  else if (stuckUs >= 1) an = ['against', `No. Recent heavy ${ourAct} was losing.`]
  else an = ['neutral', 'Not yet.']
  let nice: string | null
  if (zone) nice = `a 5-minute ${zone.type} zone (${pyComma0(zone.low)}–${pyComma0(zone.high)})`
  else if (ref && ref.startsWith('5-day low-volume area')) nice = `a thin-volume area from the last 5 days (${pyComma0(Number(ref.split(' ').pop()))})`
  else nice = ref ? (NICE[ref] ?? ref) : null
  const rfFact: [St, string] = ref ? ['with', `Yes. At ${nice}.`] : ['neutral', 'No. None nearby.']
  // Fifth fact = the trader's own tape reader (ask share of the last 8 one-minute bars minus 50).
  // Fading it means the study's PRESSURE line against you (6.0 on NQ, 6.4 on ES). Below that it
  // is only a lean; inside the neutral band (2.0 / 2.1) it is neutral.
  const fading = tape <= -press
  let pr: [St, string]
  if (fading) {
    pr = ['against', `Yes. The tape reader showed ${theirAct} pressure against you (${pyFixed(Math.abs(tape), 1)}, pressure starts at ${pyG(press)})`
      + (per < 0 ? `, sustained for ${-per} of the last 5 minutes.` : '.')]
  } else if (tape <= -dead) {
    pr = ['neutral', `No. The tape leaned ${pyFixed(Math.abs(tape), 1)} against you, short of pressure (${pyG(press)})`
      + (per < 0 ? `, though pressure against you held for ${-per} of the last 5 minutes.` : '.')]
  } else if (tape >= dead) {
    pr = ['with', `No. The tape reader was ${pyFixed(tape, 1)} your way` + (per > 0 ? `, sustained for ${per} of the last 5 minutes.` : '.')]
  } else pr = ['with', `No. The tape reader was neutral (${pySignedFixed(tape, 1)}).`]

  const pts = {
    who: pyRound((team / 15) * W.who), their: pyRound((sA / 10) * W.their), answered: pyRound((sB / 10) * W.answered),
    reference: pyRound((sD / 7) * W.reference), pressing: fading ? 0 : W.pressing,
  }
  const labels = {
    who: 'Who was in control?', their: `Were big ${them} trapped?`, answered: `Had ${us_} stepped in?`,
    reference: 'At a key level?', pressing: 'Fading the tape?',
  }
  const order = ['who', 'their', 'answered', 'reference', 'pressing'] as const
  const body: Record<(typeof order)[number], [St, string]> = { who, their: th, answered: an, reference: rfFact, pressing: pr }
  const facts: TradeFlowFact[] = order.map(k => ({ k, label: labels[k], pts: pts[k], max: W[k], state: body[k][0], text: body[k][1] }))
  const total = pts.who + pts.their + pts.answered + pts.reference + pts.pressing

  return {
    facts, total, read_at: ptHms(e),
    detail: {
      atr: pyRound(atr, 2), normal5: pyRound(n5), anyRth,
      team: `buyers ${rec.b_rew} rewarded / ${rec.b_fail} not · sellers ${rec.s_rew} rewarded / ${rec.s_fail} not`,
      winner: win === 1 ? 'buyers' : win === -1 ? 'sellers' : 'neither',
      pullback: ext, pullback_time: ptHms(extT), mins_since: pyRound(minsSince, 1),
      their_effort: pyRound(their, 2), flip: pyRound(flip, 2), retrace_atr: pyRound(retrace / atr, 2), failed: through || held,
      outliers: ev.map(v => ({ time: ptHm(v.t), delta: pyRound(v.d), price: pyRound(v.price, 2), under_water: v.under })),
      stuck_them: pyRound(stuckThem, 2), stuck_us: pyRound(stuckUs, 2),
      heavy: pyRound(heavyV, 2), extension: pyRound(extension, 2), reversal_evidence: reversal,
      zone: zone ? { type: zone.type, low: zone.low, high: zone.high, formed: zone.base_t } : null,
      defended: defendedHm, sA, sB, sD, team_pts: team, setup_kind: kind, ref,
      tape, tape_persist: per, refs,
    },
  }
}

/** pd.concat([prior, today]) → drop duplicate times keeping the last → sort by time. */
/** pandas `Series.ewm(span=span, adjust=False).mean().iloc[-1]`, operation for operation
 *  (pandas' ewma loop with no missing values), so it lands on the same float as the Python. */
function ewmLast(v: readonly number[], span: number): number {
  const com = (span - 1) / 2.0
  const alpha = 1.0 / (1.0 + com)
  const oldWtFactor = 1.0 - alpha
  let w = v[0]
  for (let i = 1; i < v.length; i++) {
    const cur = v[i]
    if (w !== cur) w = ((oldWtFactor * w) + (alpha * cur)) / (oldWtFactor + alpha)
  }
  return w
}

function mergeOhlc5(prior: Ohlc5 | null, today: Ohlc5): Ohlc5 {
  if (!prior) return today
  const sortedNoDup = (a: number[], b: number[]) => {
    for (let i = 1; i < a.length; i++) if (a[i] <= a[i - 1]) return false
    for (let i = 1; i < b.length; i++) if (b[i] <= b[i - 1]) return false
    return !a.length || !b.length || a[a.length - 1] < b[0]
  }
  if (sortedNoDup(prior.t, today.t)) {
    return { t: prior.t.concat(today.t), o: prior.o.concat(today.o), h: prior.h.concat(today.h), l: prior.l.concat(today.l), c: prior.c.concat(today.c) }
  }
  const rows = new Map<number, [number, number, number, number]>()
  for (const src of [prior, today]) for (let i = 0; i < src.t.length; i++) rows.set(src.t[i], [src.o[i], src.h[i], src.l[i], src.c[i]])
  const ts = [...rows.keys()].sort((a, b) => a - b)
  const out: Ohlc5 = { t: ts, o: [], h: [], l: [], c: [] }
  for (const t of ts) { const r = rows.get(t)!; out.o.push(r[0]); out.h.push(r[1]); out.l.push(r[2]); out.c.push(r[3]) }
  return out
}

const NICE: Record<string, string> = {
  'Open': "today's open", 'VWAP': 'VWAP', 'London open': 'the London open', 'IB high': 'the initial balance high',
  'IB low': 'the initial balance low', 'IB +50%': '50% above the initial balance', 'IB -50%': '50% below the initial balance',
  'overnight high': 'the overnight high', 'overnight low': 'the overnight low', 'prior day high': "yesterday's high",
  'prior day low': "yesterday's low", 'week open': "this week's open", 'prior-week high': "last week's high",
  'prior-week low': "last week's low", 'prior-week close': "last week's close", 'prior-week POC': "last week's point of control",
  'prior-week VAH': "last week's value area high", 'prior-week VAL': "last week's value area low",
  '5m 9 EMA': 'the 5-minute 9 EMA',
}
