/**
 * The dashboard's written reads (founder, 2026-11-01 — the "scoreboard"
 * mockup): the one finding at the top of the page, why the period's biggest
 * days scored low, and the Scouting report's "What to do" lines.
 *
 * Pure: the dashboard passes the period's days and the reads it already has
 * (lift / drag, trade management), so these never fetch and never disagree
 * with the numbers printed beside them. Every line is built from a rule here —
 * nothing is said that the data doesn't show.
 */

import type { TapeScoreResult } from './tapescore'
import type { DayGlanceRead } from './day-glance'
import type { LiftDragView } from './lift-drag'
import type { MfeUnit } from './mfe-unit'

/** One trading day as these reads see it. */
export interface ReadDay {
  date: string
  eod_pnl: number | null
  trade_count: number
  tapescore: TapeScoreResult | null
  /** Rule IDs that failed (P1..P5). */
  process_breach_rules?: string[] | null
  glance_read?: DayGlanceRead | null
}

// ── The finding: days with few trades against days with many ───────────────

export interface SplitGroup {
  days: number
  green: number
  red: number
  /** Average P&L per day. */
  avg: number
  scoreMin: number | null
  scoreMax: number | null
  scoreAvg: number | null
}

export interface TradeCountSplit {
  /** "k trades or fewer" against "more than k". */
  k: number
  few: SplitGroup
  many: SplitGroup
}

/** Each side needs this many scored days before it can be compared. */
const MIN_SIDE = 3
/** The two sides' average TapeScores must differ by at least this much. */
const MIN_SCORE_GAP = 8

const traded = (days: readonly ReadDay[]) => days.filter(d => d.trade_count > 0 && d.eod_pnl != null)
const scoreOf = (d: ReadDay) => d.tapescore?.score ?? null

function group(days: readonly ReadDay[]): SplitGroup {
  const scores = days.map(scoreOf).filter((s): s is number => s != null)
  const pnl = days.reduce((s, d) => s + (d.eod_pnl ?? 0), 0)
  return {
    days: days.length,
    green: days.filter(d => (d.eod_pnl ?? 0) > 0).length,
    red: days.filter(d => (d.eod_pnl ?? 0) < 0).length,
    avg: days.length ? pnl / days.length : 0,
    scoreMin: scores.length ? Math.min(...scores) : null,
    scoreMax: scores.length ? Math.max(...scores) : null,
    scoreAvg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  }
}

/**
 * The trade count that best separates well-traded days from the rest: every
 * "k or fewer / more than k" cut is tried and the one whose two sides' average
 * TapeScores differ most wins (the smallest k on a tie). Null when no cut
 * leaves MIN_SIDE scored days on each side or the best gap is under
 * MIN_SCORE_GAP points.
 */
export function tradeCountSplit(days: readonly ReadDay[]): TradeCountSplit | null {
  const t = traded(days)
  const ks = [...new Set(t.map(d => d.trade_count))].sort((a, b) => a - b)
  let best: TradeCountSplit | null = null
  let bestGap = 0
  for (const k of ks) {
    const few = t.filter(d => d.trade_count <= k)
    const many = t.filter(d => d.trade_count > k)
    if (few.filter(d => scoreOf(d) != null).length < MIN_SIDE) continue
    if (many.filter(d => scoreOf(d) != null).length < MIN_SIDE) continue
    const a = group(few), b = group(many)
    const gap = Math.abs((a.scoreAvg ?? 0) - (b.scoreAvg ?? 0))
    if (gap > bestGap) { bestGap = gap; best = { k, few: a, many: b } }
  }
  return best && bestGap >= MIN_SCORE_GAP ? best : null
}

export interface Finding {
  headline: string
  /** When the headline is about the biggest days: one sentence tying those
   *  days to the table below it. Null = the table speaks for itself. */
  bridge: string | null
  /** The comparison table under the headline; null = headline alone. */
  split: TradeCountSplit | null
  /** One or two plain sentences under the table. */
  note: string | null
  /** The same cut over the days before the period, shown as its own column
   *  in the table; null = not enough days before it. */
  history: SplitHistory | null
  /** What the days before mean for the headline, set apart under the note;
   *  null = no history. */
  verdict: string | null
}

