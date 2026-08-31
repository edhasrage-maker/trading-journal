/** Tick-derived truth for the screenshot coach: the trader's own volume
 *  profiles, node structure with LOST VOLUME, and orderflow at/around entry.
 *
 *  Everything here reads the .scid tick files (contract space — the SAME
 *  price space as the trade's own fills, so no roll-basis anchoring is
 *  needed anywhere in this module). LOCAL ONLY by construction: no cloud
 *  host can serve these files.
 *
 *  THE PROFILES ARE THE TRADER'S, NOT OURS (captured 2026-08-30 from their
 *  Sierra study settings; see project memory):
 *    RTH intraday  reset each day session, RTH only,  ES 0.25pt rows, NQ 1pt
 *    GBX           evening session as its own profile, same rows
 *    5d composite  one profile, 5 trading days at end, auto-skip empty,
 *                  full ETH, rolling incl. developing — ES 0.25pt rows,
 *                  NQ rows UNKNOWN (not built until the trader supplies them)
 *    30d composite same, 30 days — ES 1pt rows, NQ rows UNKNOWN
 *
 *  LOST VOLUME — the trader's definition, verbatim intent: a built-out HVN
 *  that price then LEAVES. The direction of departure is the side that won;
 *  whoever is left holding inventory inside the node is in pain. The first
 *  retest of a lost node's edge is the losers' first chance out at breakeven.
 *  This module measures it: built volume, build delta (who was aggressing),
 *  departure direction and depth, age, and whether it has been retested.
 *
 *  Delta significance rows are the FOOTPRINT chart's rows, from the trader's
 *  own word (2026-08-30): ES 1 tick (0.25pt), NQ 1 point. The p99 threshold is
 *  computed on the same grid, so "large for today" stays grid-honest.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, basename } from 'path'
import { readDeltaByPrice, type DeltaRow, type DeltaBar } from '../src/lib/scid-delta'
import { detectDeltaLevels, type DetectedDeltaLevel } from '../src/lib/delta-by-price'

const SC_DATA_DIR = 'D:/SierraCharts/Data'
const PRICE_DIVISOR = 100

/** Per-root config. Rows in PRICE POINTS. `null` = the trader has not told
 *  us their chart's row height for that profile — build NOTHING rather than
 *  guess; a node on the wrong grid lands beside the shelf they actually see. */
const ROOTS: Record<string, {
  vpRow: number; deltaRow: number; d5Row: number | null; d30Row: number | null
}> = {
  ES: { vpRow: 0.25, deltaRow: 0.25, d5Row: 0.25, d30Row: 1 },
  NQ: { vpRow: 1, deltaRow: 1, d5Row: null, d30Row: null },
}

/** MESU6.CME → ES + U6 → ESU6.CME.scid (micros trade the mini's book). */
export function scidFileFor(symbol: string): { path: string; root: string } | null {
  const m = symbol.match(/^(M?ES|M?NQ)([FGHJKMNQUVXZ]\d{1,2})(\.|-|$)/i)
  if (!m) return null
  const root = m[1].toUpperCase().replace(/^M/, '')
  const p = join(SC_DATA_DIR, `${root}${m[2].toUpperCase()}.CME.scid`)
  return existsSync(p) ? { path: p, root } : null
}

// ── Pacific wall time → epoch ms (DST-correct via round-trip check) ────────
const PT_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})
function ptOf(ms: number): { date: string; sec: number } {
  const p: Record<string, string> = {}
  for (const x of PT_FMT.formatToParts(ms)) p[x.type] = x.value
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    sec: (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second),
  }
}
export function ptWallToMs(dateISO: string, sec: number): number {
  for (const offH of [7, 8]) {
    const ms = Date.parse(`${dateISO}T00:00:00Z`) + sec * 1000 + offH * 3600_000
    const b = ptOf(ms)
    if (b.date === dateISO && b.sec === sec) return ms
  }
  return Date.parse(`${dateISO}T00:00:00Z`) + sec * 1000 + 7 * 3600_000
}
const addDays = (dateISO: string, n: number): string => {
  const d = new Date(Date.parse(dateISO + 'T00:00:00Z') + n * 86400_000)
  return d.toISOString().slice(0, 10)
}

