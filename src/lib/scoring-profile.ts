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

// ─── Session-level safety rails (Pt 2 — multi-tenant EOD Process scoring) ─────
// The per-DAY EOD analyzer's Process layer (P1..P5) grades against these. The
// per-trade Coach Score above handles Execution criteria; the rails are a
// separate concern (session-level), resolved here so `computeDeterministicRules`
// in eod-prompt.ts stays free of hardcoded founder constants.

type PRuleId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5'

/** Concrete numbers the deterministic P-rules need. A `null` rail is one the
 *  trader never set → that rule is INACTIVE (auto-pass, excluded from the
 *  verdict count). `isOwner` marks the empty-profile fallback so P2 stays
 *  AI-driven (the founder's cap is setup-conditional — 10 on Qualifying S&D). */
export interface RailConfig {
  isOwner: boolean
  /** Daily loss limit as a NEGATIVE dollar figure; null = no DLL rule. */
  dailyLossLimit: number | null
  /** Slippage buffer on the DLL (a stop that fills past the limit isn't a breach). */
  dllBuffer: number
  /** Max position size (contracts); null = no size rule. */
  maxSize: number | null
  /** When true, P2 (size cap) is computed deterministically (qty ≤ maxSize).
   *  Owner = false (P2 left to the AI for the S&D 10-lot exception). */
  p2Deterministic: boolean
  /** Post-loss size cap (contracts) for P3; = maxSize. null = no P3 rule. */
  postLossCap: number | null
  /** Cooldown after a loss in SECONDS; null = no cooldown rule. */
  cooldownSec: number | null
  /** Max trades per session; null = no trade-cap rule. */
  tradeCap: number | null
}

/** The founder's Ruleset v1.3 rails — the fallback for an empty/absent profile,
 *  matching the constants previously hardcoded in `computeDeterministicRules`.
 *  An empty profile resolving to THIS is what keeps the founder's grading
 *  byte-identical. */
export const OWNER_RAILS: RailConfig = {
  isOwner: true,
  dailyLossLimit: -500,
  dllBuffer: 50,
  maxSize: 5,
  p2Deterministic: false,   // owner P2 stays AI-driven (10 MNQ on Qualifying S&D)
  postLossCap: 5,
  cooldownSec: 90,
  tradeCap: 7,
}

/** True when the profile carries no gradable rules → resolve to the owner
 *  (v1.3) rubric. The founder's local DB has no scoring_profile_json column at
 *  all, so a fetch there yields `{}` → true → owner path. */
export function isEmptyScoringProfile(sp?: ScoringProfile | null): boolean {
  if (!sp || typeof sp !== 'object') return true
  if (sp.risk_per_trade?.value != null) return false
  if (sp.stop?.value != null) return false
  if (sp.tp) return false
  const r = sp.rails ?? {}
  if (r.daily_loss_limit != null || r.max_size != null || r.max_trades != null || r.cooldown_min != null || r.no_add_to_loser) return false
  if (sp.execution && sp.execution.uses_orderflow != null) return false
  return true
}

/** Collapse a per-user scoring profile into the concrete P-rule numbers. Empty
 *  profile → OWNER_RAILS (founder parity). Units per RulesStep.tsx:
 *  `cooldown_min` is minutes; `daily_loss_limit` is a positive magnitude the
 *  user typed → negated here. */
export function resolveRails(sp?: ScoringProfile | null): RailConfig {
  if (isEmptyScoringProfile(sp)) return { ...OWNER_RAILS }
  const r = sp!.rails ?? {}
  const maxSize = r.max_size != null ? r.max_size : null
  return {
    isOwner: false,
    dailyLossLimit: r.daily_loss_limit != null ? -Math.abs(r.daily_loss_limit) : null,
    dllBuffer: 50,
    maxSize,
    p2Deterministic: maxSize != null,
    postLossCap: maxSize,
    cooldownSec: r.cooldown_min != null ? r.cooldown_min * 60 : null,
    tradeCap: r.max_trades != null ? r.max_trades : null,
  }
}

/** Which of P1..P5 are actually GRADED for this trader (drive the proportional
 *  verdict). Owner = all 5 (P2 AI-graded). Per-user: only the rails they set. */
export function activeRailIds(rc: RailConfig): PRuleId[] {
  if (rc.isOwner) return ['P1', 'P2', 'P3', 'P4', 'P5']
  const ids: PRuleId[] = []
  if (rc.dailyLossLimit != null) ids.push('P1')
  if (rc.maxSize != null) { ids.push('P2', 'P3') }
  if (rc.cooldownSec != null) ids.push('P4')
  if (rc.tradeCap != null) ids.push('P5')
  return ids
}
