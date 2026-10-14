/**
 * Gets the ticks the Score (../flow-score.ts) needs, and caches what does not
 * depend on the trade. Server-only.
 *
 * WHAT A SCORE READS (the Python's day_ctx / sess_stats define the windows):
 *   today         15:00 PT the day before → the fill           (ticks, per trade)
 *   5 sessions    each 15:00 PT → 13:00 PT: volume by price (low-volume areas),
 *                 5m bars (zones, newest 3), RTH high/low and normal 5m delta
 *                 (newest 1)
 *   prior week    Sunday 15:00 PT → Friday 14:00 PT: profile, high, close
 *   week open     first trade of Sunday 15:00–15:30 PT
 * Everything but "today" is the same for every trade on that instrument and
 * date, and each session is reused by the five trading days after it.
 *
 * TWO SOURCES, as for Deep Dive: the published tick tape on the hosted site
 * (per root, per PT hour), Sierra .scid files on the local build. Both hand
 * back the same hourly frames in file order.
 *
 * CACHES
 *   memory (this server instance): decoded hours (bounded), per-session and
 *     per-week numbers.
 *   bucket (hosted only): per-session and per-week numbers as small JSON under
 *     `score-ctx/v1/` in the private tick-tape bucket, so a cold instance does
 *     not re-read ten sessions of ticks. Every entry carries a signature of the
 *     tape hours it was built from (trade count + last trade time per hour, from
 *     the tape index) and is ignored when the tape has changed since — a session
 *     the feed fills in later is recomputed, never served stale.
 */
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { join } from 'path'
import { chartSeriesRoot } from '@/lib/futures-symbols'
import { contractFileForRoot } from '@/lib/futures-contracts'
import { SIERRA_DATA_DIR } from '@/lib/import-scid-day'
import type { TradeFlowFact } from '@/lib/supabase/types'
import type { OfRoot } from '../ticks'
import { SIERRA_EPOCH_OFFSET_US, utcMsToSierraUs } from '../ticks'
import { ptOffsetMs, ptToUtcMs, utcToPtMs, ptDate, ptMidnight, tradingDate, PT_HOUR_MS, PT_DAY_MS } from '../pt-clock'
import { TAPE_KEEP_DAYS, decodeTape, tapeChunkKey, type TapeIndex } from '../tape'
import { ScidTickFile } from './scid-ticks'
import { ptHours } from './tick-source'
import { loadTapeIndex, type TapeStore } from './tape-store'
import {
  US_HOUR, US_MIN, FlowNotScorable, WeekProfileBuilder, buildDayContext, concatFlowTicks, emptyFlowTicks, flowScale,
  flowTicksFromFrame, gradeFlow, inDaySession, sessionStats, snapEntry,
  type FlowDayContext, type FlowSessionStats, type FlowTicks, type FlowWeekStats,
} from '../flow-score'

const HOUR = PT_HOUR_MS, DAY = PT_DAY_MS
const usOfPt = (ptMs: number) => utcMsToSierraUs(ptToUtcMs(ptMs))
const addDays = (date: string, n: number) => ptDate(ptMidnight(date) + n * DAY)
const hh = (h: number) => String(h).padStart(2, '0')

/** Bucket prefix for the cached per-session / per-week numbers. Bump the version if their shape or maths change. */
export const SCORE_CTX_PREFIX = 'score-ctx/v1'

// ── sources ──────────────────────────────────────────────────────────────────
export interface FlowHourSource {
  /** Separates the in-memory caches of different sources. */
  readonly id: string
  /** The trades of one PT clock hour, file order; null when it has none. */
  hour(root: OfRoot, date: string, hour: number): Promise<FlowTicks | null>
  /** Changes whenever the trades in the PT hours [startPt, endPt) change. null = cannot tell. */
  signature(root: OfRoot, startPt: number, endPt: number): Promise<string | null>
  /** Earliest PT date held (null = not limited) and the latest trade time (Sierra µs; null = no data at all). */
  coverage(root: OfRoot): Promise<{ firstDate: string | null; latestUs: number | null }>
  /** Shared small-object cache (the bucket). Absent = memory only. */
  cache?: { get(key: string): Promise<Uint8Array | null>; put(key: string, data: Uint8Array): Promise<void> }
}

