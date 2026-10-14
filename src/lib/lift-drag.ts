import { rMultiple } from '@/lib/analytics'
import { deriveEntryFeatures, ENTRY_FEATURES } from '@/lib/derived-features'
import { symbolRoot } from '@/lib/futures-symbols'
import type { TradeTags } from '@/lib/supabase/types'

/**
 * What is lifting the profit factor, and what is dragging it down — the two
 * lines under "Net per trade" on the dashboard's Trade management card.
 *
 * Replaces the hidden finding callout (src/lib/finding-callout.ts). That picked
 * ONE carry-over finding and turned it into an instruction; this names the one
 * thing that moves the trader's profit factor most in each direction and says
 * by how much, with how many trades and a range. Facts, not advice.
 *
 * ── THE MEASURE ──
 * Profit factor in R (R won ÷ R lost), so position size cannot decide the
 * answer. A group "lifts" it when the book without that group would have a
 * lower profit factor: lift = PF(all) − PF(every other trade). That counts how
 * OFTEN something happens as well as how good each one is — 103 slightly-red
 * trades can drag harder than 10 very red ones, which an R-per-trade gap
 * cannot see.
 *
 * ── HOW IT PICKS ──
 * Every candidate gets an 80% range from reshuffling whole sessions (a session
 * bootstrap). The lifter is the candidate whose range sits furthest above zero
 * at its LOW end; the drag is the one furthest below zero at its HIGH end, from
 * a different dimension than the lifter (so "targets of 3R or more" can't come
 * back as "targets closer than 3R"). Nothing clears zero → that side shows
 * nothing. Ranking on the middle of the range picked shaky drags whose range
 * crossed zero.
 *
 * Every factor is knowable at the moment of entry (see derived-features.ts for
 * why): what was tagged as the setup / confluence / order-flow read / entry
 * model, the planned stop and target, trade number and spacing, direction,
 * instrument, time of day, size against the trader's usual, structure. Tags
 * written after the fact — trade management, emotions, mistakes, hindsight
 * confluences — restate the outcome, so they never compete. Day-level market
 * context (day RVOL, IB regime) is left out too: a first-hour entry can't
 * know it yet.
 *
 * A factor must be at most half the window's trades — otherwise the majority
 * side of a split ("trades with a stop logged") wins by default — and have at
 * least 10 trades with an R on each side.
 *
 * ── VALIDATION (founder's book, 2026-10-13) ──
 * 1,364 trades / 272 sessions, walked forward: pick in a window, check the next
 * 20 sessions. With a 60-session window the lifter was still better than the
 * rest next month ~7 times in 10 and the drag still worse ~8 in 10 (a random
 * factor on the same side: ~6 in 10); the gap next month ran ~60% of the one
 * shown. A 15-session window (≈ Last 30 Days) was about as often right on
 * direction, but showed ~3× what held up and changed pick almost weekly —
 * hence `windowFor`'s 60-session floor (founder's choice: follow the Period
 * menu, but never fewer than 60 sessions). Ranking in dollars held up worse
 * than ranking in R.
 */

/** Sessions the window never drops below. */
export const MIN_SESSIONS = 60
/** Trades with an R needed on BOTH sides of a comparison. */
const MIN_N = 10
/** Below this many trades with an R in the window, nothing is named. */
const MIN_WINDOW_N = 20
/** A factor may cover at most this share of the window's trades. */
const MAX_SHARE = 0.5
/** Session reshuffles behind each range. Fixed seed: same data, same answer
 *  on every load, so the card never flickers between two near-tied factors. */
const RESAMPLES = 400
/** 80% range: the 10th and 90th percentiles. */
const RANGE_Q = 0.1