/** The period's three biggest green days that carry a TapeScore, biggest first. */
function biggestDays(days: readonly ReadDay[]): ReadDay[] {
  return traded(days)
    .filter(d => (d.eod_pnl ?? 0) > 0 && scoreOf(d) != null)
    .sort((a, b) => (b.eod_pnl ?? 0) - (a.eod_pnl ?? 0))
    .slice(0, 3)
}

const COUNT_WORD = ['', 'one', 'two', 'three']

/** The score a third of the way up the period's scored days. */
function scoreAtFraction(days: readonly ReadDay[], frac: number): number | null {
  const s = traded(days).map(scoreOf).filter((x): x is number => x != null).sort((a, b) => a - b)
  if (s.length === 0) return null
  return s[Math.floor((s.length - 1) * frac)]
}

/**
 * The one sentence the page opens on. In order, over the three biggest days:
 *   - all in the bottom third of the period's scores → "Your biggest days
 *     were your worst-traded days."
 *   - all under 70 → "Your three biggest days all scored under 70."
 *   - all in the top third → "…your best-traded days."
 *   - otherwise the trade-count cut, said as which side trades better.
 * Null when there is nothing clear to say; the page then falls back to the
 * TapeScore's own sentence. Needs at least 6 scored days. `history` (the days
 * before the period) adds one sentence on how the same cut paid before it.
 */
export function periodFinding(days: readonly ReadDay[], history: readonly ReadDay[] = [], since: string | null = null): Finding | null {
  const scored = traded(days).filter(d => scoreOf(d) != null)
  if (scored.length < 6) return null
  const split = tradeCountSplit(days)
  const big = biggestDays(days)
  const low = scoreAtFraction(days, 1 / 3)
  const high = scoreAtFraction(days, 2 / 3)
  let headline: string | null = null
  let aboutBig = true
  const all = (ok: (s: number) => boolean) => big.length >= 2 && big.every(d => ok(scoreOf(d) as number))
  if (low != null && all(s => s <= low)) {
    headline = 'Your biggest days were your worst-traded days.'
  } else if (all(s => s < 70)) {
    headline = `Your ${COUNT_WORD[big.length]} biggest days all scored under 70.`
  } else if (high != null && all(s => s >= high)) {
    headline = 'Your biggest days were your best-traded days.'
  } else if (split) {
    aboutBig = false
    const fewBetter = (split.few.scoreAvg ?? 0) > (split.many.scoreAvg ?? 0)
    headline = fewBetter
      ? `You trade better on days with ${tradesWord(split.k)} or fewer.`
      : `You trade better on days with more than ${tradesWord(split.k)}.`
  }
  if (!headline) return null
  const before = split ? splitHistory(history, split.k, since) : null
  const side = split && aboutBig ? bigSide(big, split) : null
  const bridge = split && aboutBig ? bigDaysBridge(big, split, before) : null
  return {
    headline, bridge, split,
    note: split ? splitNote(split, { money: !before }) || null : null,
    history: before,
    verdict: split && before ? historyVerdict(split, before, side) : null,
  }
}

/** Which side of the cut the biggest days all sit on; null = both sides. */
function bigSide(big: readonly ReadDay[], s: TradeCountSplit): 'few' | 'many' | null {
  if (big.every(d => d.trade_count > s.k)) return 'many'
  if (big.every(d => d.trade_count <= s.k)) return 'few'
  return null
}

/** Ties a headline about the biggest days to the trade-count table: "All
 *  three had 5 or more trades. Those busy days paid more this period, but
 *  before it they lost money:". Without history it says how they scored. */