/** Decoded hours kept per source: about 28 bytes a trade, so ~110 MB at the cap. */
const HOUR_CACHE_TICKS = 4_000_000
const INDEX_TTL_MS = 30_000

/**
 * The published tick tape. `store` must be a server-key store for the private
 * bucket. `cache`: where the per-session JSON lives — the same store by default;
 * pass null for none, or another store (the parity test uses a temp folder so
 * it never writes to the bucket).
 */
export function tapeFlowSource(store: TapeStore, opts: { cache?: TapeStore | null } = {}): FlowHourSource {
  const indexes = new Map<OfRoot, { at: number; p: Promise<TapeIndex> }>()
  const index = (root: OfRoot) => {
    const hit = indexes.get(root)
    if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.p
    const p = loadTapeIndex(store, root)
    indexes.set(root, { at: Date.now(), p })
    p.catch(() => { if (indexes.get(root)?.p === p) indexes.delete(root) })
    return p
  }
  const hours = new Map<string, Promise<FlowTicks | null>>()      // insertion order = least recently used first
  const sizes = new Map<string, number>()
  let held = 0
  const cacheStore = opts.cache === undefined ? store : opts.cache
  return {
    id: 'tape',
    async hour(root, date, hour) {
      const st = (await index(root)).days[date]?.hours[hh(hour)]
      if (!st || !st.n) return null
      // the stat is part of the key: an hour the feed has added trades to since is read again
      const key = `${tapeChunkKey(root, date, hour)}|${st.n}|${st.lastUs}`
      const hit = hours.get(key)
      if (hit) { hours.delete(key); hours.set(key, hit); return hit }
      const p = (async () => {
        const raw = await store.get(tapeChunkKey(root, date, hour))
        if (!raw) return null
        const t = flowTicksFromFrame(decodeTape(gunzipSync(raw)))
        sizes.set(key, t.n); held += t.n
        for (const k of hours.keys()) {
          if (held <= HOUR_CACHE_TICKS) break
          if (k === key || !sizes.has(k)) continue
          held -= sizes.get(k)!; sizes.delete(k); hours.delete(k)
        }
        return t
      })()
      hours.set(key, p)
      p.catch(() => hours.delete(key))
      return p
    },
    async signature(root, startPt, endPt) {
      const idx = await index(root)
      const h = createHash('sha1')
      for (const x of ptHours(startPt, endPt)) {
        const st = idx.days[x.ptDate]?.hours[hh(x.hour)]
        if (st && st.n) h.update(`${x.ptDate}T${hh(x.hour)}:${st.n}:${st.lastUs};`)
      }
      return h.digest('hex').slice(0, 20)
    },
    async coverage(root) {
      const idx = await index(root)
      const dates = Object.keys(idx.days).sort()
      if (!dates.length) return { firstDate: null, latestUs: null }
      let latestUs = 0
      for (const d of dates.slice(-3)) for (const st of Object.values(idx.days[d].hours)) if (st.lastUs > latestUs) latestUs = st.lastUs
      return { firstDate: dates[0], latestUs: latestUs || null }
    },
    cache: cacheStore
      ? { get: key => cacheStore.get(key), put: (key, data) => cacheStore.put(key, data, 'application/json') }
      : undefined,
  }
}

