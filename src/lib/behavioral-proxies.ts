/**
 * Derived behavioral proxies — read a day's fills and surface the behavioral
 * patterns that per-trade analysis (which looks at each trade in isolation)
 * can't see: revenge/tilt re-entries, shrinking hold time, stacking the same
 * direction, and pressing size into a drawdown.
 *
 * (Stacking also reads the run's own fills to say where the market went, so a
 * losing run in the right direction isn't called a losing bias.)
 *
 * Extends the per-session TIMELINE idea from the recap route (buildDayTimeline)
 * into first-class DAY-LEVEL signals. Pure (its one import is the pure symbol
 * helpers) so it runs both
 * client-side (the EOD panel) and server-side (fed into the EOD AI read).
 *
 * These are OBSERVATIONS, not new scoring criteria — the deterministic Process
 * rails already score cooldown/size-up breaches. They exist to make the AI's
 * narrative (and the trader's own eye) catch behavioral drift across a session.
 */

import { chartSeriesRoot } from './futures-symbols'

export interface ProxyTrade {
  id: string
  direction: 'long' | 'short' | null
  entry_time: string | null
  exit_time: string | null
  pnl: number | null
  quantity: number | null
  /** Fills, instrument and stored ATR at entry: what the stacking proxy needs
   *  to say where the market went over a losing run. Optional: callers without
   *  them get the run labelled from P&L alone, as before. */
  entry_price?: number | null
  exit_price?: number | null
  symbol?: string | null
  entry_atr_1m?: number | null
}

/** Where the market went over a losing same-direction run, read from the run's
 *  own fills: first entry → last exit, in the instrument the run starts in.
 *  1 ATR (1-min, at the first entry) either way decides; in between = nowhere.
 *  Picked by the founder over "any amount" and "≥1 ATR only" on 2026-11-02,
 *  shown on their 29 losing runs since June. */
export type StackMarketReading = 'with' | 'against' | 'flat'

export interface StackMarket {
  reading: StackMarketReading
  /** "4 consecutive longs for −$271" */
  lead: string
  /** "pressing a losing bias" / "right direction, the entries cost you" / … */
  tag: string
  /** "NQ went 82 pts against you from your first entry (28,762) to …" */
  text: string
}

export type ProxySeverity = 'none' | 'mild' | 'flag'

export interface BehavioralProxy {
  key: 'revenge_reentry' | 'shrinking_hold' | 'stacking' | 'pressing_drawdown' | 'reopened_after_ending'
  label: string
  severity: ProxySeverity
  /** How many times the pattern occurred (or the run length for stacking). */
  count: number
  /** One-line interpreted description. Empty string when severity === 'none'. */
  detail: string
  /** 1-indexed session positions of the trades that evidence the pattern. */
  evidence: number[]
  /** Stacking only, on a losing run whose market move could be read. `detail`
   *  already says it as one sentence; this is the same text in parts. */
  market?: StackMarket
}

export interface BehavioralProxies {
  tradeCount: number
  /** True if any proxy is 'mild' or 'flag'. */
  hasSignal: boolean
  proxies: BehavioralProxy[]
}

// ── Tunables ────────────────────────────────────────────────────────────────
/** A re-entry within this many minutes of a losing exit reads as revenge/tilt. */
const REVENGE_GAP_MIN = 2
/** Min trades before hold-time trend or stacking is statistically meaningful. */
const MIN_TRADES_FOR_TREND = 4
/** Second-half median hold below this fraction of the first half = shrinking. */
const HOLD_SHRINK_FLAG = 0.5
const HOLD_SHRINK_MILD = 0.7
/** Same-direction run of this length is a stack worth flagging. */
const STACK_FLAG = 4
const STACK_MILD = 3