function bigDaysBridge(big: readonly ReadDay[], s: TradeCountSplit, h: SplitHistory | null): string {
  const lead = big.length === 2 ? 'Both' : `All ${COUNT_WORD[big.length]}`
  const where = bigSide(big, s)
  if (!where) return 'The number of trades tells its own story:'
  const many = where === 'many'
  const side = many ? s.many : s.few
  const other = many ? s.few : s.many
  const had = `${lead} had ${many ? `${s.k + 1} or more trades` : `${tradesWord(s.k)} or fewer`}`
  const kind = many ? 'busy' : 'quiet'
  if (!h) {
    const lower = (side.scoreAvg ?? 0) < (other.scoreAvg ?? 0)
    return `${had}, and across the period the ${many ? 'busier' : 'quieter'} days scored ${lower ? 'lower' : 'higher'}:`
  }
  const hSide = many ? h.many : h.few
  const hOther = many ? h.few : h.many
  const paidNow = side.avg > other.avg
  const paidBefore = hSide.avg > hOther.avg
  if (paidNow && !paidBefore) return `${had}. Those ${kind} days paid more this period, but before it they ${hSide.avg < 0 ? 'lost money' : 'paid less'}:`
  if (paidNow) return `${had}. Those ${kind} days paid more this period, and before it too:`
  if (paidBefore) return `${had}. Those ${kind} days usually pay more, but not this period:`
  return `${had}, and those ${kind} days paid less this period and before it:`
}

// ── The same cut, before the period ─────────────────────────────────────────

export interface SplitHistory {
  few: SplitGroup
  many: SplitGroup
  /** Where the comparison starts: the chosen start date, else the earliest
   *  day counted. */
  from: string
}

/** Each side needs this many days before the period for it to be said. */
const MIN_HISTORY_SIDE = 5

/** The period's trade-count cut applied to the days before the period, from
 *  `since` on when the trader picked a start (the "Since" header). Null when
 *  either side has fewer than MIN_HISTORY_SIDE days. */
export function splitHistory(history: readonly ReadDay[], k: number, since: string | null = null): SplitHistory | null {
  const t = traded(history).filter(d => since == null || d.date >= since)
  const few = t.filter(d => d.trade_count <= k)
  const many = t.filter(d => d.trade_count > k)
  if (few.length < MIN_HISTORY_SIDE || many.length < MIN_HISTORY_SIDE) return null
  return { few: group(few), many: group(many), from: since ?? t.reduce((a, d) => (d.date < a ? d.date : a), t[0].date) }
}

/** Days with trades and a result from `since` on (all of them when null) —
 *  what the "Since" menu counts beside each choice. */
export function tradedSince(history: readonly ReadDay[], since: string | null): { days: number; first: string | null } {
  const t = traded(history).filter(d => since == null || d.date >= since)
  return { days: t.length, first: t.reduce<string | null>((a, d) => (a == null || d.date < a ? d.date : a), null) }
}

const signedUsd = (n: number) => `${n > 0.5 ? '+' : n < -0.5 ? '−' : ''}${usd(n)}`
const sinceDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** "This period was the exception. Before it (since Jan 6, 2026), days with
 *  5 or more trades averaged −$64 a day over 41 days; days with 4 or fewer,
 *  +$88 over 37." */
export function historyNote(s: TradeCountSplit, h: SplitHistory): string {
  const nowMany = s.many.avg > s.few.avg
  const beforeMany = h.many.avg > h.few.avg
  const lead = nowMany === beforeMany ? 'Before this period it was the same' : 'This period was the exception'
  return `${lead}. Before it (since ${sinceDate(h.from)}), days with ${s.k + 1} or more trades averaged ${signedUsd(h.many.avg)} a day over ${h.many.days} days; days with ${s.k} or fewer, ${signedUsd(h.few.avg)} over ${h.few.days}.`
}

const tradesWord = (n: number) => `${n} trade${n === 1 ? '' : 's'}`

/** What the days before the period mean for the headline: "Over the 142
 *  days you traded since Jan 1, 2026, the quieter days were the ones that
 *  paid, so your big busy days look like the exception, not your edge." The
 *  money now and before is in the table; this says what it adds up to. */