export interface LiftDragTrade {
  id: string
  trading_day_id: string | null
  /** The session's date (YYYY-MM-DD). The caller maps trading_day_id → date. */
  date: string
  pnl: number | null
  entry_price: number | null
  stop_price: number | null
  quantity: number | null
  direction: string | null
  symbol: string | null
  entry_time: string | null
  exit_time?: string | null
  tp1_price?: number | null
  entry_atr_1m?: number | null
  tags_json: TradeTags | null
  structure_5m_alignment?: 'following' | 'fading' | 'neutral' | null
  /** Pivot market structure at entry (bull / bear / neutral). Not on the
   *  generated Trade type, so callers pass it through structurally. */
  structure_5m_regime?: string | null
}

export interface LiftDragFactor {
  /** Stable identity, e.g. "entry_model:Break of Clusters/Bubbles". */
  key: string
  /** Plain words for the card, e.g. "Break of Clusters/Bubbles entries". */
  label: string
  /** Trades in the group. */
  n: number
  /** Share of the group's trades that made money, 0..1. */
  winRate: number | null
  /** The group's own profit factor (R). Null when it never lost. */
  pf: number | null
  /** Every other trade in the window — the true complement. */
  restN: number
  restWinRate: number | null
  /** Profit factor of every other trade = the window's profit factor without
   *  this group. */
  pfWithout: number
  /** pf(all) − pfWithout: positive lifts, negative drags. */
  delta: number
  /** 80% session-bootstrap range of `delta`. */
  lo: number
  hi: number
}

export interface LiftDragResult {
  /** The window's profit factor in R. */
  pf: number
  trades: number
  sessions: number
  from: string
  to: string
  /** How many factors were in the running — the pick is the best of these. */
  candidates: number
  lift: LiftDragFactor | null
  drag: LiftDragFactor | null
}

// ── Factors ──────────────────────────────────────────────────────────────────

/** Confluence tags that describe what happened after the entry. */
const HINDSIGHT = /would'?ve|scratched|before going|price hit target|came back|gotten stopped/i

const TAG_FAMILIES: Array<{ cat: keyof TradeTags; noun: (label: string) => string }> = [
  { cat: 'setups', noun: l => (/\btrade$/i.test(l) ? `${l}s` : `${l} trades`) },
  { cat: 'confluences', noun: l => `${l} trades` },
  { cat: 'order_flow', noun: l => `${l} trades` },
  { cat: 'entry_model', noun: l => `${l} entries` },
]

/** Plain words for each derived feature's two sides; null = that side is a
 *  leftover bucket ("every entry that didn't …"), never named on its own. */
const DERIVED_LABELS: Record<string, { on: string; off: string | null }> = {
  'reentry-fast': { on: 'Re-entries within 5 minutes of an exit', off: 'Entries more than 5 minutes after an exit' },
  'same-dir-after-loss': { on: 'Same direction straight after a loss', off: null },
  'third-plus': { on: 'Your third trade of the day or later', off: 'Your first two trades of the day' },
  'tight-stop': { on: 'Stops under half an ATR', off: 'Stops of half an ATR or more' },
  'wide-target': { on: 'Targets of 3R or more', off: 'Targets closer than 3R' },
  'fading-structure': { on: 'Trades against the 5m EMA-20 trend', off: 'Trades with the 5m EMA-20 trend' },
}

const PT_MINUTES = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
})
function timeBucket(iso: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const [h, m] = PT_MINUTES.format(new Date(ms)).split(':').map(Number)
  const min = h * 60 + m
  // Exchange-anchored regular session, 06:30–13:00 PT (src/lib/rth.ts).
  if (min < 390 || min >= 780) return 'Entries outside regular hours'
  if (min < 450) return 'Entries in the first hour (6:30–7:30 PT)'
  if (min < 540) return 'Entries 7:30–9:00 PT'
  if (min < 660) return 'Entries 9:00–11:00 PT'
  return 'Entries 11:00–13:00 PT'
}

/** One trade's place on every dimension: dimension → level (null = can't be
 *  classified there, so it joins neither side). */
type Dims = Map<string, string | null>

/** Every trade's dimensions. Each one is fixed by the trade and its own
 *  session, so the scopes compute this once for the whole book and share it;
 *  only "usual size" depends on which trades are passed (the most common
 *  quantity among them). */
