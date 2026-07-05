/**
 * Per-user scoring profile — the risk/rules a trader captured in onboarding
 * (`/welcome/setup` → RulesStep), stored in `trader_profile.scoring_profile_json`.
 * The Coach Score grades against THIS instead of the owner's hardcoded Ruleset
 * v1.3, so every public user is judged in their own framework (see
 * feedback_no_forced_orderflow).
 *
 * Shape written by onboarding (all fields optional / nullable):
 *   {
 *     execution:      { uses_orderflow: boolean },
 *     risk_per_trade: { mode: 'R'|'$'|'%', value: number } | null,
 *     stop:           { mode: 'atr'|'pts',  value: number } | null,
 *     tp:             string | null,                 // free text, e.g. "2R"
 *     rails: {
 *       daily_loss_limit: number | null,
 *       max_size:         number | null,
 *       max_trades:       number | null,
 *       cooldown_min:     number | null,
 *       no_add_to_loser:  boolean,
 *     }
 *   }
 *
 * Design contract: an EMPTY profile must resolve to the owner's Ruleset v1.3
 * defaults so the owner's local app (no onboarding row) is byte-identical.
 *
 * This module is PURE (no server imports) so it's safe to bundle into the
 * client — the Coach Score badge/panel resolve the rubric in the browser. The
 * server-side fetch of `scoring_profile_json` lives in the coach-score route.
 */

export interface ScoringProfile {
  execution?: { uses_orderflow?: boolean | null } | null
  risk_per_trade?: { mode?: string | null; value?: number | null } | null
  stop?: { mode?: string | null; value?: number | null } | null
  tp?: string | null
  rails?: {
    daily_loss_limit?: number | null
    max_size?: number | null
    max_trades?: number | null
    cooldown_min?: number | null
    no_add_to_loser?: boolean | null
  } | null
}

/** Owner Ruleset v1.3 defaults — used whenever the profile omits a field. */
export const DEFAULT_RUBRIC = {
  /** Trade uses order flow (owner does). Gates the 2/3-OF criterion. */
  usesOrderFlow: true,
  /** Multiple of ATR the stop should sit near → band [0.5×, 1.5×] this. */
  atrStopTarget: 1,
  /** Planned TP1 must reach this R-multiple (else needs a logged reason). */
  tp1RMultiple: 2,
  /** Lot count above which a trade counts as a "size-up" (tighter stop + OF gate). */
  sizeUpLots: 5,
} as const

export interface ResolvedRubric {
  usesOrderFlow: boolean
  atrStopTarget: number
  tp1RMultiple: number
  sizeUpLots: number
}

/** Pull the first R-multiple out of a free-text TP target.
 *  "2R" → 2 · "scale 1/2 at 2R" → 2 · "1:2" (risk:reward) → 2 · "" → null. */
export function parseTpRMultiple(tp?: string | null): number | null {
  if (!tp || typeof tp !== 'string') return null
  // "<n>R" — the common case (also catches "at 2R", "3.5R").
  const rMatch = tp.match(/(\d+(?:\.\d+)?)\s*R\b/i)
  if (rMatch) {
    const n = parseFloat(rMatch[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  // "1:2" risk:reward ratio → reward ÷ risk.
  const ratio = tp.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/)
  if (ratio) {
    const risk = parseFloat(ratio[1]), reward = parseFloat(ratio[2])
    if (Number.isFinite(risk) && Number.isFinite(reward) && risk > 0 && reward > 0) return reward / risk
  }
  return null
}

/** Collapse a per-user scoring profile down to the concrete thresholds the
 *  Coach Score needs. Missing fields fall back to the owner's v1.3 defaults, so
 *  an empty/undefined profile reproduces the pre-wiring behavior exactly. */
export function resolveRubric(sp?: ScoringProfile | null): ResolvedRubric {
  const usesOF = sp?.execution?.uses_orderflow
  const stopMode = sp?.stop?.mode?.toLowerCase()
  const stopVal = sp?.stop?.value
  const atrStopTarget =
    stopMode === 'atr' && typeof stopVal === 'number' && stopVal > 0
      ? stopVal
      : DEFAULT_RUBRIC.atrStopTarget
  return {
    usesOrderFlow: usesOF == null ? DEFAULT_RUBRIC.usesOrderFlow : !!usesOF,
    atrStopTarget,
    tp1RMultiple: parseTpRMultiple(sp?.tp) ?? DEFAULT_RUBRIC.tp1RMultiple,
    sizeUpLots: DEFAULT_RUBRIC.sizeUpLots,
  }
}

/** One-line human summary of a profile's rules, for the AI prompt. Empty string
 *  when nothing meaningful is set. */
export function scoringProfileSummary(sp?: ScoringProfile | null): string {
  if (!sp) return ''
  const parts: string[] = []
  if (sp.risk_per_trade?.value != null) parts.push(`risk ${sp.risk_per_trade.value}${sp.risk_per_trade.mode ?? ''} per trade`)
  if (sp.stop?.value != null) parts.push(`stop ${sp.stop.value} ${sp.stop.mode === 'pts' ? 'pts' : '× ATR'}`)
  if (sp.tp) parts.push(`TP target: ${sp.tp}`)
  const rails = sp.rails ?? {}
  if (rails.daily_loss_limit != null) parts.push(`daily loss limit $${rails.daily_loss_limit}`)
  if (rails.max_size != null) parts.push(`max size ${rails.max_size}`)
  if (rails.max_trades != null) parts.push(`max ${rails.max_trades} trades/day`)
  if (rails.cooldown_min != null) parts.push(`${rails.cooldown_min}min cooldown after a loss`)
  if (rails.no_add_to_loser) parts.push('never adds to a loser')
  return parts.join(' · ')
}
