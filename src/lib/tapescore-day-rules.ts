import type { EodAiAnalysis, ProcessVerdict, RuleStatus } from '@/lib/supabase/types'
import { pressingDrawdownIds, reentryAfterLossIds, type ProxyTrade } from '@/lib/behavioral-proxies'
import { exitKind } from '@/lib/trade-management'
import { plannedRiskDollars, type RiskYardstick } from '@/lib/exit-score'
import type { StopSource } from '@/lib/planned-stop'

/**
 * What TapeScore reads from a day's TRADES to correct the stored end-of-day
 * analysis (founder-directed, 2026-10-14). All at read time — the analysis
 * prompt is unchanged and history re-scores with no re-analysis.
 *
 *   1  Daily loss limit is a HARD breach. When the trader tracks the daily
 *      loss limit (P1) and it failed, the day is a Breach — capped at 49 —
 *      however many other rules held. Untracked, it changes nothing.
 *   2  "No size-up after a loss" (P3) is recomputed from the trades against
 *      the trader's USUAL RISK SPREAD: a trade fails when, at its entry, the
 *      day's closed P&L was below zero or the previous trade lost, AND its
 *      planned dollar risk (stop distance × size × contract multiplier) is
 *      bigger than mean + 2 SD of the trader's recent planned dollar risk —
 *      the same yardstick Risk's "Loss size" reads (src/lib/exit-rollup.ts), so
 *      both read one set of numbers. A trade without a stop can't be judged.
 *      With no yardstick yet (< 5 stop trades before the day) the day falls
 *      back to the quantity rule:
 *      bigger than every size already traded that day (the recap's "Pressing
 *      into drawdown", src/lib/behavioral-proxies.ts). The rule fails if any
 *      trade fails. Only when P3 is tracked. Because the yardstick belongs to
 *      the read, a day stores `SizeUpInputs` and the status is resolved when
 *      the days are read in sequence — like Loss size.
 *   3  The checklist item "no mistakes tagged" is the share of the day's trades
 *      with no mistake tags, read from the trades themselves — the stored AI
 *      value is sometimes missing when every trade carries mistakes. A day on
 *      which no trade has tags at all leaves the item not applicable.
 *
 * Plus the trade-level read Risk's "Re-entries" part needs (see
 * `hasFreshTrigger`).
 */

/** A trade as these rules read it (every field optional — a trade missing one
 *  simply can't trip the rule that needs it). */
export interface RulesTrade {
  id?: string | null
  direction?: 'long' | 'short' | null
  entry_time?: string | null
  exit_time?: string | null
  pnl?: number | null
  quantity?: number | null
  entry_price?: number | null
  stop_price?: number | null
  /** Sierra's stop history: planned risk reads the planned stop (src/lib/planned-stop.ts). */
  stops?: StopSource['stops']
  review_json?: unknown
  symbol?: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tags_json?: any
}

/** The same trades in the shape the behavioral proxies read; a trade without
 *  an id gets its position, so ids stay unique within the day. */
export function toProxyTrades(trades: readonly RulesTrade[]): ProxyTrade[] {
  return trades.map((t, i) => ({
    id: t.id ?? `#${i}`, direction: t.direction ?? null, entry_time: t.entry_time ?? null,
    exit_time: t.exit_time ?? null, pnl: t.pnl ?? null, quantity: t.quantity ?? null,
  }))
}

/** Does the trader track this rail? Rows without `active_rails` grade all five. */
function tracks(p: ProcessVerdict, id: string): boolean {
  return p.active_rails ? p.active_rails.includes(id as never) : true
}

/** Rule 1: the tracked daily loss limit failed. */
export function dailyLossLimitBroken(p: ProcessVerdict | null | undefined): boolean {
  if (!p?.per_rule || !tracks(p, 'P1')) return false
  return (p.per_rule as Record<string, RuleStatus | undefined>).P1?.status === 'fail'
}

// ── Rule 2 · no size-up after a loss ──────────────────────────────────────