interface Row extends ProxyTrade {
  seq: number
  holdMin: number | null
  consecutiveSameDir: number
  gapFromPrevExitMin: number | null
  prevOutcome: 'win' | 'loss' | 'flat' | null
  runningPnlBefore: number
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function outcomeOf(pnl: number | null): 'win' | 'loss' | 'flat' | null {
  return pnl == null ? null : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'flat'
}

/** Build the ordered per-trade rows (mirrors the recap timeline, plus hold time
 *  and quantity, which the day-level proxies need). */
function buildRows(trades: ProxyTrade[]): Row[] {
  const sorted = [...trades].sort((a, b) => {
    const ta = a.entry_time ? Date.parse(a.entry_time) : Infinity
    const tb = b.entry_time ? Date.parse(b.entry_time) : Infinity
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const rows: Row[] = []
  let running = 0
  let prev: ProxyTrade | null = null
  let consec = 0
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]
    if (prev && t.direction && prev.direction === t.direction) consec++
    else consec = 1
    let gap: number | null = null
    if (prev?.exit_time && t.entry_time) {
      const g = (Date.parse(t.entry_time) - Date.parse(prev.exit_time)) / 60000
      gap = Number.isFinite(g) ? g : null
    }
    let hold: number | null = null
    if (t.entry_time && t.exit_time) {
      const h = (Date.parse(t.exit_time) - Date.parse(t.entry_time)) / 60000
      hold = Number.isFinite(h) && h >= 0 ? h : null
    }
    rows.push({
      ...t, seq: i + 1, holdMin: hold, consecutiveSameDir: consec,
      gapFromPrevExitMin: gap, prevOutcome: prev ? outcomeOf(prev.pnl) : null,
      runningPnlBefore: running,
    })
    running += t.pnl ?? 0
    prev = t
  }
  return rows
}

function fmtHold(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`
  if (min < 60) return `${min < 10 ? min.toFixed(1) : Math.round(min)}m`
  return `${(min / 60).toFixed(1)}h`
}

/** HH:MM in PT for an ISO/parseable timestamp — the trader's display timezone. */
function fmtPtTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '?'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
}

/**
 * Compute the behavioral proxies for one trading day's trades.
 *
 * `sessionEndedAt` (Pt 13 step 3) is the trading day's manual end-session
 * timestamp. When provided, a fifth "re-opened after ending" proxy is appended
 * for any trade entered after it — the revenge/tilt pattern of trading again
 * after calling it a day. Omit it and the proxy set is unchanged (four proxies),
 * so callers that don't have the timestamp behave exactly as before.
 *
 * `pressingIds` names the trades that pressed into drawdown when the caller can
 * read it the way TapeScore does (planned dollar risk against the trader's usual
 * spread: sizeUpTradeIds in src/lib/tapescore-day-rules.ts). Omit it and the
 * quantity rule below decides.
 *
 * `atrByTradeId` is the page's live ATR at each entry (the one behind R*); a
 * trade missing from it falls back to its stored `entry_atr_1m`. The stacking
 * proxy reads the market move over a losing run in those units.
 */
export function computeBehavioralProxies(
  trades: ProxyTrade[],
  sessionEndedAt?: string | null,
  opts: { pressingIds?: readonly string[] | null; atrByTradeId?: Readonly<Record<string, number>> | null } = {},
): BehavioralProxies {
  const rows = buildRows(trades)
  const n = rows.length
  const proxies: BehavioralProxy[] = []

  // 1. Revenge / tilt — quick re-entries after a loss (esp. same-direction).
  {
    const hits = rows.filter(r => r.prevOutcome === 'loss' && r.gapFromPrevExitMin != null && r.gapFromPrevExitMin < REVENGE_GAP_MIN)
    const sameDir = hits.filter(r => r.consecutiveSameDir > 1).length
    const count = hits.length
    const severity: ProxySeverity = count >= 2 ? 'flag' : count === 1 ? 'mild' : 'none'
    proxies.push({
      key: 'revenge_reentry', label: 'Revenge re-entries', severity, count,
      evidence: hits.map(r => r.seq),
      detail: count === 0 ? ''
        : `${count} re-entr${count === 1 ? 'y' : 'ies'} within ${REVENGE_GAP_MIN}m of a loss${sameDir ? ` (${sameDir} doubling the same direction)` : ''}`,
    })
  }

  // 2. Shrinking hold time — median hold collapsing across the session.
  {
    const withHold = rows.filter(r => r.holdMin != null) as (Row & { holdMin: number })[]
    let severity: ProxySeverity = 'none'
    let detail = ''
    let count = 0
    if (withHold.length >= MIN_TRADES_FOR_TREND) {
      const mid = Math.floor(withHold.length / 2)
      const firstMed = median(withHold.slice(0, mid).map(r => r.holdMin))
      const secondMed = median(withHold.slice(mid).map(r => r.holdMin))
      if (firstMed > 0 && secondMed < firstMed) {
        const ratio = secondMed / firstMed
        if (ratio <= HOLD_SHRINK_FLAG) severity = 'flag'
        else if (ratio <= HOLD_SHRINK_MILD) severity = 'mild'
        if (severity !== 'none') {
          count = Math.round((1 - ratio) * 100)
          detail = `median hold fell ${count}% — from ~${fmtHold(firstMed)} (first half) to ~${fmtHold(secondMed)} (second half)`
        }
      }
    }
    proxies.push({ key: 'shrinking_hold', label: 'Shrinking hold time', severity, count, detail, evidence: [] })
  }

  // 3. Stacking — longest same-direction run, harder-flagged if net-losing.
  {
    let bestLen = 0, bestStart = 0
    let curLen = 0, curStart = 0
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].consecutiveSameDir === 1) { curLen = 1; curStart = i }
      else curLen++
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart }
    }
    const run = rows.slice(bestStart, bestStart + bestLen)
    const runPnl = run.reduce((s, r) => s + (r.pnl ?? 0), 0)
    const dir = run[0]?.direction ?? ''
    let severity: ProxySeverity = 'none'
    if (bestLen >= STACK_FLAG || (bestLen >= STACK_MILD && runPnl < 0)) severity = 'flag'
    else if (bestLen >= STACK_MILD) severity = 'mild'
    const lead = `${bestLen} consecutive ${dir}s`
    // A losing run is only "pressing a losing bias" when the market went
    // against it. Unread (no fills or no ATR) keeps the P&L-only label.
    const market = severity !== 'none' && runPnl < 0
      ? stackMarket(run, `${lead} for ${fmtSignedUsd(runPnl)}`, opts.atrByTradeId ?? null)
      : null
    proxies.push({
      key: 'stacking', label: 'Stacking one direction', severity, count: bestLen,
      evidence: severity === 'none' ? [] : run.map(r => r.seq),
      detail: severity === 'none' ? ''
        : market ? `${market.lead} — ${market.tag}. ${market.text}`
        : `${lead}${runPnl < 0 ? ` for ${fmtSignedUsd(runPnl)} — pressing a losing bias` : ` (${fmtSignedUsd(runPnl)})`}`,
      ...(market ? { market } : {}),
    })
  }

  // 4. Pressing into drawdown — sizing up while red on the day or after a loss:
  //    the caller's TapeScore reading when given (dollar risk), else the
  //    quantity rule (pressingRows; TapeScore's fallback with no usual risk yet).
  {
    const pressing = opts.pressingIds ? new Set(opts.pressingIds) : null
    const hits = pressing ? rows.filter(r => pressing.has(r.id)) : pressingRows(rows)
    const count = hits.length
    const severity: ProxySeverity = count >= 2 ? 'flag' : count === 1 ? 'mild' : 'none'
    proxies.push({
      key: 'pressing_drawdown', label: 'Pressing into drawdown', severity, count,
      evidence: hits.map(r => r.seq),
      detail: count === 0 ? '' : `sized up ${count} time${count === 1 ? '' : 's'} while red on the day or right after a loss`,
    })
  }

  // 5. Re-opened after ending (Pt 13 step 3) — only when the day carries a manual
  //    end-session timestamp. Trading again after declaring "I'm done" is the
  //    revenge/tilt pattern the behavioral flags exist to catch, so any such
  //    trade is a flag. Appended only when sessionEndedAt is given, so callers
  //    without it keep the original four-proxy set.
  if (sessionEndedAt) {
    const endMs = Date.parse(sessionEndedAt)
    if (Number.isFinite(endMs)) {
      const after = rows.filter(r => r.entry_time != null && Date.parse(r.entry_time) > endMs)
      const count = after.length
      const times = after.map(r => fmtPtTime(r.entry_time as string))
      proxies.push({
        key: 'reopened_after_ending',
        label: 'Re-opened after ending',
        severity: count >= 1 ? 'flag' : 'none',
        count,
        evidence: after.map(r => r.seq),
        detail: count === 0 ? ''
          : `re-opened after calling it done — ${count} trade${count === 1 ? '' : 's'} at ${times.join(', ')}`,
      })
    }
  }

  return { tradeCount: n, hasSignal: proxies.some(p => p.severity !== 'none'), proxies }
}

/** Pressing into drawdown: a trade entered while the day's closed P&L was below
 *  zero or right after a loss, at a size bigger than ANY size already taken
 *  today — not merely bigger than the previous trade: going 5 → 3 → 5 is a
 *  return to normal size after a reduced trade, and flagging it was a false
 *  alarm. The day's first trade is never a hit. */
function pressingRows(rows: Row[]): Row[] {
  const hits: Row[] = []
  let maxSoFar = rows[0]?.quantity ?? 0
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    const q = r.quantity ?? 0
    if (q > maxSoFar && (r.runningPnlBefore < 0 || r.prevOutcome === 'loss')) hits.push(r)
    maxSoFar = Math.max(maxSoFar, q)
  }
  return hits
}

/** IDs of one day's trades that pressed into drawdown (proxy #4) — the single
 *  definition behind both the recap flag and TapeScore's "no size-up after a
 *  loss" rail. Pass one day's trades. */
export function pressingDrawdownIds(trades: ProxyTrade[]): string[] {
  return pressingRows(buildRows(trades)).map(r => r.id)
}

/**
 * IDs of one day's trades entered within `withinMin` minutes AFTER the exit of
 * an earlier losing trade that day (any earlier trade, not only the previous
 * one). A trade whose times are missing is never one. TapeScore's "Re-entries"
 * part judges these (5 minutes); the revenge proxy above is the tighter
 * previous-trade-only, 2-minute read.
 */
export function reentryAfterLossIds(trades: ProxyTrade[], withinMin: number): string[] {
  const rows = buildRows(trades)
  const out: string[] = []
  for (let i = 1; i < rows.length; i++) {
    const entry = rows[i].entry_time ? Date.parse(rows[i].entry_time as string) : NaN
    if (!Number.isFinite(entry)) continue
    const quick = rows.slice(0, i).some(u => {
      if (!(u.pnl != null && u.pnl < 0) || !u.exit_time) return false
      const gap = (entry - Date.parse(u.exit_time)) / 60000
      return Number.isFinite(gap) && gap >= 0 && gap <= withinMin
    })
    if (quick) out.push(rows[i].id)
  }
  return out
}

function fmtSignedUsd(n: number): string {
  const r = Math.round(n)
  return `${r >= 0 ? '+' : '−'}$${Math.abs(r)}`
}

const fmtPrice = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
/** Points moved: whole points from 10 up (NQ), to the tick below it (ES). */
const fmtPts = (n: number): string => (n >= 10 ? String(Math.round(n)) : fmtPrice(n))

/**
 * Where the market went over a losing run, from the run's own fills — not the
 * bar feed, whose root series sits in the next contract around a roll while
 * the trader's fills are still in the old one. First entry → last exit among
 * the trades in the instrument the run starts in (a run can mix NQ and ES).
 * Null when the prices, the exit or the ATR at the first entry are missing.
 */
function stackMarket(
  run: Row[], lead: string, atrByTradeId: Readonly<Record<string, number>> | null,
): StackMarket | null {
  const first = run[0]
  if (!first?.direction) return null
  const root = first.symbol ? chartSeriesRoot(first.symbol) : null
  const same = run.filter(r => (r.symbol ? chartSeriesRoot(r.symbol) : null) === root)
  const last = same
    .filter(r => r.exit_time != null && r.exit_price != null && Number.isFinite(Date.parse(r.exit_time)))
    .reduce<Row | null>((m, r) => (m == null || Date.parse(r.exit_time as string) > Date.parse(m.exit_time as string) ? r : m), null)
  const atr = atrByTradeId?.[first.id] ?? first.entry_atr_1m ?? null
  if (first.entry_price == null || last?.exit_price == null || atr == null || !(atr > 0)) return null

  const move = (first.direction === 'long' ? 1 : -1) * (last.exit_price - first.entry_price)
  const reading: StackMarketReading = move >= atr ? 'with' : move <= -atr ? 'against' : 'flat'
  const inst = root ?? 'Price'
  const span = `from your first entry (${fmtPrice(first.entry_price)}) to your last exit (${fmtPrice(last.exit_price)})`
  const went = move === 0 ? `${inst} ended where you started`
    : `${inst} went ${fmtPts(Math.abs(move))} pts ${move > 0 ? 'your way' : 'against you'}`
  if (reading === 'with') {
    return { reading, lead, tag: 'right direction, the entries cost you', text: `${went} (${(move / atr).toFixed(1)} ATR) ${span}.` }
  }
  if (reading === 'against') {
    return { reading, lead, tag: 'pressing a losing bias', text: `${went} ${span}.` }
  }
  return { reading, lead, tag: 'price went nowhere, the entries cost you', text: `${went} (under 1 ATR) ${span}.` }
}

/**
 * IDs of trades that are quick re-entries after a loss — the same
 * revenge/tilt pattern proxy #1 flags, exposed as a per-trade set so callers
 * that work across MANY days (the tag-free insight engine) can bucket "revenge
 * re-entry" vs "everything else" without re-deriving the gap logic. Pass one
 * day's trades at a time: the gap-from-previous-exit is only meaningful within
 * a session (buildRows sorts by entry_time and an overnight gap would never
 * clear REVENGE_GAP_MIN anyway, but grouping by day keeps the "previous trade"
 * honest). Returns the ids whose entry landed within REVENGE_GAP_MIN of a
 * losing exit — a strict subset of the day's trades.
 */
export function revengeReentryIds(trades: ProxyTrade[]): string[] {
  return buildRows(trades)
    .filter(r => r.prevOutcome === 'loss' && r.gapFromPrevExitMin != null && r.gapFromPrevExitMin < REVENGE_GAP_MIN)
    .map(r => r.id)
}

/** Format the proxies as an interpreted context block for an AI prompt. Returns
 *  '' when there are too few trades or no signal, so a clean session adds no
 *  prompt weight. Framed as observations, NOT scoring criteria. */
export function behavioralProxiesPromptBlock(trades: ProxyTrade[], sessionEndedAt?: string | null): string {
  // Stored entry_atr_1m on each trade stands in for the page's live ATR.
  const { tradeCount, hasSignal, proxies } = computeBehavioralProxies(trades, sessionEndedAt)
  if (tradeCount < 2 || !hasSignal) return ''
  const lines = proxies
    .filter(p => p.severity !== 'none')
    .map(p => `- ${p.severity === 'flag' ? '⚠ ' : ''}${p.label}: ${p.detail}`)
  return `SESSION BEHAVIORAL SIGNALS (derived from the fill sequence — OBSERVATIONS to weave into your narrative + coaching, NOT new scoring criteria; the deterministic Process rails already score cooldown/size-up breaches):
${lines.join('\n')}

`
}