/** Session clock, all PT, from the trader's own study source
 *  (EdhasrageSessionLevels.cpp): ETH 15:00 · RTH 06:30–13:00 · full end 14:00. */
const ETH_START = 15 * 3600, RTH_START = 6 * 3600 + 1800, RTH_END = 13 * 3600, FULL_END = 14 * 3600
export const sessionWindows = (rthDate: string) => ({
  ethStartMs: ptWallToMs(addDays(rthDate, -1), ETH_START),
  rthStartMs: ptWallToMs(rthDate, RTH_START),
  rthEndMs: ptWallToMs(rthDate, RTH_END),
  fullEndMs: ptWallToMs(rthDate, FULL_END),
})
/** Previous weekday (holiday gaps handled by the empty-read fallback). */
export function priorRthDate(dateISO: string): string {
  let d = addDays(dateISO, -1)
  while (['Sat', 'Sun'].includes(new Date(d + 'T12:00:00Z').toUTCString().slice(0, 3))) d = addDays(d, -1)
  return d
}

// ── row arithmetic ─────────────────────────────────────────────────────────
/** Compact row: scaled-int low edge, volume, delta. The cache format. */
export type Slim = [rowInt: number, volume: number, delta: number]

const slim = (rows: DeltaRow[]): Slim[] =>
  rows.map(r => [Math.round(r.price * PRICE_DIVISOR), r.volume, r.delta])

/** Re-bin slim rows to a coarser row unit (must be an integer multiple —
 *  25→100 is exact; anything else would smear, which is the sin this whole
 *  module exists to stop). */
function rebinSlim(rows: Slim[], fromUnit: number, toUnit: number): Slim[] {
  if (toUnit === fromUnit) return rows
  if (toUnit % fromUnit !== 0) throw new Error(`rebin ${fromUnit}→${toUnit} is not exact`)
  const m = new Map<number, [number, number]>()
  for (const [p, v, d] of rows) {
    const k = Math.floor(p / toUnit) * toUnit
    const e = m.get(k)
    if (e) { e[0] += v; e[1] += d } else m.set(k, [v, d])
  }
  return Array.from(m.entries()).map(([p, [v, d]]) => [p, v, d] as Slim).sort((a, b) => a[0] - b[0])
}
function sumSlim(into: Map<number, [number, number]>, rows: Slim[]): void {
  for (const [p, v, d] of rows) {
    const e = into.get(p)
    if (e) { e[0] += v; e[1] += d } else into.set(p, [v, d])
  }
}

/** Full DeltaRow re-bin, visits merged by time (for the delta detector,
 *  whose hold/visit logic needs real timestamps, not just totals). */
function rebinRows(rows: DeltaRow[], toRowPts: number, visitGapMs: number): DeltaRow[] {
  const toUnit = Math.round(toRowPts * PRICE_DIVISOR)
  const m = new Map<number, DeltaRow>()
  for (const r of rows) {
    const k = Math.floor(Math.round(r.price * PRICE_DIVISOR) / toUnit) * toUnit
    const e = m.get(k)
    if (!e) {
      m.set(k, { price: k / PRICE_DIVISOR, delta: r.delta, volume: r.volume, trades: r.trades,
        firstMs: r.firstMs, lastMs: r.lastMs, visits: [...r.visits] })
    } else {
      e.delta += r.delta; e.volume += r.volume; e.trades += r.trades
      e.firstMs = Math.min(e.firstMs, r.firstMs); e.lastMs = Math.max(e.lastMs, r.lastMs)
      e.visits.push(...r.visits)
    }
  }
  for (const r of m.values()) {
    r.visits.sort((a, b) => a.startMs - b.startMs)
    const merged = [r.visits[0]]
    for (let i = 1; i < r.visits.length; i++) {
      const v = r.visits[i], last = merged[merged.length - 1]
      if (v.startMs - last.endMs <= visitGapMs) {
        last.endMs = Math.max(last.endMs, v.endMs); last.delta += v.delta; last.volume += v.volume
      } else merged.push({ ...v })
    }
    r.visits = merged
  }
  return Array.from(m.values()).sort((a, b) => a.price - b.price)
}

