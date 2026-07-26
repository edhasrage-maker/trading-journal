// Deep-dive investigation framework (Pt 11). Each "investigation" is a
// deterministic analyzer that follows the same arc the capture dive did:
// measure precisely → decompose by segment → find where the money concentrates
// → reframe → propose a FALSIFIABLE test. The coach orchestrates these; the LLM
// only narrates the numbers (trust layer), it never invents them.
//
// One shared result shape so a registry can rank dives for the proactive opener
// AND render any dive on demand — the two trigger paths, one contract.

/** A labeled segment of the decomposition (e.g. a streak bucket, an hour). */
export interface DiveSegment {
  label: string
  /** Primary metric for this segment (win rate %, avg R, $ — dive decides). */
  value: number
  /** Optional supporting counts for the UI table. */
  n?: number
  pnl?: number
  /** Free-form extra columns keyed for the table renderer. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>
}

/** A falsifiable "if you did X, here's the modeled impact" — every dive ends
 *  with one, so advice is testable, not vibes. */
export interface ProposedTest {
  /** The rule/change, e.g. "Stop after 2 consecutive losses". */
  rule: string
  /** Modeled dollar impact over the window (positive = you'd have made/saved). */
  impactUsd: number
  /** One line explaining how the impact was modeled. */
  basis: string
}

export interface DeepDiveResult {
  /** Stable id, e.g. 'tilt-cascade'. */
  id: string
  /** Short human title for the dive. */
  title: string
  /** The one-line finding — the headline the opener shows. */
  headline: string
  /** 0..1 severity for ranking in the proactive opener (higher = surface first).
   *  A dive that finds nothing notable returns a low score (or the analyzer
   *  returns null). */
  severity: number
  /** The decomposition — the segments that make the finding auditable. */
  segments: DiveSegment[]
  /** Bulleted diagnostic detail (the "why", in plain language). */
  detail: string[]
  /** The reframe — the non-obvious way to see the problem, when there is one. */
  reframe?: string
  /** The falsifiable next step. */
  test?: ProposedTest
}

/**
 * What data a dive needs. The registry runs a dive ONLY when all its inputs are
 * available, so a brand-new user with raw broker fills (no tags, no EOD) still
 * gets the full cold-start battery, and tag/EOD dives light up later as the
 * trader journals. Tags ENRICH; they are never REQUIRED for the base tier.
 *   - 'fills'  entry/exit time, price, qty, direction, P&L. ALWAYS present, any
 *              instrument. The universal cold-start floor (tilt, time-of-day,
 *              size expectancy, long/short, streaks, overtrading, hold-time).
 *   - 'legs'   exits_json scale-out legs (present when the trader scales out).
 *   - 'bars'   our SERVER-computed enrichments (entry_atr_1m, tick MFE /
 *              high-low_during_position, structure_5m_regime). No trader input,
 *              but needs market data for the instrument (NQ/MNQ/ES today).
 *   - 'tags'   the trader's own mistake/setup/emotion/day-type tags.
 *   - 'eod'    EOD process analysis (verdicts).
 */
export type DiveInput = 'fills' | 'legs' | 'bars' | 'tags' | 'eod'

/** An investigation module. `run` is PURE (data in → result out); `null` means
 *  "not enough signal / nothing notable" so the opener skips it. The generic
 *  `Input` is whatever pre-gathered rows the dive needs — the registry wires the
 *  queries so the analyzer stays pure + unit-testable. */
export interface Investigation<Input> {
  id: string
  title: string
  /** Data this dive needs; the registry skips it unless all are available. */
  requires: DiveInput[]
  /** Natural-language triggers for on-ask routing ("tilt", "revenge", "after a loss"). */
  keywords: string[]
  run(input: Input): DeepDiveResult | null
}

export const fmtUsd = (n: number): string =>
  (n >= 0 ? '+' : '−') + '$' + Math.abs(Math.round(n)).toLocaleString()
export const fmtPct = (n: number): string => `${Math.round(n)}%`