/** Planned dollar risk above the trader's mean + this many SDs is a size-up. */
export const SIZE_UP_SDS = 2

/** What rule 2 needs from a day's trades before the trader's average is known.
 *  JSON-safe — cached with the day's other per-trade inputs. */
export interface SizeUpInputs {
  /** One entry per trade entered while the day was red or right after a loss:
   *  its planned dollar risk, or null when it has no logged stop. */
  pressed: Array<number | null>
  /** How many trades fail the quantity rule — the fallback with no average. */
  qty_hits: number
}

/** The trades rule 2 reads — entered while the day was red or right after a
 *  loss — in entry order, each with its id (a trade without one gets its
 *  position, as `toProxyTrades`). */
function pressedTrades(trades: readonly RulesTrade[]): Array<{ t: RulesTrade; id: string }> {
  const order = trades.map((t, i) => ({ t, id: t.id ?? `#${i}` })).sort((a, b) => {
    const ta = a.t.entry_time ? Date.parse(a.t.entry_time) : Infinity
    const tb = b.t.entry_time ? Date.parse(b.t.entry_time) : Infinity
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const out: Array<{ t: RulesTrade; id: string }> = []
  let running = 0
  let prevLost = false
  order.forEach((o, k) => {
    if (k > 0 && (running < 0 || prevLost)) out.push(o)
    running += o.t.pnl ?? 0
    prevLost = o.t.pnl != null && o.t.pnl < 0
  })
  return out
}

/** Rule 2's inputs from one day's trades, in entry order. */
export function sizeUpInputs(trades: readonly RulesTrade[]): SizeUpInputs {
  return {
    pressed: pressedTrades(trades).map(({ t }) => plannedRiskDollars(t)),
    qty_hits: pressingDrawdownIds(toProxyTrades(trades)).length,
  }
}

/** Rule 2: how many trades sized up past the trader's usual risk spread
 *  (null yardstick = none yet → the quantity rule). */
export function sizeUpFails(inp: SizeUpInputs | null | undefined, yardstick: RiskYardstick | null): number {
  if (!inp) return 0
  if (!yardstick || !(yardstick.mean > 0)) return inp.qty_hits ?? 0
  const limit = yardstick.mean + SIZE_UP_SDS * yardstick.sd
  return (inp.pressed ?? []).filter(r => r != null && r > limit + 1e-9).length
}

/** The trades rule 2 fails, by id — the same reading as `sizeUpFails`, for a
 *  surface that names them (the Session behavior panel's "Pressing into
 *  drawdown"; founder 2026-10-20: a bigger size at the same dollar risk, for a
 *  quieter market, is not pressing). Null yardstick = the quantity rule. */
export function sizeUpTradeIds(trades: readonly RulesTrade[], yardstick: RiskYardstick | null): string[] {
  if (!yardstick || !(yardstick.mean > 0)) return pressingDrawdownIds(toProxyTrades(trades))
  const limit = yardstick.mean + SIZE_UP_SDS * yardstick.sd
  return pressedTrades(trades)
    .filter(({ t }) => { const r = plannedRiskDollars(t); return r != null && r > limit + 1e-9 })
    .map(({ id }) => id)
}

/**
 * The audit with rule 2's result applied (`fails` = trades that sized up; null
 * leaves P3 as stored) and the verdict re-derived the way the analysis derives
 * it (tracked rails: more fails than the one lapse allowed with 4+ rails;
 * otherwise 4 of 5 kept), then rule 1 on top. Returns the input unchanged when
 * nothing moves.
 */
export function applySizeUp(p: ProcessVerdict | null | undefined, fails: number | null): ProcessVerdict | null {
  if (!p?.per_rule) return p ?? null
  const perRule = { ...(p.per_rule as Record<string, RuleStatus | undefined>) }
  const legacyShape = 'P6' in perRule || 'P7' in perRule
  let changed = false

  if (fails != null && !legacyShape && tracks(p, 'P3')) {
    const status: RuleStatus['status'] = fails > 0 ? 'fail' : 'pass'
    if (perRule.P3?.status !== status) {
      perRule.P3 = {
        status,
        breach_count: fails,
        reason: fails > 0
          ? `After a loss or while red, risked more than your usual risk spread (${fails} trade${fails === 1 ? '' : 's'}).`
          : 'No trade after a loss or while red risked more than your usual risk spread.',
      }
      changed = true
    }
  }

  let verdict = p.verdict
  if (changed) {
    if (p.active_rails && p.active_rails.length > 0) {
      const failed = p.active_rails.filter(id => perRule[id]?.status === 'fail').length
      verdict = failed > (p.active_rails.length >= 4 ? 1 : 0) ? 'Breach' : 'Compliant'
    } else {
      const ids = legacyShape ? ['P1', 'P2', 'P3', 'P5', 'P6'] : ['P1', 'P2', 'P3', 'P4', 'P5']
      verdict = ids.filter(id => perRule[id]?.status === 'pass').length >= 4 ? 'Compliant' : 'Breach'
    }
  }
  const next = { ...p, per_rule: perRule as ProcessVerdict['per_rule'], verdict }
  if (dailyLossLimitBroken(next)) next.verdict = 'Breach'
  return changed || next.verdict !== p.verdict ? next : p
}

/**
 * The day's rules audit as TapeScore reads it: rule 1 always; rule 2 only when
 * the trader's risk yardstick going into the day is passed — or null for "no
 * yardstick yet". Left `undefined`, P3 stays as stored: the per-day rollup
 * resolves it later, in sequence (see scoreDayRollups).
 */
export function effectiveProcess(
  p: ProcessVerdict | null | undefined,
  trades: readonly RulesTrade[] | null | undefined,
  yardstick?: RiskYardstick | null,
): ProcessVerdict | null {
  const fails = trades && yardstick !== undefined ? sizeUpFails(sizeUpInputs(trades), yardstick) : null
  return applySizeUp(p, fails)
}

// ── Rule 3 · no mistakes tagged ───────────────────────────────────────────

/** Rule 3: share of the day's trades (0..1) with no mistake tags; null when no
 *  trade carries tags at all. */
export function noMistakesShare(trades: readonly RulesTrade[] | null | undefined): number | null {
  if (!trades || trades.length === 0) return null
  if (!trades.some(t => t.tags_json && typeof t.tags_json === 'object')) return null
  const clean = trades.filter(t => {
    const m = t.tags_json?.mistakes
    return !(Array.isArray(m) && m.some(x => typeof x === 'string' && x.trim() !== ''))
  }).length
  return clean / trades.length
}

/**
 * The analysis as TapeScore (and the Recap's rules card) reads it: rule 1
 * applied to the audit, rule 2 when `yardstick` is passed (see
 * effectiveProcess), rule 3 to the checklist breakdown. Without trades only
 * rule 1 applies. Never mutates the stored object.
 */
export function effectiveAnalysis(
  eod: EodAiAnalysis | null | undefined,
  trades: readonly RulesTrade[] | null | undefined,
  yardstick?: RiskYardstick | null,
): EodAiAnalysis | null {
  if (!eod) return eod ?? null
  const process = eod.process ? effectiveProcess(eod.process, trades, yardstick) : eod.process
  let execution = eod.execution
  const b = execution?.execution_parameter_breakdown
  if (execution && b && trades) {
    const share = noMistakesShare(trades)
    if (share !== b.no_mistakes_tagged) {
      execution = { ...execution, execution_parameter_breakdown: { ...b, no_mistakes_tagged: share } }
    }
  }
  return process === eod.process && execution === eod.execution ? eod : { ...eod, process, execution } as EodAiAnalysis
}

// ── Re-entries ─────────────────────────────────────────────────────────────

/** Minutes after a losing exit within which a new entry counts as a re-entry. */
export const REENTRY_WINDOW_MIN = 5

/** Risk's "Re-entries" part: a quick re-entry after a loss PASSES when its entry
 *  model names a trigger other than "Based on Price" — new information — and
 *  fails when the entry model is empty or only "Based on Price". */
export function hasFreshTrigger(t: RulesTrade): boolean {
  const em: unknown = t.tags_json?.entry_model
  return Array.isArray(em) && em.some(x => typeof x === 'string' && x.trim() !== '' && x.trim().toLowerCase() !== 'based on price')
}

// ── Chase trades ───────────────────────────────────────────────────────────
//
// A CHASE TRADE is a quick re-entry after a loss (within REENTRY_WINDOW_MIN of
// a losing exit) with no fresh trigger: the trades Risk's "Re-entries" part
// fails. Founder, 2026-10-19 (approved mockup docs/chase-score-mockup.html):
// since May they lost $2,914 over 118 trades while the 40 re-entries WITH a
// fresh trigger made $2,193, so they now also cost the day (2 or more cap its
// TapeScore at 69, src/lib/tapescore.ts) and each trade (a "Waited after a
// loss" part in its Score, src/lib/trade-grade.ts).

/** Trades with what "how did the losing trade end" needs (all optional). */
export type ReentryTrade = RulesTrade & {
  exit_price?: number | null
  tp1_price?: number | null
  high_during_position?: number | null
  low_during_position?: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json?: any
}

/** One quick re-entry after a loss, as its trade's Score reads it. */
export interface ReentryRead {
  /** It named a fresh trigger (`hasFreshTrigger`): passes. Else it's a chase trade. */
  fresh: boolean
  /** Seconds from the losing exit it came off. */
  gapSec: number
  /** That losing exit (UTC ISO), and whether the losing trade was stopped out. */
  afterExit: string
  afterStopOut: boolean
  /** Its entry models, as tagged. */
  triggers: string[]
}

/**
 * Every quick re-entry after a loss in one day's trades, by trade id (a trade
 * without an id gets its position, as `toProxyTrades`). The losing exit read is
 * the latest one within REENTRY_WINDOW_MIN before the entry — the same window
 * and the same "any earlier losing trade" rule as Risk's "Re-entries" part.
 */
export function reentryReads(trades: readonly ReentryTrade[]): Map<string, ReentryRead> {
  const proxies = toProxyTrades(trades)
  const ids = new Set(reentryAfterLossIds(proxies, REENTRY_WINDOW_MIN))
  const out = new Map<string, ReentryRead>()
  trades.forEach((t, i) => {
    const id = proxies[i].id
    if (!ids.has(id)) return
    const entry = Date.parse(t.entry_time ?? '')
    let prior: ReentryTrade | null = null, priorMs = -Infinity
    for (const u of trades) {
      if (u === t || !(u.pnl != null && u.pnl < 0) || !u.exit_time) continue
      const ms = Date.parse(u.exit_time)
      const gapMin = (entry - ms) / 60_000
      if (Number.isFinite(gapMin) && gapMin >= 0 && gapMin <= REENTRY_WINDOW_MIN && ms > priorMs) { prior = u; priorMs = ms }
    }
    if (!prior) return
    const em: unknown = t.tags_json?.entry_model
    out.set(id, {
      fresh: hasFreshTrigger(t),
      gapSec: Math.round((entry - priorMs) / 1000),
      afterExit: prior.exit_time as string,
      afterStopOut: exitKind(prior as unknown as Parameters<typeof exitKind>[0]) === 'stopped',
      triggers: Array.isArray(em) ? em.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [],
    })
  })
  return out
}

/** The day's chase trades (quick re-entries after a loss with no fresh trigger), oldest first. */
export function chaseTrades<T extends ReentryTrade>(trades: readonly T[]): T[] {
  const reads = reentryReads(trades)
  const proxies = toProxyTrades(trades)
  return trades
    .filter((_, i) => reads.get(proxies[i].id)?.fresh === false)
    .sort((a, b) => String(a.entry_time ?? '').localeCompare(String(b.entry_time ?? '')))
}