function historyVerdict(s: TradeCountSplit, h: SplitHistory, side: 'few' | 'many' | null): string {
  const nowMany = s.many.avg > s.few.avg
  const beforeMany = h.many.avg > h.few.avg
  const span = `Over the ${h.few.days + h.many.days} days you traded since ${sinceDate(h.from)}`
  if (nowMany === beforeMany) return `${span}, the ${beforeMany ? 'busier' : 'quieter'} days paid more too.`
  const big = side ? `your big ${side === 'many' ? 'busy' : 'quiet'} days look like` : 'this period looks like'
  return `${span}, the ${beforeMany ? 'busier' : 'quieter'} days were the ones that paid, so ${big} the exception, not your edge.`
}

/** "More trades made more money. Every red day came from the busier days.
 *  None of the busier days scored above 69." */
export function splitNote(s: TradeCountSplit, { money = true }: { money?: boolean } = {}): string {
  const out: string[] = []
  if (money && Math.abs(s.many.avg - s.few.avg) >= 1) {
    out.push(s.many.avg > s.few.avg ? 'More trades made more money.' : 'Fewer trades made more money.')
  }
  const reds = s.few.red + s.many.red
  if (reds > 0) {
    if (s.many.red === reds) out.push(reds === 1 ? 'Your red day came from the busier days.' : 'Every red day came from the busier days.')
    else if (s.few.red === reds) out.push(reds === 1 ? 'Your red day came from the quieter days.' : 'Every red day came from the quieter days.')
    else out.push(`${s.many.red} of your ${reds} red days came from the busier days.`)
  }
  if (s.many.scoreMax != null && s.few.scoreMin != null && s.many.scoreMax < s.few.scoreMin) {
    out.push(`None of the busier days scored above ${s.many.scoreMax}.`)
  } else if (s.few.scoreMax != null && s.many.scoreMin != null && s.few.scoreMax < s.many.scoreMin) {
    out.push(`None of the quieter days scored above ${s.few.scoreMax}.`)
  }
  return out.join(' ')
}

// ── Why the biggest days scored low ─────────────────────────────────────────

/** What a broken rail looks like in a sentence. */
const RAIL_WORDS: Record<string, string> = {
  P1: 'Went past your daily loss limit',
  P2: 'Went over your size cap',
  P3: 'Sized up after a loss',
  P4: 'Traded through your cooldown',
  P5: 'Went over your trade cap',
}

const usd = (n: number) => `$${Math.abs(Math.round(n)).toLocaleString('en-US')}`

/**
 * What TapeScore caught on a day, in plain lines, most serious first: broken
 * rules (and the cap they put on the score), chase trades, size against the
 * usual, trade count against the usual, P&L given back after the day's high.
 * At most four.
 */
export function dayReasons(d: ReadDay): string[] {
  const out: string[] = []
  const ts = d.tapescore
  if (ts?.capped) {
    const rails = (d.process_breach_rules ?? []).filter(id => RAIL_WORDS[id])
    if (rails.length) out.push(...rails.map(id => RAIL_WORDS[id]))
    else out.push('Broke one of your rules')
    out.push('A broken rule caps the day at 49')
  }
  if (ts && ts.chaseTrades > 0) {
    const n = ts.chaseTrades
    out.push(`${n} quick re-entr${n === 1 ? 'y' : 'ies'} after a loss with no fresh trigger${ts.chaseCapped && !ts.capped ? ' (caps the day at 69)' : ''}`)
  }
  const g = d.glance_read
  if (g?.risk?.off && g.risk.ratio != null) out.push(`Risked ${g.risk.ratio.toFixed(1)}× your usual per trade`)
  if (g?.trades?.off && g.trades.usual != null) out.push(`${tradesWord(g.trades.count)}; your usual is ${Math.round(g.trades.usual)}`)
  if (g?.high && g.high.peak > 0 && g.high.afterTrades > 0 && g.high.afterPnl < 0) {
    out.push(`Up ${usd(g.high.peak)} at the high, then gave back ${usd(g.high.afterPnl)} over ${g.high.afterTrades} more trade${g.high.afterTrades === 1 ? '' : 's'}`)
  }
  return out.slice(0, 4)
}