/** Sierra .scid files on this machine (the local build): front month per trading date, read an hour at a time. */
export function scidFlowSource(dataDir: string = SIERRA_DATA_DIR): FlowHourSource {
  const open = (root: OfRoot, tdate: string): ScidTickFile | null => {
    const name = contractFileForRoot(root, tdate, dataDir)
    if (!name) return null
    try { return new ScidTickFile(join(dataDir, name)) } catch { return null }
  }
  return {
    id: `scid:${dataDir}`,
    async hour(root, date, hour) {
      const startPt = ptMidnight(date) + hour * HOUR
      const f = open(root, tradingDate(startPt))
      if (!f) return null
      try {
        const t = f.read(usOfPt(startPt), usOfPt(startPt + HOUR))
        return t.n ? flowTicksFromFrame(t) : null
      } finally { f.close() }
    },
    async signature() { return null },
    async coverage(root) {
      const f = open(root, tradingDate(utcToPtMs(Date.now())))
      if (!f) return { firstDate: null, latestUs: null }
      try { return { firstDate: null, latestUs: f.count ? f.timeAt(f.count - 1) : null } } finally { f.close() }
    },
  }
}

// ── per-session / per-week numbers, cached ───────────────────────────────────
interface Cached<T> { sig: string | null; value: T }
const memSess = new Map<string, Cached<FlowSessionStats | null>>()
const memWeek = new Map<string, Cached<FlowWeekStats>>()
const MEM_MAX = 96
function remember<T>(m: Map<string, Cached<T>>, key: string, v: Cached<T>) {
  m.delete(key); m.set(key, v)
  while (m.size > MEM_MAX) m.delete(m.keys().next().value as string)
}

/** Forget the in-memory per-session numbers — lets the parity test time a cold server instance. */
export function __resetFlowScoreMemory() { memSess.clear(); memWeek.clear() }

// JSON has no NaN; a session whose first 90 minutes never traded has n5 = NaN in the Python.
type PackedSess = (Omit<FlowSessionStats, 'n5'> & { n5?: number | 'NaN' }) | null
const packSess = (s: FlowSessionStats | null): PackedSess => (s ? { ...s, n5: s.n5 !== undefined && Number.isNaN(s.n5) ? 'NaN' : s.n5 } : null)
const unpackSess = (s: PackedSess): FlowSessionStats | null => (s ? { ...s, n5: s.n5 === 'NaN' ? NaN : s.n5 } : null)

export interface FlowTradeRow {
  id: string
  symbol: string | null
  entry_time: string | null
  entry_price: number | string | null
  direction: string | null
}

export type FlowOutcome =
  | { status: 'scored'; total: number; facts: TradeFlowFact[]; read_at: string; detail: Record<string, unknown>; ms: FlowTiming }
  /** The tape cannot score this trade (now or ever): nothing is written. */
  | { status: 'not_scorable'; reason: string }
  /** The feed has not published the minutes around the fill yet — ask again shortly. */
  | { status: 'pending'; reason: string }

export interface FlowTiming { context: number; ticks: number; grade: number; total: number }