export function dimensionsOf(trades: LiftDragTrade[]): Map<string, Dims> {
  const feats = deriveEntryFeatures(trades as never)
  // Usual size = the most common quantity per instrument, in this window.
  const sizes = new Map<string, Map<number, number>>()
  for (const t of trades) {
    if (t.quantity == null) continue
    const root = symbolRoot(t.symbol ?? '')
    const m = sizes.get(root) ?? new Map<number, number>()
    m.set(t.quantity, (m.get(t.quantity) ?? 0) + 1)
    sizes.set(root, m)
  }
  const usual = new Map([...sizes].map(([root, m]) => [root, [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]]))

  // The previous trade's result, for "right after a win / a loss".
  const prevPnl = new Map<string, number | null>()
  const bySession = new Map<string, LiftDragTrade[]>()
  for (const t of trades) {
    const k = t.trading_day_id ?? t.date
    bySession.set(k, [...(bySession.get(k) ?? []), t])
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => String(a.entry_time ?? '').localeCompare(String(b.entry_time ?? '')))
    list.forEach((t, i) => prevPnl.set(t.id, i > 0 ? list[i - 1].pnl : null))
  }

  // Tag universe per category, so a journaled trade without the label reads
  // "no" while a trade with nothing tagged in that category reads null.
  const universe = new Map<keyof TradeTags, Set<string>>()
  for (const t of trades) for (const { cat } of TAG_FAMILIES) {
    for (const l of tagList(t.tags_json, cat)) {
      if (cat === 'confluences' && HINDSIGHT.test(l)) continue
      const s = universe.get(cat) ?? new Set<string>()
      s.add(l)
      universe.set(cat, s)
    }
  }

  const out = new Map<string, Dims>()
  for (const t of trades) {
    const d: Dims = new Map()
    for (const { cat } of TAG_FAMILIES) {
      const mine = new Set(tagList(t.tags_json, cat))
      for (const label of universe.get(cat) ?? []) {
        d.set(`${cat}:${label}`, mine.size === 0 ? null : mine.has(label) ? 'yes' : 'no')
      }
    }
    const f = feats.get(t.id)
    for (const def of ENTRY_FEATURES) {
      const v = f ? def.test(f) : null
      d.set(`entry:${def.key}`, v == null ? null : v ? 'on' : 'off')
    }
    d.set('seq:first', f ? (f.seq === 1 ? 'on' : 'off') : null)
    const prev = prevPnl.get(t.id)
    d.set('seq:after', prev == null || prev === 0 ? null : prev > 0 ? 'win' : 'loss')

    const regime = t.structure_5m_regime
    d.set('structure', regime === 'bull' || regime === 'bear'
      ? ((regime === 'bull') === (t.direction === 'long') ? 'follow' : 'fade')
      : regime === 'neutral' ? 'neutral' : null)
    d.set('direction', t.direction === 'long' || t.direction === 'short' ? t.direction : null)
    const root = symbolRoot(t.symbol ?? '')
    d.set('instrument', root || null)
    d.set('time', timeBucket(t.entry_time))
    const u = usual.get(root)
    d.set('size', t.quantity == null || u == null ? null : t.quantity > u ? 'above' : t.quantity < u ? 'below' : 'usual')
    d.set('stop', t.stop_price != null ? 'logged' : 'none')
    out.set(t.id, d)
  }
  return out
}

function tagList(tags: TradeTags | null, cat: keyof TradeTags): string[] {
  const raw = tags?.[cat]
  return Array.isArray(raw) ? raw.map(l => String(l).trim()).filter(Boolean) : []
}

