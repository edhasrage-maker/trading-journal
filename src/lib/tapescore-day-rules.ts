import type { EodAiAnalysis, ProcessVerdict, RuleStatus } from '@/lib/supabase/types'
import { pressingDrawdownIds, type ProxyTrade } from '@/lib/behavioral-proxies'

/**
 * What TapeScore reads from a day's TRADES to correct the stored end-of-day
 * analysis (founder-directed, 2026-10-14). All at read time — the analysis
 * prompt is unchanged and history re-scores with no re-analysis.
 *
 *   1  Daily loss limit is a HARD breach. When the trader tracks the daily
 *      loss limit (P1) and it failed, the day is a Breach — capped at 49 —
 *      however many other rules held. Untracked, it changes nothing.
 *   2  "No size-up after a loss" (P3) is recomputed from the trades with the
 *      recap's "Pressing into drawdown" definition (src/lib/behavioral-proxies.ts):
 *      a trade fails when, at its entry, the day was red or the previous trade
 *      lost, AND it is bigger than every size already traded that day. The
 *      rule fails if any trade fails. Only when P3 is tracked.
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

/**
 * The day's rules audit with rule 2 applied (when trades are given) and the
 * verdict re-derived the way the analysis derives it (tracked rails: more fails
 * than the one lapse allowed with 4+ rails; otherwise 4 of 5 kept), then rule 1
 * on top. Returns the input unchanged when nothing moves.
 */
export function effectiveProcess(
  p: ProcessVerdict | null | undefined,
  trades: readonly RulesTrade[] | null | undefined,
): ProcessVerdict | null {
  if (!p?.per_rule) return p ?? null
  const perRule = { ...(p.per_rule as Record<string, RuleStatus | undefined>) }
  const legacyShape = 'P6' in perRule || 'P7' in perRule
  let changed = false

  if (trades && !legacyShape && tracks(p, 'P3')) {
    const hits = pressingDrawdownIds(toProxyTrades(trades))
    const status: RuleStatus['status'] = hits.length > 0 ? 'fail' : 'pass'
    if (perRule.P3?.status !== status) {
      perRule.P3 = {
        status,
        breach_count: hits.length,
        reason: hits.length > 0
          ? `Sized up after a loss or while red on the day (${hits.length} trade${hits.length === 1 ? '' : 's'}).`
          : 'No size-up after a loss or while red on the day.',
      }
      changed = true
    }
  }

  let verdict = p.verdict
  if (changed) {
    if (p.active_rails && p.active_rails.length > 0) {
      const fails = p.active_rails.filter(id => perRule[id]?.status === 'fail').length
      verdict = fails > (p.active_rails.length >= 4 ? 1 : 0) ? 'Breach' : 'Compliant'
    } else {
      const ids = legacyShape ? ['P1', 'P2', 'P3', 'P5', 'P6'] : ['P1', 'P2', 'P3', 'P4', 'P5']
      verdict = ids.filter(id => perRule[id]?.status === 'pass').length >= 4 ? 'Compliant' : 'Breach'
    }
  }
  const next = { ...p, per_rule: perRule as ProcessVerdict['per_rule'], verdict }
  if (dailyLossLimitBroken(next)) next.verdict = 'Breach'
  return changed || next.verdict !== p.verdict ? next : p
}

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
 * The analysis as TapeScore (and the Recap's rules card) reads it: rules 1–2
 * applied to the audit, rule 3 to the checklist breakdown. Without trades only
 * rule 1 applies. Never mutates the stored object.
 */
export function effectiveAnalysis(
  eod: EodAiAnalysis | null | undefined,
  trades: readonly RulesTrade[] | null | undefined,
): EodAiAnalysis | null {
  if (!eod) return eod ?? null
  const process = eod.process ? effectiveProcess(eod.process, trades) : eod.process
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

/** Minutes after a losing exit within which a new entry counts as a re-entry. */
export const REENTRY_WINDOW_MIN = 5

/** Risk's "Re-entries" part: a quick re-entry after a loss PASSES when its entry
 *  model names a trigger other than "Based on Price" — new information — and
 *  fails when the entry model is empty or only "Based on Price". */
export function hasFreshTrigger(t: RulesTrade): boolean {
  const em: unknown = t.tags_json?.entry_model
  return Array.isArray(em) && em.some(x => typeof x === 'string' && x.trim() !== '' && x.trim().toLowerCase() !== 'based on price')
}
