/**
 * Storage for the tick tape (../tape.ts): the private Supabase bucket in
 * production, a plain folder for tests and dry runs. Plus the two operations
 * built on it — publish (the local feed agent) and load (the hosted route).
 *
 * The bucket is PRIVATE with no policies: only a server-side secret key can
 * read or write it. Raw trades never reach a browser; the hosted route reads
 * the hours it needs, cuts at the fill in memory and sends only the result.
 */
import { gzipSync, gunzipSync } from 'zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { contractFileForRoot } from '@/lib/futures-contracts'
import { ScidTickFile } from './scid-ticks'
import { TapeTickSource, ptHours } from './tick-source'
import type { OfRoot, TickFrame } from '../ticks'
import { utcMsToSierraUs } from '../ticks'
import { ptToUtcMs, utcToPtMs, tradingDate, ptMidnight, ptDate, PT_HOUR_MS, PT_DAY_MS } from '../pt-clock'
import {
  TAPE_BUCKET, TAPE_KEEP_DAYS, tapeChunkKey, tapeIndexKey, emptyTapeIndex, encodeTape, decodeTape, tapeHourStat,
  type TapeIndex,
} from '../tape'

const HOUR = PT_HOUR_MS
/** After an hour ends, how long the feed keeps re-reading it for late records. */
const CLOSED_GRACE_MS = 15 * 60_000
const usOfPt = (ptMs: number) => utcMsToSierraUs(ptToUtcMs(ptMs))

export interface TapeStore {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, data: Uint8Array, contentType: string): Promise<void>
  remove(keys: string[]): Promise<void>
}

/** The private `tick-tape` bucket. `sb` must be a secret-key (service) client. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- storage only; the Database generic is irrelevant here
export function supabaseTapeStore(sb: SupabaseClient<any, any, any>): TapeStore {
  const bucket = sb.storage.from(TAPE_BUCKET)
  return {
    async get(key) {
      const { data, error } = await bucket.download(key)
      if (error || !data) {
        const msg = (error as { message?: string } | null)?.message ?? ''
        if (/bucket not found/i.test(msg)) throw new Error('tick-tape bucket not found — run supabase/migrations/20261009_tick_tape_bucket.public.sql')
        return null                                   // object not found: that hour was never published
      }
      return new Uint8Array(await data.arrayBuffer())
    },
    async put(key, data, contentType) {
      const { error } = await bucket.upload(key, Buffer.from(data), { upsert: true, contentType })
      if (error) throw new Error(`tape upload ${key}: ${error.message}`)
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 100) {
        const { error } = await bucket.remove(keys.slice(i, i + 100))
        if (error) throw new Error(`tape remove: ${error.message}`)
      }
    },
  }
}

/** A folder on disk with the same layout — tests and dry runs. */
export function fsTapeStore(dir: string): TapeStore {
  return {
    async get(key) { const p = join(dir, key); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null },
    async put(key, data) { const p = join(dir, key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data) },
    async remove(keys) { for (const k of keys) rmSync(join(dir, k), { force: true }) },
  }
}

export async function loadTapeIndex(store: TapeStore, root: OfRoot): Promise<TapeIndex> {
  const raw = await store.get(tapeIndexKey(root))
  if (!raw) return emptyTapeIndex(root)
  const idx = JSON.parse(Buffer.from(raw).toString('utf8')) as TapeIndex
  return idx?.v === 1 && idx.days ? idx : emptyTapeIndex(root)
}

export async function saveTapeIndex(store: TapeStore, index: TapeIndex): Promise<void> {
  index.updated = new Date().toISOString()
  await store.put(tapeIndexKey(index.root), Buffer.from(JSON.stringify(index)), 'application/json')
}

function sameFrame(a: TickFrame, b: TickFrame): boolean {
  if (a.n !== b.n) return false
  for (let i = 0; i < a.n; i++) {
    if (a.us[i] !== b.us[i] || a.px[i] !== b.px[i] || a.hh[i] !== b.hh[i] || a.ll[i] !== b.ll[i] ||
        a.v[i] !== b.v[i] || a.bv[i] !== b.bv[i] || a.av[i] !== b.av[i] || a.nt[i] !== b.nt[i]) return false
  }
  return true
}

/**
 * Publish one PT calendar date of one instrument: an hourly chunk for every
 * hour that has trades and changed since the index last saw it. Hours before
 * 15:00 PT read that date's front month; 15:00 on reads the next trading
 * date's. Mutates `index` (the caller saves it once per run).
 *
 * Every chunk is decoded back and compared before upload — a chunk that
 * wouldn't round-trip exactly is never published.
 */