/** Which levels of a dimension may be named on the card, and in what words. */
function labelFor(dim: string, level: string): string | null {
  const colon = dim.indexOf(':')
  const head = colon < 0 ? dim : dim.slice(0, colon)
  const rest = colon < 0 ? '' : dim.slice(colon + 1)
  const fam = TAG_FAMILIES.find(f => f.cat === head)
  if (fam) return level === 'yes' ? fam.noun(rest) : null
  if (head === 'entry') {
    const l = DERIVED_LABELS[rest]
    return l ? (level === 'on' ? l.on : l.off) : null
  }
  if (dim === 'seq:first') return level === 'on' ? 'Your first trade of the day' : 'Trades after your first of the day'
  if (dim === 'seq:after') return level === 'win' ? 'Entries right after a win' : 'Entries right after a loss'
  if (dim === 'structure') {
    return level === 'follow' ? 'Following 5m market structure'
      : level === 'fade' ? 'Fading 5m market structure'
        : 'When 5m market structure was neutral'
  }
  if (dim === 'direction') return level === 'long' ? 'Long trades' : 'Short trades'
  if (dim === 'instrument') return `${level} trades`
  if (dim === 'time') return level
  if (dim === 'size') return level === 'above' ? 'Trades above your usual size' : level === 'below' ? 'Trades below your usual size' : 'Trades at your usual size'
  if (dim === 'stop') return level === 'none' ? 'Trades with no stop logged' : 'Trades with a stop logged'
  return null
}

// ── The pick ─────────────────────────────────────────────────────────────────

function profitFactor(won: number, lost: number): number | null {
  return lost > 0 ? won / lost : null
}

/**
 * The lifter and the drag over one window of trades (whole sessions), or null
 * when the window is too thin to say anything. Pure and deterministic.
 */