// ── profile math (POC / 70% VA, grown from POC — same rule as the chart) ──
export interface TickProfile {
  poc: number; vah: number; val: number
  rowPts: number; totalVolume: number
  rows: Slim[]           // at the profile's own display bins
  nodes: NodeExtent[]
}
export interface NodeExtent {
  kind: 'HVN' | 'LVN'
  lo: number; hi: number            // price edges (hi = top edge of last bin)
  center: number                    // volume-weighted
  volume: number; volumeShare: number
  delta: number
}
const VA_PCT = 0.70                 // trader's chart default, unconfirmed but standard
const HVN_RATIO = 1.5, LVN_RATIO = 0.5   // same bands the bar profile used
const NODE_MIN_BINS = 2
const HVN_MIN_SHARE = 0.05

export function profileOf(rowsIn: Slim[], rowUnit: number): TickProfile | null {
  const rows = rowsIn.filter(r => r[1] > 0)
  if (rows.length < 3) return null
  const total = rows.reduce((s, r) => s + r[1], 0)
  const byP = new Map(rows.map(r => [r[0], r]))
  let poc = rows[0]
  for (const r of rows) if (r[1] > poc[1]) poc = r
  let acc = poc[1], lo = poc[0], hi = poc[0]
  while (acc < total * VA_PCT) {
    const up = byP.get(hi + rowUnit)?.[1] ?? 0, dn = byP.get(lo - rowUnit)?.[1] ?? 0
    if (up === 0 && dn === 0) break
    if (up >= dn) { hi += rowUnit; acc += up } else { lo -= rowUnit; acc += dn }
  }
  const vols = rows.map(r => r[1]).sort((a, b) => a - b)
  const median = vols[Math.floor(vols.length / 2)]
  // nodes: classify each bin vs median, merge adjacent same-class bins
  const nodes: NodeExtent[] = []
  let cur: { kind: 'HVN' | 'LVN'; bins: Slim[] } | null = null
  const flush = () => {
    if (!cur) return
    const vol = cur.bins.reduce((s, r) => s + r[1], 0)
    const keep = cur.bins.length >= NODE_MIN_BINS
      && (cur.kind === 'LVN' || vol / total >= HVN_MIN_SHARE)
    if (keep) nodes.push({
      kind: cur.kind,
      lo: cur.bins[0][0] / PRICE_DIVISOR,
      hi: (cur.bins[cur.bins.length - 1][0] + rowUnit) / PRICE_DIVISOR,
      center: cur.bins.reduce((s, r) => s + (r[0] + rowUnit / 2) * r[1], 0) / vol / PRICE_DIVISOR,
      volume: vol, volumeShare: vol / total,
      delta: cur.bins.reduce((s, r) => s + r[2], 0),
    })
    cur = null
  }
  // walk the full contiguous grid so an untraded gap reads as LVN, not as a seam
  const kMin = rows[0][0], kMax = rows[rows.length - 1][0]
  for (let k = kMin; k <= kMax; k += rowUnit) {
    const r = byP.get(k) ?? ([k, 0, 0] as Slim)
    const ratio = median > 0 ? r[1] / median : 0
    const kind: 'HVN' | 'LVN' | null = ratio >= HVN_RATIO ? 'HVN' : ratio <= LVN_RATIO ? 'LVN' : null
    if (cur && cur.kind === kind) cur.bins.push(r)
    else { flush(); if (kind) cur = { kind, bins: [r] } }
  }
  flush()
  return {
    poc: (poc[0] + rowUnit / 2) / PRICE_DIVISOR,
    vah: (hi + rowUnit) / PRICE_DIVISOR, val: lo / PRICE_DIVISOR,
    rowPts: rowUnit / PRICE_DIVISOR, totalVolume: total,
    rows, nodes,
  }
}

