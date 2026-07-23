/**
 * Derived behavioral proxies — read a day's fills and surface the behavioral
 * patterns that per-trade analysis (which looks at each trade in isolation)
 * can't see: revenge/tilt re-entries, shrinking hold time, stacking the same
 * direction, and pressing size into a drawdown.
 *
 * Extends the per-session TIMELINE idea from the recap route (buildDayTimeline)
 * into first-class DAY-LEVEL signals. Pure + dependency-free so it runs both
 * client-side (the EOD panel) and server-side (fed into the EOD AI read).
 *
 * These are OBSERVATIONS, not new scoring criteria — the deterministic Process
 * rails already score cooldown/size-up breaches. They exist to make the AI's
 * narrative (and the trader's own eye) catch behavioral drift across a session.
 */

export interface ProxyTrade {
  id: string
  direction: 'long' | 'short' | null
  entry_time: string | null
  exit_time: string | null
  pnl: number | null
  quantity: number | null
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
 */
export function computeBehavioralProxies(
  trades: ProxyTrade[],
  sessionEndedAt?: string | null,
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
    proxies.push({
      key: 'stacking', label: 'Stacking one direction', severity, count: bestLen,
      evidence: severity === 'none' ? [] : run.map(r => r.seq),
      detail: severity === 'none' ? ''
        : `${bestLen} consecutive ${dir}s${runPnl < 0 ? ` for ${fmtSignedUsd(runPnl)} — pressing a losing bias` : ` (${fmtSignedUsd(runPnl)})`}`,
    })
  }

  // 4. Pressing into drawdown — sizing up while red on the day or after a loss.
  {
    const hits: Row[] = []
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], p = rows[i - 1]
      const q = r.quantity ?? 0, pq = p.quantity ?? 0
      if (q > pq && (r.runningPnlBefore < 0 || r.prevOutcome === 'loss')) hits.push(r)
    }
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

function fmtSignedUsd(n: number): string {
  const r = Math.round(n)
  return `${r >= 0 ? '+' : '−'}$${Math.abs(r)}`
}

/** Format the proxies as an interpreted context block for an AI prompt. Returns
 *  '' when there are too few trades or no signal, so a clean session adds no
 *  prompt weight. Framed as observations, NOT scoring criteria. */
export function behavioralProxiesPromptBlock(trades: ProxyTrade[], sessionEndedAt?: string | null): string {
  const { tradeCount, hasSignal, proxies } = computeBehavioralProxies(trades, sessionEndedAt)
  if (tradeCount < 2 || !hasSignal) return ''
  const lines = proxies
    .filter(p => p.severity !== 'none')
    .map(p => `- ${p.severity === 'flag' ? '⚠ ' : ''}${p.label}: ${p.detail}`)
  return `SESSION BEHAVIORAL SIGNALS (derived from the fill sequence — OBSERVATIONS to weave into your narrative + coaching, NOT new scoring criteria; the deterministic Process rails already score cooldown/size-up breaches):
${lines.join('\n')}

`
}
