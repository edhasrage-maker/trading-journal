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
    /** Default size cap in contracts — used for any instrument without an override. */
    max_size?: number | null
    /** Per-instrument size caps keyed by SYMBOL ROOT ("MNQ", "MES", "ES").
     *  A single number cannot express "5 MNQ or 10 MES": NQ carries roughly 2.9×
     *  the dollar volatility of ES per contract (1m ATR 19.4×$2 vs 2.6×$5,
     *  measured 2026-07-28), so one lot count is either too loose on NQ or too
     *  tight on ES. Any root not listed falls back to `max_size`. */
    max_size_by_root?: Record<string, number> | null
    /** Per-root cap for a QUALIFYING (A+) size-up. Falls back to the base cap,
     *  i.e. "this trader has no size-up exception". */
    size_up_by_root?: Record<string, number> | null
    max_trades?: number | null
    cooldown_min?: number | null
    no_add_to_loser?: boolean | null
  } | null
  /** Trading style (Pt 11) — inferred from the trader's imported trades and
   *  confirmed on a single card, so the coach can personalize capture/leak
   *  analysis (timeframe → which ATR; exit style → whether give-back is a leak;
   *  stops → the leak-floor cascade). See src/lib/trading-style.ts. All nullable;
   *  absent → the coach falls back to conservative defaults. */
  style?: {
    timeframe?: 'scalp' | 'intraday' | 'swing' | null
    exit_style?: 'fixed_target' | 'scale_out' | 'trail' | 'let_run' | 'discretionary' | null
    uses_stops?: 'always' | 'sometimes' | 'never' | null
    scales_out?: boolean | null
    edge_style?: 'trend' | 'mean_reversion' | 'breakout' | 'range' | null
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
  const isOwner = isEmptyScoringProfile(sp)
  const usesOF = sp?.execution?.uses_orderflow
  const stopMode = sp?.stop?.mode?.toLowerCase()
  const stopVal = sp?.stop?.value
  const atrStopTarget =
    stopMode === 'atr' && typeof stopVal === 'number' && stopVal > 0
      ? stopVal
      : DEFAULT_RUBRIC.atrStopTarget

  // Order flow is opt-IN for real users (feedback_no_forced_orderflow): default
  // FALSE when a non-empty profile omits the flag. The owner's empty profile is
  // the ONLY case that inherits the v1.3 TRUE default (owner-parity contract).
  const usesOrderFlow =
    usesOF != null ? !!usesOF : (isOwner ? DEFAULT_RUBRIC.usesOrderFlow : false)

  // Size-up threshold = the trader's OWN max_size rail (like resolveRails), so a
  // 10-lot-normal trader doesn't trip the size-up stop band + OF gate on every
  // trade. Owner/empty profile → the v1.3 default (5). A non-empty profile that
  // never set max_size → Infinity (no size-up concept — never gate on size).
  const maxSize = sp?.rails?.max_size
  const sizeUpLots = isOwner
    ? DEFAULT_RUBRIC.sizeUpLots
    : (typeof maxSize === 'number' && maxSize > 0 ? maxSize : Number.POSITIVE_INFINITY)

  return {
    usesOrderFlow,
    atrStopTarget,
    tp1RMultiple: parseTpRMultiple(sp?.tp) ?? DEFAULT_RUBRIC.tp1RMultiple,
    sizeUpLots,
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
  /** Default max position size (contracts); null = no size rule. Per-instrument
   *  overrides live in `maxSizeByRoot` — always read a cap through
   *  `sizeCapFor()`, never off this field directly. */
  maxSize: number | null
  /** Per-symbol-root size caps, e.g. { MNQ: 5, MES: 10 }. null = none set. */
  maxSizeByRoot: Record<string, number> | null
  /** Per-symbol-root caps for a QUALIFYING (A+) size-up, e.g. { MNQ: 10, MES: 20 }. */
  sizeUpByRoot: Record<string, number> | null
  /** When true, P2 (size cap) is computed deterministically (qty ≤ maxSize).
   *  Owner = false (P2 left to the AI for the S&D 10-lot exception). */
  p2Deterministic: boolean
  /** Post-loss size cap (contracts) for P3; = the BASE cap. null = no P3 rule.
   *  Per-instrument via `sizeCapFor(rc, symbol)` — P3 never uses the size-up
   *  cap, that's the whole point of the rule. */
  postLossCap: number | null
  /** Cooldown after a loss in SECONDS; null = no cooldown rule. */
  cooldownSec: number | null
  /** Max trades per session; null = no trade-cap rule. */
  tradeCap: number | null
}

/** The founder's Ruleset v1.3 rails — the fallback for an empty/absent profile
 *  ON THE FOUNDER'S LOCAL BUILD, matching the constants previously hardcoded in
 *  `computeDeterministicRules`. An empty profile resolving to THIS is what keeps
 *  the founder's grading byte-identical. */
export const OWNER_RAILS: RailConfig = {
  isOwner: true,
  dailyLossLimit: -500,
  dllBuffer: 50,
  maxSize: 5,
  // Instrument-normalized, not a size increase. NQ carries ~2.9× the dollar
  // volatility of ES per contract (1m ATR 19.4 × $2 = $38.7 vs 2.6 × $5 = $13.1,
  // measured 2026-07-28), because NQ is ~1.9× more volatile than ES in PERCENT
  // terms on top of a 3.75× price ratio. So 10 MES ≈ $131 of ATR-risk against
  // 5 MNQ ≈ $194, and the A+ 20 MES ≈ $262 against 10 MNQ ≈ $387 — both ES caps
  // sit BELOW their NQ equivalent. The $200 campaign-risk gate still binds.
  maxSizeByRoot: { MNQ: 5, MES: 10 },
  sizeUpByRoot: { MNQ: 10, MES: 20 },
  p2Deterministic: false,   // owner P2 stays AI-driven (the A+ / Qualifying S&D exception)
  postLossCap: 5,
  cooldownSec: 90,
  tradeCap: 7,
}

/** Nothing-tracked rails — the PUBLIC un-onboarded state. An empty profile on the
 *  hosted build resolves to THIS (not OWNER_RAILS) so a tester who hasn't onboarded
 *  is NOT graded against the founder's ≤5-MNQ / −$500 / ≤7 rails (the 2026-07-09
 *  test-session bug). Every P-rule is null → INACTIVE → auto-passes and is excluded
 *  from the verdict, so nothing is graded until they set their own rails in
 *  onboarding. Shape is identical to `resolveRails` of a non-owner profile that set
 *  no rails. `isOwner:false` routes the proportional (non-owner) verdict branch and
 *  keeps P2 off the AI's S&D-conditional path. */
export const UNTRACKED_RAILS: RailConfig = {
  isOwner: false,
  dailyLossLimit: null,
  dllBuffer: 50,
  maxSize: null,
  maxSizeByRoot: null,
  sizeUpByRoot: null,
  p2Deterministic: false,
  postLossCap: null,
  cooldownSec: null,
  tradeCap: null,
}

/** "MNQU6.CME" → "MNQ". Local copy of futures-symbols' symbolRoot so this module
 *  stays dependency-free and client-safe (see the header note). */
function rootOf(symbol: string): string {
  return symbol.split('.')[0].replace(/[A-Z]\d{1,2}$/, '').toUpperCase()
}

/**
 * The size cap that applies to ONE trade, in contracts. Always read caps through
 * this — a bare `rc.maxSize` comparison is instrument-blind, which is what made
 * a 10-lot MES trade a P3 breach against a cap written for MNQ.
 *
 * `kind: 'base'` is the everyday cap (and the post-loss cap for P3).
 * `kind: 'sizeUp'` is the qualifying-setup exception, falling back to the base
 * cap when the trader has no size-up concept.
 * Returns null when no cap applies to this instrument → the rule is inactive.
 */
export function sizeCapFor(
  rc: RailConfig,
  symbol: string | null | undefined,
  kind: 'base' | 'sizeUp' = 'base',
): number | null {
  const root = symbol ? rootOf(symbol) : null
  const table = kind === 'sizeUp' ? rc.sizeUpByRoot : rc.maxSizeByRoot
  if (root && table && table[root] != null) return table[root]
  // No size-up entry for this root → fall back to its base cap, not the default.
  if (kind === 'sizeUp' && root && rc.maxSizeByRoot?.[root] != null) return rc.maxSizeByRoot[root]
  return rc.maxSize
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
  if (r.max_size_by_root && Object.keys(r.max_size_by_root).length > 0) return false
  if (sp.execution && sp.execution.uses_orderflow != null) return false
  return true
}

/** Collapse a per-user scoring profile into the concrete P-rule numbers. Units
 *  per RulesStep.tsx: `cooldown_min` is minutes; `daily_loss_limit` is a positive
 *  magnitude the user typed → negated here.
 *
 *  Empty-profile fallback is gated on `isLocalOwner` (the analyze-eod route passes
 *  `LOCAL_FEATURES_ENABLED`): on the founder's LOCAL build an empty profile → the
 *  owner's v1.3 rails (byte-identical parity); on the PUBLIC build an empty /
 *  un-onboarded profile → UNTRACKED_RAILS (nothing graded until they onboard).
 *  Defaults to `true` so every existing caller (and the local rescore script)
 *  keeps the historical owner-parity behavior unless it explicitly opts out. */
export function resolveRails(sp?: ScoringProfile | null, isLocalOwner = true): RailConfig {
  if (isEmptyScoringProfile(sp)) return isLocalOwner ? { ...OWNER_RAILS } : { ...UNTRACKED_RAILS }
  const r = sp!.rails ?? {}
  const maxSize = r.max_size != null ? r.max_size : null
  const clean = (t?: Record<string, number> | null): Record<string, number> | null => {
    if (!t) return null
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(t)) if (typeof v === 'number' && v > 0) out[k.toUpperCase()] = v
    return Object.keys(out).length ? out : null
  }
  const maxSizeByRoot = clean(r.max_size_by_root)
  return {
    isOwner: false,
    dailyLossLimit: r.daily_loss_limit != null ? -Math.abs(r.daily_loss_limit) : null,
    dllBuffer: 50,
    maxSize,
    maxSizeByRoot,
    sizeUpByRoot: clean(r.size_up_by_root),
    // A per-instrument cap is just as gradable as a scalar one.
    p2Deterministic: maxSize != null || maxSizeByRoot != null,
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
  if (rc.maxSize != null || rc.maxSizeByRoot != null) { ids.push('P2', 'P3') }
  if (rc.cooldownSec != null) ids.push('P4')
  if (rc.tradeCap != null) ids.push('P5')
  return ids
}