// ── lost volume ────────────────────────────────────────────────────────────
//  The trader's definition (2026-08-30): a built-out HVN price then LEAVES.
//  Departure direction = the side that won; the losers' inventory is trapped
//  inside. First retest of the node edge = their first breakeven exit.
export interface LostNode {
  session: string
  lo: number; hi: number; center: number
  built_volume: number; volume_share: number
  build_delta: number                    // net aggression DURING the build
  losing_side: 'buyers' | 'sellers'      // from the departure direction
  departed_min_before_entry: number
  depth_pts_at_entry: number             // entry's distance from the nearer edge
  retested: boolean                      // edge touched again after departure
  entry_relation: 'inside' | 'first_retest' | 'overhead' | 'below'
  in_tp_path: boolean; in_stop_path: boolean
}
const LOST_MIN_AWAY_MIN = 20     // must stay out this long to count as left
const LOST_REACCEPT_BARS = 5     // this many closes back inside repairs the node
const EDGE_BAND_PTS = (rowPts: number) => 2 * rowPts
export const TICKFLOW_VERSION = 4

function lostNodesOf(
  session: string, prof: TickProfile, bars: DeltaBar[],
  entryMs: number, entryPrice: number, tp1: number | null, stop: number | null,
  atr: number | null, adr: number | null,
): LostNode[] {
  const out: LostNode[] = []
  const minDepart = Math.max(1.5 * (atr ?? 0), 4 * prof.rowPts)
  const pre = bars.filter(b => b.ts < entryMs)
  if (pre.length < 3) return out
  for (const n of prof.nodes) {
    if (n.kind !== 'HVN') continue
    // The DEPARTURE event: the last inside->outside transition whose outside
    // run lasted, went far enough, and was never re-ACCEPTED (a brief poke
    // back in is a retest; LOST_REACCEPT_BARS closes back inside repairs it).
    let leaveIdx = -1
    for (let i = 1; i < pre.length; i++) {
      const wasIn = pre[i - 1].close >= n.lo && pre[i - 1].close <= n.hi
      const isOut = pre[i].close < n.lo || pre[i].close > n.hi
      if (wasIn && isOut) leaveIdx = i
    }
    if (leaveIdx < 0) continue
    const leftMs = pre[leaveIdx].ts
    if (entryMs - leftMs < LOST_MIN_AWAY_MIN * 60_000) continue
    const after = pre.slice(leaveIdx)
    const dirUp = pre[leaveIdx].close > n.hi
    // decisive: the excursion beyond the edge, not wherever price sits now
    let ext = dirUp ? -Infinity : Infinity, backIn = 0
    for (const b of after) {
      if (dirUp) ext = Math.max(ext, b.high); else ext = Math.min(ext, b.low)
      if (b.close >= n.lo && b.close <= n.hi) backIn++
    }
    if (backIn >= LOST_REACCEPT_BARS) continue    // repaired — the losers got out
    const depart = dirUp ? ext - n.hi : n.lo - ext
    if (depart < minDepart) continue
    const band = EDGE_BAND_PTS(prof.rowPts)
    const edge = dirUp ? n.hi : n.lo
    let retested = false
    for (const b of after.slice(1)) {
      if (dirUp ? b.low <= edge + band : b.high >= edge - band) { retested = true; break }
    }
    const inside = entryPrice >= n.lo && entryPrice <= n.hi
    const atEdge = !inside && Math.abs(entryPrice - edge) <= band
    const depth = inside ? 0 : Math.min(Math.abs(entryPrice - n.lo), Math.abs(entryPrice - n.hi))
    const between = (a: number, b: number, x1: number, x2: number) =>
      Math.max(a, b) >= Math.min(x1, x2) && Math.min(a, b) <= Math.max(x1, x2)
    const inTp = tp1 != null && between(n.lo, n.hi, entryPrice, tp1)
    const inStop = stop != null && between(n.lo, n.hi, entryPrice, stop)
    // relevance: pain nobody is near is scenery, not coaching
    const near = adr != null ? depth <= 0.25 * adr : depth <= 8 * minDepart
    if (!inside && !atEdge && !inTp && !inStop && !near) continue
    out.push({
      session,
      lo: n.lo, hi: n.hi, center: Math.round(n.center * 100) / 100,
      built_volume: n.volume, volume_share: Math.round(n.volumeShare * 1000) / 1000,
      build_delta: n.delta,
      losing_side: dirUp ? 'sellers' : 'buyers',
      departed_min_before_entry: Math.round((entryMs - leftMs) / 60_000),
      depth_pts_at_entry: Math.round(depth * 100) / 100,
      retested,
      entry_relation: inside ? 'inside' : atEdge && !retested ? 'first_retest'
        : n.lo > entryPrice ? 'overhead' : 'below',
      in_tp_path: inTp, in_stop_path: inStop,
    })
  }
  // the ones that matter first, and never a wall of them
  const rank = (x: LostNode) => (x.entry_relation === 'inside' ? 0 : x.entry_relation === 'first_retest' ? 1 : x.in_tp_path || x.in_stop_path ? 2 : 3)
  return out.sort((a, b) => rank(a) - rank(b) || b.volume_share - a.volume_share).slice(0, 3)
}