export function liftDrag(trades: LiftDragTrade[], dimsIn?: Map<string, Dims>): LiftDragResult | null {
  const book = trades.filter(t => t.pnl != null)
  if (book.length === 0) return null
  const rOf = new Map<string, number>()
  for (const t of book) {
    const r = rMultiple(t as never)
    if (r != null && Number.isFinite(r)) rOf.set(t.id, r)
  }
  if (rOf.size < MIN_WINDOW_N) return null

  const days = [...new Set(book.map(t => t.date))].sort()
  const dayIx = new Map(days.map((d, i) => [d, i]))
  const D = days.length
  const wonAll = new Float64Array(D), lostAll = new Float64Array(D)
  for (const t of book) {
    const r = rOf.get(t.id)
    if (r == null) continue
    const i = dayIx.get(t.date)!
    if (r > 0) wonAll[i] += r
    else lostAll[i] -= r
  }
  const sum = (a: Float64Array) => a.reduce((s, x) => s + x, 0)
  const pfAll = profitFactor(sum(wonAll), sum(lostAll))
  if (pfAll == null) return null

  const dims = dimsIn ?? dimensionsOf(book)
  const N = book.length
  const rArr = new Float64Array(N), hasR = new Uint8Array(N), dayArr = new Int32Array(N)
  let decidedAll = 0, winsAll = 0
  book.forEach((t, k) => {
    const r = rOf.get(t.id)
    if (r != null) { rArr[k] = r; hasR[k] = 1 }
    dayArr[k] = dayIx.get(t.date)!
    decidedAll++
    if ((t.pnl ?? 0) > 0) winsAll++
  })

  // One pass per dimension: bucket the trades by level, and count how many
  // trades with an R the dimension can classify at all (the comparison side).
  interface Bucket { idx: number[]; nR: number }
  const byDim = new Map<string, { buckets: Map<string, Bucket>; classifiedR: number }>()
  book.forEach((t, k) => {
    for (const [dim, level] of dims.get(t.id)!) {
      if (level == null) continue
      let e = byDim.get(dim)
      if (!e) { e = { buckets: new Map(), classifiedR: 0 }; byDim.set(dim, e) }
      let bkt = e.buckets.get(level)
      if (!bkt) { bkt = { idx: [], nR: 0 }; e.buckets.set(level, bkt) }
      bkt.idx.push(k)
      if (hasR[k]) { bkt.nR++; e.classifiedR++ }
    }
  })

  // A candidate keeps only the sessions it traded in (sparse), which is what
  // makes the reshuffles cheap on a long book.
  interface Cand { dim: string; level: string; label: string; idx: number[]; days: Int32Array; won: Float64Array; lost: Float64Array; wonSum: number; lostSum: number }
  const cands: Cand[] = []
  const wonTotal = sum(wonAll), lostTotal = sum(lostAll)
  for (const dim of [...byDim.keys()].sort()) {
    const { buckets, classifiedR } = byDim.get(dim)!
    for (const level of [...buckets.keys()].sort()) {
      const label = labelFor(dim, level)
      if (!label) continue
      const { idx, nR } = buckets.get(level)!
      if (nR < MIN_N || classifiedR - nR < MIN_N || idx.length > MAX_SHARE * N) continue
      const perDay = new Map<number, [number, number]>()
      let wonSum = 0, lostSum = 0
      for (const k of idx) {
        if (!hasR[k]) continue
        const r = rArr[k]
        const cell = perDay.get(dayArr[k]) ?? [0, 0]
        if (r > 0) { cell[0] += r; wonSum += r } else { cell[1] -= r; lostSum -= r }
        perDay.set(dayArr[k], cell)
      }
      if (lostTotal - lostSum <= 0) continue
      const entries = [...perDay]
      cands.push({
        dim, level, label, idx,
        days: Int32Array.from(entries.map(e => e[0])),
        won: Float64Array.from(entries.map(e => e[1][0])),
        lost: Float64Array.from(entries.map(e => e[1][1])),
        wonSum, lostSum,
      })
    }
  }
  if (cands.length === 0) {
    return { pf: pfAll, trades: N, sessions: D, from: days[0], to: days[D - 1], candidates: 0, lift: null, drag: null }
  }

  // Session bootstrap: one resample of days, applied to every candidate.
  const deltas: number[][] = cands.map(() => [])
  const weight = new Float64Array(D)
  let seed = 20261013
  const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x80000000 }
  for (let b = 0; b < RESAMPLES; b++) {
    weight.fill(0)
    for (let i = 0; i < D; i++) weight[Math.floor(rand() * D)]++
    let wa = 0, la = 0
    for (let i = 0; i < D; i++) { wa += weight[i] * wonAll[i]; la += weight[i] * lostAll[i] }
    if (la <= 0) continue
    for (let j = 0; j < cands.length; j++) {
      const c = cands[j]
      let wg = 0, lg = 0
      for (let m = 0; m < c.days.length; m++) { const w = weight[c.days[m]]; if (w) { wg += w * c.won[m]; lg += w * c.lost[m] } }
      if (la - lg <= 0) continue
      deltas[j].push(wa / la - (wa - wg) / (la - lg))
    }
  }

  const factors: LiftDragFactor[] = []
  cands.forEach((c, j) => {
    const ds = deltas[j].sort((a, b) => a - b)
    if (ds.length < RESAMPLES * 0.8) return
    const pfWithout = (wonTotal - c.wonSum) / (lostTotal - c.lostSum)
    let winsG = 0
    for (const k of c.idx) if ((book[k].pnl ?? 0) > 0) winsG++
    const restN = N - c.idx.length
    factors.push({
      key: `${c.dim}:${c.level}`,
      label: c.label,
      n: c.idx.length,
      winRate: c.idx.length ? winsG / c.idx.length : null,
      pf: profitFactor(c.wonSum, c.lostSum),
      restN,
      restWinRate: restN ? (winsAll - winsG) / (decidedAll - c.idx.length) : null,
      pfWithout,
      delta: pfAll - pfWithout,
      lo: ds[Math.floor(ds.length * RANGE_Q)],
      hi: ds[Math.floor(ds.length * (1 - RANGE_Q))],
    })
  })
  const dimOf = (f: LiftDragFactor) => f.key.slice(0, f.key.lastIndexOf(':'))

  const lift = factors
    .filter(f => f.lo > 0)
    .sort((a, b) => b.lo - a.lo || b.delta - a.delta)[0] ?? null
  const drag = factors
    .filter(f => f.hi < 0 && (!lift || dimOf(f) !== dimOf(lift)))
    .sort((a, b) => a.hi - b.hi || a.delta - b.delta)[0] ?? null

  return { pf: pfAll, trades: N, sessions: D, from: days[0], to: days[D - 1], candidates: factors.length, lift, drag }
}