export interface WhyDay {
  date: string
  pnl: number
  trades: number
  score: number
  reasons: string[]
  axes: { risk: number | null; entry: number | null; exit: number | null }
}

export interface BigDaysWhy {
  title: string
  days: WhyDay[]
  /** A losing day that scored the same, said in one line; null = none. */
  twinNote: string | null
  /** What the big days have in common, in one line; null = nothing shared. */
  takeaway: string | null
}

/** The behaviours a day's reasons point at, in the order a takeaway names them. */
const THREADS: { id: string; words: string; on: (d: ReadDay) => boolean }[] = [
  { id: 'sizeAfterLoss', words: 'sized up after a loss', on: d => !!d.tapescore?.capped && (d.process_breach_rules ?? []).includes('P3') },
  {
    id: 'afterLoss',
    words: 'kept trading after a loss',
    on: d => (!!d.tapescore?.capped && (d.process_breach_rules ?? []).includes('P4')) || (d.tapescore?.chaseTrades ?? 0) > 0,
  },
  {
    id: 'overtrade',
    words: 'took more trades than your plan',
    on: d => (!!d.tapescore?.capped && (d.process_breach_rules ?? []).includes('P5')) || (!!d.glance_read?.trades?.off && (d.glance_read.trades.usual ?? Infinity) < d.trade_count),
  },
  { id: 'size', words: 'risked more than usual', on: d => (!!d.tapescore?.capped && (d.process_breach_rules ?? []).includes('P2')) || !!d.glance_read?.risk?.off },
  { id: 'limit', words: 'went past your loss limit', on: d => !!d.tapescore?.capped && (d.process_breach_rules ?? []).includes('P1') },
  { id: 'gaveBack', words: 'gave back from the high', on: d => !!d.glance_read?.high && d.glance_read.high.afterTrades > 0 && d.glance_read.high.afterPnl < 0 },
]

/** "The common thread: you sized up after a loss and took more trades than
 *  your plan, on all three days." Names up to two behaviours shared by every
 *  day, else by most of them. */
function commonThread(days: readonly ReadDay[]): string | null {
  const n = days.length
  if (n === 0) return null
  const counts = THREADS.map(t => ({ t, k: days.filter(t.on).length }))
  const all = counts.filter(c => c.k === n)
  let pick = all.length ? all : counts.filter(c => c.k > n / 2 && c.k >= 2)
  // "Sized up after a loss" already says the size and the loss.
  if (pick.some(c => c.t.id === 'sizeAfterLoss')) pick = pick.filter(c => c.t.id !== 'size')
  pick = pick.slice(0, 2)
  if (pick.length === 0) return null
  const k = Math.min(...pick.map(c => c.k))
  const ids = pick.map(c => c.t.id)
  const words = pick
    .map(c => (c.t.id === 'afterLoss' && ids.includes('sizeAfterLoss') ? 'kept going' : c.t.words))
    .join(' and ')
  if (n === 1) return `In short: you ${words}.`
  const scope = k === n ? (n === 2 ? 'on both days' : `on all ${COUNT_WORD[n] ?? n} days`) : `on ${COUNT_WORD[k] ?? k} of the ${COUNT_WORD[n] ?? n} days`
  return `The common thread: you ${words}, ${scope}.`
}

const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function whyDay(d: ReadDay): WhyDay {
  const c = d.tapescore?.components
  return {
    date: d.date,
    pnl: d.eod_pnl ?? 0,
    trades: d.trade_count,
    score: scoreOf(d) ?? 0,
    reasons: dayReasons(d),
    axes: { risk: c?.risk ?? null, entry: c?.entry ?? null, exit: c?.exit ?? null },
  }
}