// ── day cache (for the 5d / 30d composites) ────────────────────────────────
//  One JSON per (contract file, RTH date): the full ETH day's rows at the
//  FINE row unit. Composites re-bin and sum. Visits are deliberately not
//  cached — composites need totals, and the entry day is read live anyway.
const CACHE_DIR = join(process.cwd(), 'evals', 'screenshot-coach', 'tick-cache')

function dayRows(scidPath: string, root: string, rthDate: string): Slim[] | null {
  const unit = Math.round(ROOTS[root].vpRow * PRICE_DIVISOR)
  const key = basename(scidPath).replace(/\.scid$/i, '')
  const f = join(CACHE_DIR, `${key}-${rthDate}.json`)
  if (existsSync(f)) {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    return j.rows.length ? j.rows : null
  }
  const w = sessionWindows(rthDate)
  const res = readDeltaByPrice(scidPath, w.ethStartMs, w.fullEndMs, {
    rowHeight: ROOTS[root].vpRow, priceDivisor: PRICE_DIVISOR,
  })
  const rows = slim(res.rows)
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(f, JSON.stringify({ unit, rows }), 'utf8')
  return rows.length ? rows : null
}

/** Last `need` trading days strictly before `rthDate` that actually traded. */
function priorTradingDays(scidPath: string, root: string, rthDate: string, need: number): string[] {
  const days: string[] = []
  let d = rthDate
  for (let i = 0; i < 70 && days.length < need; i++) {
    d = priorRthDate(d)
    if (dayRows(scidPath, root, d)) days.push(d)
  }
  return days
}

// ── the per-trade analysis ─────────────────────────────────────────────────
export interface TickflowInput {
  symbol: string; rthDate: string; entryMs: number
  entryPrice: number; tp1: number | null; stop: number | null
  isLong: boolean; atr: number | null; adr: number | null
}
export interface TickflowResult {
  file: string
  window_10m: { delta: number; volume: number; delta_is: 'with' | 'against' | 'flat' } | null
  entry_rows: { delta: number; volume: number; significant: boolean; pct_of_large: number | null;
    kind: string | null; strength: number | null; threshold: number } | null
  significant_levels: Array<{
    price: number; dist_pts: number; side: 'above' | 'below'
    delta: number; kind: string; strength: number
    formed_min_before_entry: number
    in_tp_path: boolean; in_stop_path: boolean
  }>
  profiles: Record<string, {
    poc: number; vah: number; val: number; row_pts: number
    entry_zone: string
    hvn_count: number; lvn_count: number
    nearest_hvn: { lo: number; hi: number; dist_pts: number; side: string } | null
  } | null>
  lost_nodes: LostNode[]
  skipped: string[]
}

const zoneOf = (p: TickProfile, px: number): string =>
  px > p.vah ? 'above value' : px < p.val ? 'below value'
    : Math.abs(px - p.poc) <= p.rowPts * 2 ? 'at POC'
    : px > p.poc ? 'inside value, upper half' : 'inside value, lower half'