export async function publishTapeDay(
  store: TapeStore, root: OfRoot, date: string, index: TapeIndex,
  opts: { dataDir: string; nowUtcMs?: number; /** re-read hours already published and closed */ force?: boolean },
): Promise<{ uploaded: number; unchanged: number; bytes: number; trades: number }> {
  const nowPt = utcToPtMs(opts.nowUtcMs ?? Date.now())
  const files = new Map<string, ScidTickFile | null>()
  const open = (tdate: string) => {
    const name = contractFileForRoot(root, tdate, opts.dataDir)
    if (!name) return null
    if (!files.has(name)) { let f: ScidTickFile | null = null; try { f = new ScidTickFile(join(opts.dataDir, name)) } catch { f = null } files.set(name, f) }
    return files.get(name) ?? null
  }
  const out = { uploaded: 0, unchanged: 0, bytes: 0, trades: 0 }
  try {
    const day0 = ptMidnight(date)
    const rthLo = usOfPt(day0 + 6.5 * HOUR), rthHi = usOfPt(day0 + 13 * HOUR)
    for (let h = 0; h < 24; h++) {
      const startPt = day0 + h * HOUR
      if (startPt > nowPt) break
      // An hour that closed a while ago and is already published is final: no need to re-read it.
      const known = index.days[date]?.hours[String(h).padStart(2, '0')]
      if (known && !opts.force && startPt + HOUR + CLOSED_GRACE_MS < nowPt) { out.unchanged++; out.trades += known.n; continue }
      const f = open(tradingDate(startPt))
      if (!f) continue
      const t = f.read(usOfPt(startPt), usOfPt(startPt + HOUR))
      if (!t.n) continue
      out.trades += t.n
      const day = (index.days[date] ??= { rth: false, hours: {} })
      if (!day.rth && h >= 6 && h <= 12) for (let i = 0; i < t.n; i++) if (t.us[i] >= rthLo && t.us[i] < rthHi) { day.rth = true; break }
      const hh = String(h).padStart(2, '0')
      const stat = tapeHourStat(t), prev = day.hours[hh]
      if (prev && prev.n === stat.n && prev.lastUs === stat.lastUs) { out.unchanged++; continue }
      const enc = encodeTape(t)
      if (!sameFrame(t, decodeTape(enc))) throw new Error(`${root} ${date} ${hh}:00 would not round-trip exactly — not published`)
      const gz = gzipSync(enc, { level: 6 })
      await store.put(tapeChunkKey(root, date, h), gz, 'application/gzip')
      day.hours[hh] = stat
      out.uploaded++; out.bytes += gz.length
    }
  } finally {
    for (const f of files.values()) f?.close()
  }
  return out
}

/** Drop dates older than the retention window (chunks first, then the index entry). */
export async function pruneTape(store: TapeStore, index: TapeIndex, todayPtDate: string, keepDays = TAPE_KEEP_DAYS): Promise<number> {
  const cutoff = ptDate(ptMidnight(todayPtDate) - keepDays * PT_DAY_MS)
  const old = Object.keys(index.days).filter(d => d < cutoff)
  for (const d of old) {
    await store.remove(Object.keys(index.days[d].hours).map(hh => tapeChunkKey(index.root, d, Number(hh))))
    delete index.days[d]
  }
  return old.length
}

export class TapeUnavailable extends Error {}

/**
 * Fetch and decode the tape a snapshot needs: the index, then the hourly
 * chunks from the prior RTH open through `endUtcMs`. `startPtOf` resolves the
 * window start from the index alone (buildSnapshot's own rule), so this module
 * stays free of snapshot logic.
 */
export async function loadTapeSource(
  store: TapeStore, root: OfRoot, endUtcMs: number,
  startPtOf: (indexOnly: TapeTickSource) => number | null,
): Promise<TapeTickSource> {
  const index = await loadTapeIndex(store, root)
  if (!Object.keys(index.days).length) throw new TapeUnavailable(`No ${root} tick data has been published to the site yet.`)
  const endPt = utcToPtMs(endUtcMs)
  if (!index.days[ptDate(endPt - 1)]) {
    throw new TapeUnavailable(`No ${root} tick data on the site for ${ptDate(endPt - 1)} — the site keeps the last ${TAPE_KEEP_DAYS} days, published from the feed.`)
  }
  const startPt = startPtOf(new TapeTickSource(root, index))
  if (startPt == null) throw new TapeUnavailable(`The site has no earlier ${root} session to build this day's levels from.`)
  const wanted = ptHours(startPt, endPt).filter(h => index.days[h.ptDate]?.hours[String(h.hour).padStart(2, '0')])
  const chunks = new Map<string, TickFrame>()
  const POOL = 8
  let next = 0
  await Promise.all(Array.from({ length: Math.min(POOL, wanted.length) }, async () => {
    while (next < wanted.length) {
      const h = wanted[next++]
      const key = tapeChunkKey(root, h.ptDate, h.hour)
      const raw = await store.get(key)
      if (raw) chunks.set(key, decodeTape(gunzipSync(raw)))
    }
  }))
  return new TapeTickSource(root, index, chunks)
}