/**
 * The period's biggest days that scored low (under 70 and at or below the
 * median) and where the score caught something, with what it caught, and the worst losing day whose
 * score sat at or below theirs — the same kind of trading with the opposite
 * result. Null when the biggest days scored well, or under 5 scored days.
 */
export function bigDaysWhy(days: readonly ReadDay[]): BigDaysWhy | null {
  const scoredN = traded(days).filter(d => scoreOf(d) != null).length
  if (scoredN < 5) return null
  const median = scoreAtFraction(days, 1 / 2)
  const big = biggestDays(days)
  const lowBig = big.filter(d => {
    const s = scoreOf(d)
    // A day with nothing to point at says nothing — it is left out.
    return s != null && s < 70 && median != null && s <= median && dayReasons(d).length > 0
  })
  if (lowBig.length === 0) return null
  const scores = lowBig.map(d => scoreOf(d) as number)
  const same = scores.every(s => s === scores[0])
  const title = lowBig.length > 1
    ? `Why your biggest days scored ${same ? scores[0] : 'under 70'}`
    : `Why your ${['', 'second-', 'third-'][big.indexOf(lowBig[0])]}biggest day scored ${scores[0]}`
  const ceiling = Math.max(...scores)
  const twin = traded(days)
    .filter(d => (d.eod_pnl ?? 0) < 0 && scoreOf(d) != null && (scoreOf(d) as number) <= ceiling)
    .sort((a, b) => (a.eod_pnl ?? 0) - (b.eod_pnl ?? 0))[0]
  const out = lowBig.map(whyDay)
  let twinNote: string | null = null
  if (twin) {
    out.push(whyDay(twin))
    const s = scoreOf(twin) as number
    twinNote = scores.includes(s)
      ? `${shortDate(twin.date)} also scored ${s} and lost ${usd(twin.eod_pnl ?? 0)}. Same score, opposite result.`
      : `${shortDate(twin.date)} scored ${s}, no better than these, and lost ${usd(twin.eod_pnl ?? 0)}. Same kind of trading, opposite result.`
  }
  return { title, days: out, twinNote, takeaway: commonThread(lowBig) }
}

// ── What to do ──────────────────────────────────────────────────────────────

export interface ScoutAction {
  title: string
  why: string
  /** Which part of the page it comes from. */
  source: string
  /** An extra line under it (the unit note). */
  note?: string
}

/** A lift/drag label inside a sentence: "Trades with the trend" → "trades
 *  with the trend"; a setup's own name keeps its capital. */
function inSentence(label: string): string {
  return /^(Trades|Entries|Stops|Targets|Re-entries|Same|Your)\b/.test(label)
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label
}

const UNIT_NAME: Record<MfeUnit, string> = { dollars: '$', pts: 'points', atr: 'ATR' }

/** "$82", "8.5 pts", "0.45× ATR" — unsigned, for a sentence. */
export function unitAmount(v: number, unit: MfeUnit): string {
  if (unit === 'dollars') return usd(v)
  if (unit === 'atr') return `${Math.abs(v).toFixed(2)}× ATR`
  return `${Math.abs(v).toFixed(1)} pts`
}

export interface MgmtRead {
  unit: MfeUnit
  wentCount: number
  neverCount: number
  /** Average worst point against, positive, in `unit`. */
  wentMae: number | null
  neverMae: number | null
}

/**
 * Up to four things to do, each from a part of the page:
 *   1. the trade-count cut, when the quieter days were all green or all 70+;
 *   2. keep doing what lifts the profit factor;
 *   3. be pickier with what drags it;
 *   4. a heat line, when trades that never got going went clearly further
 *      against you (20%+, 10+ trades each side) than the ones that worked.
 */