/** An ISO timestamp with a UTC offset → UTC microseconds (Postgres keeps six decimals; Date.parse keeps three). */
export function isoToUtcUs(iso: string): number {
  const m = iso.match(/^(.*?\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/)
  if (!m) return NaN
  const ms = Date.parse(`${m[1]}${m[3] || 'Z'}`)
  const frac = m[2] ? Number(m[2].slice(0, 6).padEnd(6, '0')) : 0
  return ms * 1000 + frac
}

/**
 * One per request. Holds nothing a later request could find stale: the day
 * contexts memoised here are rebuilt per request from the signature-checked
 * session and week caches.
 */
export class FlowScoreLoader {
  private days = new Map<string, Promise<FlowDayContext>>()
  private today: { key: string; through: number; ticks: Promise<FlowTicks> } | null = null
  /** What the last calls did — for the timing report. */
  readonly stats = { hoursRead: 0, sessionsComputed: 0, sessionsFromBucket: 0, sessionsFromMemory: 0, weeksComputed: 0, weeksFromBucket: 0, weeksFromMemory: 0, bucketWrites: 0 }

  constructor(private src: FlowHourSource, private opts: { /** false = never write the shared cache */ cacheWrite?: boolean } = {}) {}

  private async hourTicks(root: OfRoot, date: string, hour: number): Promise<FlowTicks | null> {
    const t = await this.src.hour(root, date, hour)
    if (t) this.stats.hoursRead++
    return t
  }

  /** Trades of the PT hours [startPt, endPt), file order. */
  private async window(root: OfRoot, startPt: number, endPt: number): Promise<FlowTicks> {
    const hours = ptHours(startPt, endPt)
    const parts = new Array<FlowTicks | null>(hours.length).fill(null)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(8, hours.length) }, async () => {
      while (next < hours.length) {
        const i = next++
        parts[i] = await this.hourTicks(root, hours[i].ptDate, hours[i].hour)
      }
    }))
    const live = parts.filter((p): p is FlowTicks => !!p)
    return live.length ? concatFlowTicks(live) : emptyFlowTicks()
  }

  private async cacheGet<T>(key: string, sig: string | null): Promise<{ value: T } | null> {
    if (!sig || !this.src.cache) return null
    try {
      const raw = await this.src.cache.get(key)
      if (!raw) return null
      const o = JSON.parse(Buffer.from(raw).toString('utf8')) as { sig?: string; value: T }
      return o && o.sig === sig ? { value: o.value } : null
    } catch { return null }
  }

  private async cachePut(key: string, sig: string | null, value: unknown) {
    if (!sig || !this.src.cache || this.opts.cacheWrite === false) return
    try {
      await this.src.cache.put(key, Buffer.from(JSON.stringify({ sig, value })))
      this.stats.bucketWrites++
    } catch { /* a cache that cannot be written is only slower */ }
  }

  /** Cached numbers of session `date`, or undefined when they have to be computed. */
  private async sessionLookup(root: OfRoot, date: string): Promise<{ sig: string | null; hit?: Cached<FlowSessionStats | null> }> {
    const day0 = ptMidnight(date)
    const sig = await this.src.signature(root, day0 - 9 * HOUR, day0 + 13 * HOUR)
    const mkey = `${this.src.id}|${root}|${date}`
    const mem = memSess.get(mkey)
    if (mem && mem.sig === sig) { this.stats.sessionsFromMemory++; return { sig, hit: mem } }
    const got = await this.cacheGet<PackedSess>(`${SCORE_CTX_PREFIX}/${root}/sess/${date}.json`, sig)
    if (got) {
      const hit = { sig, value: unpackSess(got.value) }
      remember(memSess, mkey, hit); this.stats.sessionsFromBucket++
      return { sig, hit }
    }
    return { sig }
  }

  private async sessionCompute(root: OfRoot, date: string, sig: string | null): Promise<FlowSessionStats | null> {
    const day0 = ptMidnight(date)
    const tk = await this.window(root, day0 - 9 * HOUR, day0 + 13 * HOUR)
    const value = sessionStats(tk, day0 * 1000, flowScale(root))
    this.stats.sessionsComputed++
    remember(memSess, `${this.src.id}|${root}|${date}`, { sig, value })
    await this.cachePut(`${SCORE_CTX_PREFIX}/${root}/sess/${date}.json`, sig, packSess(value))
    return value
  }

  private async week(root: OfRoot, monday: string): Promise<FlowWeekStats> {
    const mon = ptMidnight(monday)
    const openPt = mon - 9 * HOUR                                       // Sunday 15:00 PT
    const pwStart = mon - 7 * DAY - 9 * HOUR, pwEnd = mon - 3 * DAY + 14 * HOUR
    const sigA = await this.src.signature(root, openPt, openPt + HOUR)
    const sigB = await this.src.signature(root, pwStart, pwEnd)
    const sig = sigA === null || sigB === null ? null : `${sigA}.${sigB}`
    const mkey = `${this.src.id}|${root}|${monday}`
    const mem = memWeek.get(mkey)
    if (mem && mem.sig === sig) { this.stats.weeksFromMemory++; return mem.value }
    const key = `${SCORE_CTX_PREFIX}/${root}/week/${monday}.json`
    const got = await this.cacheGet<FlowWeekStats>(key, sig)
    if (got) { remember(memWeek, mkey, { sig, value: got.value }); this.stats.weeksFromBucket++; return got.value }

    const value: FlowWeekStats = {}
    // the Python takes the file slice [15:00, 15:30) and reads its first record
    const first = await this.hourTicks(root, ptDate(openPt), 15)
    if (first && first.n) {
      const cut = (openPt + HOUR / 2) * 1000
      let lo = 0, hi = first.n
      while (lo < hi) { const mid = lo + ((hi - lo) >> 1); if (first.t[mid] < cut) lo = mid + 1; else hi = mid }
      if (lo > 0) value.weekOpen = first.px[0]
    }
    // a week of ticks is streamed through the profile, half a day at a time
    const prof = new WeekProfileBuilder(flowScale(root))
    for (let a = pwStart; a < pwEnd; a += 12 * HOUR) {
      const hours = ptHours(a, Math.min(a + 12 * HOUR, pwEnd))
      const parts = await Promise.all(hours.map(h => this.hourTicks(root, h.ptDate, h.hour)))
      for (const p of parts) if (p) prof.add(p)
    }
    const pw = prof.finish()
    if (pw) value.priorWeek = pw
    this.stats.weeksComputed++
    remember(memWeek, mkey, { sig, value })
    await this.cachePut(key, sig, value)
    return value
  }

  /** Everything about the session that does not depend on the trade — once per (root, PT date). */
  dayContext(root: OfRoot, date: string): Promise<FlowDayContext> {
    const key = `${root}|${date}`
    let p = this.days.get(key)
    if (!p) {
      p = this.buildDay(root, date)
      this.days.set(key, p)
      p.catch(() => this.days.delete(key))
    }
    return p
  }

  private async buildDay(root: OfRoot, date: string): Promise<FlowDayContext> {
    // Prior sessions, newest first: walk back up to 25 calendar days over weekdays and keep the
    // first five that have data (the Python collects ten, for an ADR the facts do not use).
    const weekdays: string[] = []
    for (let k = 1; k <= 25; k++) {
      const d = addDays(date, -k)
      const dow = new Date(ptMidnight(d)).getUTCDay()
      if (dow !== 0 && dow !== 6) weekdays.push(d)
    }
    // cached entries are looked up together; anything missing is computed one session at a time (memory)
    const looked = new Map<string, Awaited<ReturnType<FlowScoreLoader['sessionLookup']>>>()
    await Promise.all(weekdays.slice(0, 6).map(async d => { looked.set(d, await this.sessionLookup(root, d)) }))
    const sessions: FlowSessionStats[] = []
    for (const d of weekdays) {
      const l = looked.get(d) ?? await this.sessionLookup(root, d)
      const st = l.hit ? l.hit.value : await this.sessionCompute(root, d, l.sig)
      if (!st) continue
      sessions.push(st)
      if (sessions.length >= 5) break
    }
    const day0 = ptMidnight(date)
    const monday = addDays(date, -((new Date(day0).getUTCDay() + 6) % 7))
    const week = await this.week(root, monday)
    return buildDayContext(day0 * 1000, flowScale(root), sessions, week)
  }

  /** Today's session from 15:00 PT the day before through PT hour `throughHour`, file order. */
  private sessionTicks(root: OfRoot, date: string, throughHour: number): Promise<FlowTicks> {
    const key = `${root}|${date}`
    if (this.today && this.today.key === key && this.today.through >= throughHour) return this.today.ticks
    const day0 = ptMidnight(date)
    const ticks = this.window(root, day0 - 9 * HOUR, day0 + (throughHour + 1) * HOUR)
    this.today = { key, through: throughHour, ticks }
    ticks.catch(() => { if (this.today?.ticks === ticks) this.today = null })
    return ticks
  }

  /**
   * Where a trade sits, without reading any ticks: the instrument, the PT date
   * and hour of the fill. null fields mean it cannot be scored (see `reason`).
   */
  static locate(row: FlowTradeRow): { root: OfRoot; ePtUs: number; eUtcUs: number; date: string; hour: number; sgn: 1 | -1; px: number } | { reason: string } {
    const root = row.symbol ? chartSeriesRoot(row.symbol) : ''
    if (root !== 'NQ' && root !== 'ES') return { reason: `the Score reads NQ/MNQ and ES/MES; this trade is ${row.symbol ?? 'unknown'}` }
    const eUtcUs = row.entry_time ? isoToUtcUs(row.entry_time) : NaN
    const px = row.entry_price == null || row.entry_price === '' ? NaN : Number(row.entry_price)
    if (!Number.isFinite(eUtcUs) || !Number.isFinite(px) || (row.direction !== 'long' && row.direction !== 'short')) {
      return { reason: 'the trade is missing its entry time, price or direction' }
    }
    const ePtUs = eUtcUs + ptOffsetMs(Math.floor(eUtcUs / 1000)) * 1000
    if (!inDaySession(ePtUs)) return { reason: 'outside the day session (06:30–13:00 PT)' }
    const ptMs = Math.floor(ePtUs / 1000)
    return { root, ePtUs, eUtcUs, date: ptDate(ptMs), hour: Math.floor((ePtUs % (24 * US_HOUR)) / US_HOUR), sgn: row.direction === 'long' ? 1 : -1, px }
  }

  async score(row: FlowTradeRow): Promise<FlowOutcome> {
    const t0 = performance.now()
    const at = FlowScoreLoader.locate(row)
    if ('reason' in at) return { status: 'not_scorable', reason: at.reason }
    const { root, date } = at
    const cov = await this.src.coverage(root)
    if (cov.latestUs == null) return { status: 'not_scorable', reason: `no ${root} tick data is available` }
    // The fill-time fix reads the whole entry minute, and the feed publishes a few minutes behind:
    // a score read before the tape reaches past the fill would be a read of half the picture.
    if (cov.latestUs < at.eUtcUs + SIERRA_EPOCH_OFFSET_US + US_MIN) return { status: 'pending', reason: 'the tick tape has not reached this fill yet' }
    // the prior week starts on the Sunday eight days before this week's Monday
    const monday = addDays(date, -((new Date(ptMidnight(date)).getUTCDay() + 6) % 7))
    if (cov.firstDate && cov.firstDate > addDays(monday, -8)) {
      return { status: 'not_scorable', reason: `older than the tick history kept on the site (${TAPE_KEEP_DAYS} days, and a Score reads back to the start of the week before)` }
    }
    const ctx = await this.dayContext(root, date)
    const t1 = performance.now()
    const ticks = await this.sessionTicks(root, date, at.hour)
    const t2 = performance.now()
    if (!ticks.n) return { status: 'not_scorable', reason: `no ${root} tick data for ${date}` }
    try {
      const { e } = snapEntry(at.ePtUs, at.px, ticks)
      const g = gradeFlow({ e, sgn: at.sgn, px: at.px }, ticks, ctx)
      const t3 = performance.now()
      return { status: 'scored', total: g.total, facts: g.facts, read_at: g.read_at, detail: g.detail, ms: { context: t1 - t0, ticks: t2 - t1, grade: t3 - t2, total: t3 - t0 } }
    } catch (err) {
      if (err instanceof FlowNotScorable) return { status: 'not_scorable', reason: err.message }
      throw err
    }
  }
}