function profSummary(p: TickProfile | null, entry: number) {
  if (!p) return null
  const hvns = p.nodes.filter(n => n.kind === 'HVN')
  let nearest: { lo: number; hi: number; dist_pts: number; side: string } | null = null
  let best = Infinity
  for (const n of hvns) {
    const d = entry >= n.lo && entry <= n.hi ? 0 : Math.min(Math.abs(entry - n.lo), Math.abs(entry - n.hi))
    if (d < best) { best = d; nearest = { lo: n.lo, hi: n.hi, dist_pts: Math.round(d * 100) / 100, side: entry > n.hi ? 'below' : entry < n.lo ? 'above' : 'at entry' } }
  }
  return {
    poc: p.poc, vah: p.vah, val: p.val, row_pts: p.rowPts,
    entry_zone: zoneOf(p, entry),
    hvn_count: hvns.length, lvn_count: p.nodes.length - hvns.length,
    nearest_hvn: nearest,
  }
}

export function analyzeTickflow(t: TickflowInput): TickflowResult | null {
  const hit = scidFileFor(t.symbol)
  if (!hit) return null
  const { path, root } = hit
  const cfg = ROOTS[root]
  const skipped: string[] = []
  // Normalize the trading day from the ENTRY itself: a Sunday 22:00 PT entry
  // belongs to Monday's trading day (its session opened Sunday 15:00), and
  // trusting the journal's calendar date there would build every session
  // window one day early, against an empty weekend tape.
  const pe = ptOf(t.entryMs)
  let rthDate = pe.date
  if (pe.sec >= ETH_START) {
    rthDate = addDays(rthDate, 1)
    while (['Sat', 'Sun'].includes(new Date(rthDate + 'T12:00:00Z').toUTCString().slice(0, 3))) rthDate = addDays(rthDate, 1)
  }
  const w = sessionWindows(rthDate)
  const prior = priorRthDate(rthDate)
  const wPrior = sessionWindows(prior)

  // One live read covers prior RTH + the overnight + today's developing RTH,
  // ending at the entry: every session-level fact, and nothing after it.
  const live = readDeltaByPrice(path, wPrior.rthStartMs, t.entryMs, {
    rowHeight: cfg.vpRow, priceDivisor: PRICE_DIVISOR,
  })
  if (!live.rows.length) return null
  const vpUnit = Math.round(cfg.vpRow * PRICE_DIVISOR)

  const sliceRows = (fromMs: number, toMs: number): Slim[] => {
    // per-row totals inside a window, from the visits (visit boundaries are
    // trade-timestamped, so a row chopped by the window keeps honest totals)
    const out: Slim[] = []
    for (const r of live.rows) {
      let v = 0, d = 0
      for (const vis of r.visits) {
        if (vis.endMs < fromMs || vis.startMs >= toMs) continue
        v += vis.volume; d += vis.delta
      }
      if (v > 0) out.push([Math.round(r.price * PRICE_DIVISOR), v, d])
    }
    return out.sort((a, b) => a[0] - b[0])
  }
  const sliceBars = (fromMs: number, toMs: number): DeltaBar[] =>
    live.bars.filter(b => b.ts >= fromMs && b.ts < toMs)

  const sessions: Array<[string, Slim[], DeltaBar[]]> = [
    ['prior_rth', sliceRows(wPrior.rthStartMs, wPrior.rthEndMs), sliceBars(wPrior.rthStartMs, t.entryMs)],
    ['gbx', sliceRows(w.ethStartMs, Math.min(w.rthStartMs, t.entryMs)), sliceBars(w.ethStartMs, t.entryMs)],
    ['rth_dev', sliceRows(w.rthStartMs, t.entryMs), sliceBars(w.rthStartMs, t.entryMs)],
  ]
  const profiles: TickflowResult['profiles'] = {}
  const lost: LostNode[] = []
  for (const [name, rows, bars] of sessions) {
    const p = profileOf(rows, vpUnit)
    profiles[name] = profSummary(p, t.entryPrice)
    if (p) lost.push(...lostNodesOf(name, p, bars, t.entryMs, t.entryPrice, t.tp1, t.stop, t.atr, t.adr))
  }

  // composites — the trader's 5d and 30d, rolling INCLUDING the developing day
  for (const [name, days, rowPts] of [['d5', 5, cfg.d5Row], ['d30', 30, cfg.d30Row]] as const) {
    if (rowPts == null) { profiles[name] = null; skipped.push(`${name}: ${root} row height unknown`); continue }
    const unit = Math.round(rowPts * PRICE_DIVISOR)
    const acc = new Map<number, [number, number]>()
    for (const d of priorTradingDays(path, root, rthDate, days - 1)) {
      const dr = dayRows(path, root, d)
      if (dr) sumSlim(acc, rebinSlim(dr, vpUnit, unit))
    }
    sumSlim(acc, rebinSlim(sliceRows(w.ethStartMs, t.entryMs), vpUnit, unit))
    const rows: Slim[] = Array.from(acc.entries()).map(([p, [v, d]]) => [p, v, d] as Slim).sort((a, b) => a[0] - b[0])
    profiles[name] = profSummary(profileOf(rows, unit), t.entryPrice)
  }

  // ── orderflow: significance at the FOOTPRINT rows, not the profile rows ──
  const deltaRows = rebinRows(live.rows.map(r => ({ ...r, visits: r.visits.map(v => ({ ...v })) })), cfg.deltaRow, 5 * 60_000)
  const det = detectDeltaLevels(deltaRows, live.bars, {
    rowHeight: cfg.deltaRow, breakDistance: cfg.deltaRow,
  })
  const sig = det.levels
    .filter(l => l.firstMs <= t.entryMs)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6)
  const between = (a: number, x1: number, x2: number) => a >= Math.min(x1, x2) && a <= Math.max(x1, x2)
  const significant_levels = sig.map(l => ({
    price: l.price, dist_pts: Math.round((l.price - t.entryPrice) * 100) / 100,
    side: (l.price >= t.entryPrice ? 'above' : 'below') as 'above' | 'below',
    delta: l.delta, kind: l.kind, strength: Math.round(l.strength * 100) / 100,
    formed_min_before_entry: Math.round((t.entryMs - l.firstMs) / 60_000),
    in_tp_path: t.tp1 != null && between(l.price, t.entryPrice, t.tp1),
    in_stop_path: t.stop != null && between(l.price, t.entryPrice, t.stop),
  }))

  const eUnit = Math.round(cfg.deltaRow * PRICE_DIVISOR)
  const eKey = Math.floor(Math.round(t.entryPrice * PRICE_DIVISOR) / eUnit) * eUnit
  const eRow = deltaRows.find(r => Math.round(r.price * PRICE_DIVISOR) === eKey)
  const eLvl = sig.find(l => Math.round(l.price * PRICE_DIVISOR) === eKey) ?? null
  const entry_rows = eRow ? {
    delta: eRow.delta, volume: eRow.volume,
    pct_of_large: det.threshold > 0 ? Math.round((Math.abs(eRow.delta) / det.threshold) * 100) : null,
    significant: Math.abs(eRow.delta) >= det.threshold && det.threshold > 0,
    kind: eLvl?.kind ?? null, strength: eLvl ? Math.round(eLvl.strength * 100) / 100 : null,
    threshold: Math.round(det.threshold),
  } : null

  // the last 10 minutes, read exactly (tiny window, binary-searched)
  const w10 = readDeltaByPrice(path, t.entryMs - 10 * 60_000, t.entryMs, {
    rowHeight: cfg.deltaRow, priceDivisor: PRICE_DIVISOR,
  })
  const window_10m = w10.tickCount > 0 ? {
    delta: w10.sessionDelta, volume: w10.sessionVolume,
    delta_is: (w10.sessionDelta === 0 ? 'flat'
      : (w10.sessionDelta > 0) === t.isLong ? 'with' : 'against') as 'with' | 'against' | 'flat',
  } : null

  return {
    file: basename(path),
    window_10m, entry_rows, significant_levels,
    profiles, lost_nodes: lost, skipped,
  }
}