// ── Windows ──────────────────────────────────────────────────────────────────

/**
 * The window a period is read over: the period itself when it holds at least
 * MIN_SESSIONS sessions, otherwise the last MIN_SESSIONS sessions up to the
 * period's end. `sessionDates` = every date with a trade, any order.
 */
export function windowFor(
  sessionDates: string[],
  start: string,
  end: string,
): { start: string; end: string; extended: boolean } | null {
  const upToEnd = [...new Set(sessionDates)].filter(d => d <= end).sort()
  if (upToEnd.length === 0) return null
  const inPeriod = upToEnd.filter(d => d >= start)
  if (inPeriod.length >= MIN_SESSIONS) return { start: inPeriod[0], end: inPeriod[inPeriod.length - 1], extended: false }
  const last = upToEnd.slice(-MIN_SESSIONS)
  return { start: last[0], end: last[last.length - 1], extended: true }
}

/** One lift/drag read as the card needs it: the result plus whether the
 *  period had to be widened to reach MIN_SESSIONS. */
export interface LiftDragView extends LiftDragResult {
  extended: boolean
}

/**
 * Reads for every dashboard scope the card can be showing — each Period-menu
 * option ("p:30d") and each Filter time range ("r:3m") — keyed by scope.
 * Scopes that resolve to the same window are computed once.
 *
 * The bounds mirror DashboardStats' periodBounds and DashboardFilterScope's
 * rangeStart, anchored on the server's `today` (PT).
 */
export function liftDragByScope(trades: LiftDragTrade[], today: string): Record<string, LiftDragView | null> {
  const dates = trades.map(t => t.date)
  const y = Number(today.slice(0, 4))
  const t0 = new Date(`${today}T12:00:00Z`)
  const shift = (days: number) => { const d = new Date(t0); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10) }
  const monthsBack = (m: number) => { const d = new Date(t0); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString().slice(0, 10) }
  const weekday = (t0.getUTCDay() + 6) % 7
  const scopes: Record<string, [string, string]> = {
    'p:all': ['2000-01-01', today],
    'p:week': [shift(weekday), today],
    'p:month': [`${today.slice(0, 7)}-01`, today],
    'p:30d': [shift(30), today],
    'p:ytd': [`${y}-01-01`, today],
    'p:last_year': [`${y - 1}-01-01`, `${y - 1}-12-31`],
    'r:1m': [monthsBack(1), today],
    'r:3m': [monthsBack(3), today],
    'r:6m': [monthsBack(6), today],
    'r:ytd': [`${y}-01-01`, today],
    'r:1y': [monthsBack(12), today],
    'r:all': ['2000-01-01', today],
  }
  const dims = dimensionsOf(trades.filter(t => t.pnl != null))
  const cache = new Map<string, LiftDragView | null>()
  const out: Record<string, LiftDragView | null> = {}
  for (const [key, [start, end]] of Object.entries(scopes)) {
    const w = windowFor(dates, start, end)
    if (!w) { out[key] = null; continue }
    const id = `${w.start}|${w.end}|${w.extended}`
    if (!cache.has(id)) {
      const r = liftDrag(trades.filter(t => t.date >= w.start && t.date <= w.end), dims)
      cache.set(id, r && { ...r, extended: w.extended })
    }
    out[key] = cache.get(id) ?? null
  }
  return out
}

/** "+0.54" / "−0.41" — signed, two decimals, real minus sign. */
export function formatPfDelta(x: number): string {
  return `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(2)}`
}