export function scoutingActions({ split, history = null, liftDrag, mgmt }: {
  split: TradeCountSplit | null
  /** The same cut over the days before the period (splitHistory). */
  history?: SplitHistory | null
  liftDrag: LiftDragView | null
  mgmt: MgmtRead | null
}): ScoutAction[] {
  const out: ScoutAction[] = []
  if (split && (split.few.scoreAvg ?? 0) > (split.many.scoreAvg ?? 0)) {
    // The quieter days trade better. Whether to cap trades depends on the
    // money: before the period when there is enough of it, else this period.
    const { k, few: f, many: m } = split
    const moreWord = `${k + 1}+ trade days`
    const fewWord = `${tradesWord(k)} or fewer`
    const nowMany = m.avg > f.avg
    const capPays = history ? history.few.avg >= history.many.avg : !nowMany
    if (capPays) {
      const quality = `${f.green === f.days ? 'all green' : `green ${f.green} of ${f.days}`}${f.scoreMin != null ? ` and scored ${f.scoreMin}+` : ''}`
      out.push({
        title: `Stop at ${tradesWord(k)} each day for a week`,
        why: history && nowMany
          ? `This period your ${moreWord} made more (${signedUsd(m.avg)} a day against ${signedUsd(f.avg)}). Before it they averaged ${signedUsd(history.many.avg)} a day against ${signedUsd(history.few.avg)} on days with ${fewWord}. This period those quieter days were ${quality}.`
          : history
            ? `Your days with ${fewWord} were ${quality}, and they paid more before this period too (${signedUsd(history.few.avg)} a day against ${signedUsd(history.many.avg)}).`
            : `Your days with ${fewWord} were ${quality}. See if the money holds up.`,
        source: history ? 'What this period says, and the days before it' : 'What this period says',
      })
    } else {
      const reds = f.red + m.red
      out.push({
        title: 'Keep the busy days, trade them cleaner',
        why: history
          ? `Your ${moreWord} paid more this period (${signedUsd(m.avg)} a day against ${signedUsd(f.avg)}) and before it (${signedUsd(history.many.avg)} against ${signedUsd(history.few.avg)}), but they score lower. Fix how you trade them, not how many.`
          : `Your ${moreWord} made ${signedUsd(m.avg)} a day against ${signedUsd(f.avg)}, but they score lower${m.red > 0 ? ` and held ${m.red === reds ? (reds === 1 ? 'your red day' : 'every red day') : `${m.red} of your ${reds} red days`}` : ''}. Fix how you trade them, not how many.`,
        source: history ? 'What this period says, and the days before it' : 'What this period says',
      })
    }
  }
  const pfSource = liftDrag?.extended ? `Profit factor, last ${liftDrag.sessions} sessions` : 'Profit factor'
  if (liftDrag?.lift) {
    const l = liftDrag.lift
    out.push({
      title: `Keep taking ${inSentence(l.label)}`,
      why: `${tradesWord(l.n)} lift your profit factor by ${Math.abs(l.delta).toFixed(2)}. Without them it would be ${l.pfWithout.toFixed(2)}.`,
      source: pfSource,
    })
  }
  if (liftDrag?.drag) {
    const d = liftDrag.drag
    out.push({
      title: `Be pickier with ${inSentence(d.label)}`,
      why: `${tradesWord(d.n)} drag your profit factor down by ${Math.abs(d.delta).toFixed(2)}. Without them it would be ${d.pfWithout.toFixed(2)}.`,
      source: pfSource,
    })
  }
  if (mgmt && mgmt.wentMae != null && mgmt.neverMae != null && mgmt.wentMae > 0
    && mgmt.wentCount >= 10 && mgmt.neverCount >= 10 && mgmt.neverMae >= mgmt.wentMae * 1.2) {
    const name = UNIT_NAME[mgmt.unit]
    out.push({
      title: `Treat a trade past ${unitAmount(mgmt.wentMae, mgmt.unit)} against you as a loser`,
      why: `Trades that went your way dipped ${unitAmount(mgmt.wentMae, mgmt.unit)} against you on average first; trades that never got going dipped ${unitAmount(mgmt.neverMae, mgmt.unit)}.`,
      source: 'Trade management',
      note: `In ${name} because Trade management is set to ${name}. Switch it there and this follows.`,
    })
  }
  return out
}
