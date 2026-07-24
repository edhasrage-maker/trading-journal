/**
 * IB-fade study — verified reference edge tables + playbook, embedded static.
 *
 * These are the historical results of the trader's IB-fade study, keyed to the
 * three classifier lenses in `ib-day-type.ts`. They are NOT recomputed live —
 * this is the "known edge" a prep-time overview reads out, the same idea as the
 * `condition_lookup` table behind Morning Conditions, specialized to the fade
 * study and hard-coded because the study lives outside the app.
 *
 * Basis (unless a row says otherwise):
 *   NQ only · net of 1 tick round-trip · 6 years · 2-entry sequence ·
 *   chop-day baseline uses the 0.5×ATR-at-entry stop floor.
 *
 * Honesty policy (VERIFIED vs PRELIMINARY):
 *   - VERIFIED: the chop-day fade + 0.5×ATR floor + 2-entry sequence, and the
 *     per-year splits, are independently verified. The per-session chop numbers
 *     are the headline verified result.
 *   - PRELIMINARY: "mid / expanded regimes also work" is a preliminary finding.
 *     Chop is the A-setup; mid/expanded are tradeable but the edge tilts to chop.
 *     The size lens (small/normal/large) is thin (4/6 years) — treat as a tilt,
 *     not a signal. Everything preliminary is flagged so the UI can mute it.
 *
 * All numbers are normalized (net R / win-rate / ×ATR / per-year splits) — never
 * fixed points — so they stay comparable across regimes and instruments.
 */

import type { SessionKind } from './session-levels'
import type { RegimeBand, SizeBand } from './ib-day-type'

export type Confidence = 'verified' | 'preliminary'

/** One-line provenance shown above the reference reads. */
export const IB_FADE_BASIS =
  'IB-fade study · NQ · net of 1 tick · 6 yrs · 2-entry · chop baseline uses a 0.5×ATR-at-entry stop floor'

// ─────────────────────────────────────────────────────────────────────────────
// Lens 1 — by session (chop day, 0.5×ATR floor)
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionEdge {
  session: SessionKind
  label: string
  /** Active-session window (PT) as computed live in session-levels.ts. */
  windowPT: string
  ibWindowPT: string
  /** Fraction, e.g. 0.48 = 48% win rate on the single-entry chop fade. */
  chopWinRate: number
  /** Net R, single entry. */
  singleEntryR: number
  /** Net R, 2-entry sequence (the traded form). */
  twoEntryR: number
  /** Per-year positive splits, e.g. "6/6". Null when not broken out. */
  splits: string | null
  confidence: Confidence
  /** The A-setup session (RTH). */
  star?: boolean
  /** Intraday timing tilt for this session. */
  timing: string
  /** Any honest caveat (e.g. Asia's edge is in the 2nd fade). */
  note?: string
}

/**
 * Session windows/IB windows are stated as they are computed live by
 * session-levels.ts. NB: the historical Asia edge was measured off the 15:00 PT
 * ETH open (IB 15:00–16:00); the live classifier anchors Asia at 17:00 PT
 * (session-levels default), so the Asia read is approximate — see `note`.
 */
const SESSION_EDGES: Record<SessionKind, SessionEdge> = {
  rth: {
    session: 'rth',
    label: 'RTH',
    windowPT: '06:30–13:00 PT',
    ibWindowPT: 'IB 06:30–07:29',
    chopWinRate: 0.48,
    singleEntryR: 0.474,
    twoEntryR: 0.702,
    splits: '6/6',
    confidence: 'verified',
    star: true,
    timing: 'Time-agnostic — no meaningful edge in entry time of day.',
  },
  london: {
    session: 'london',
    label: 'London',
    windowPT: '00:00–06:30 PT',
    ibWindowPT: 'IB 00:00–01:00',
    chopWinRate: 0.42,
    singleEntryR: 0.268,
    twoEntryR: 0.433,
    splits: '6/6',
    confidence: 'verified',
    timing: 'First ~15 min best; ~02:00–02:30 PT is soft.',
  },
  asia: {
    session: 'asia',
    label: 'Asia',
    windowPT: '17:00–02:00 PT',
    ibWindowPT: 'IB 17:00–18:00',
    chopWinRate: 0.41,
    singleEntryR: 0.155,
    twoEntryR: 0.508,
    splits: null,
    confidence: 'verified',
    timing: 'No intraday timing edge.',
    note: 'Edge is in the 2nd fade, not the 1st (single-entry is weak). Study measured Asia off the 15:00 PT ETH open; the live IB anchors at 17:00 PT, so this read is approximate.',
  },
}

export function sessionEdge(session: SessionKind): SessionEdge {
  return SESSION_EDGES[session]
}

// ─────────────────────────────────────────────────────────────────────────────
// Lens 2 — by IB/ATR regime band
// ─────────────────────────────────────────────────────────────────────────────

export interface RegimeEdge {
  band: RegimeBand
  /** Net R, 2-entry, RTH only. */
  rthR: number
  /** Net R, 2-entry, all NQ sessions pooled. */
  allNqR: number
  /** Per-year positive splits for the RTH figure. Null when not broken out. */
  rthSplits: string | null
  /** Base rate — share of days that land in this band (~terciles, widened cuts).
   *  A fraction, e.g. 0.54. Useful context: mid is the default regime. */
  share: number
  confidence: Confidence
}

const REGIME_EDGES: Record<RegimeBand, RegimeEdge> = {
  chop: { band: 'chop', rthR: 0.376, allNqR: 0.298, rthSplits: '6/6', share: 0.22, confidence: 'verified' },
  mid: { band: 'mid', rthR: 0.240, allNqR: 0.223, rthSplits: '6/6', share: 0.54, confidence: 'preliminary' },
  expanded: { band: 'expanded', rthR: 0.255, allNqR: 0.220, rthSplits: '6/6', share: 0.24, confidence: 'preliminary' },
}

export function regimeEdge(band: RegimeBand): RegimeEdge {
  return REGIME_EDGES[band]
}

// ─────────────────────────────────────────────────────────────────────────────
// Lens 3 — by IB size band (RTH; thin, 4/6)
// ─────────────────────────────────────────────────────────────────────────────

export interface SizeEdge {
  band: SizeBand
  /** Net R, 2-entry, RTH. */
  rthR: number
  splits: string
  confidence: Confidence
  /** The best size band (normal). */
  star?: boolean
}

/** The size lens is uniformly thin (4/6 years) — all rows are preliminary. */
const SIZE_EDGES: Record<SizeBand, SizeEdge> = {
  small: { band: 'small', rthR: 0.330, splits: '4/6', confidence: 'preliminary' },
  normal: { band: 'normal', rthR: 0.462, splits: '4/6', confidence: 'preliminary', star: true },
  large: { band: 'large', rthR: 0.244, splits: '4/6', confidence: 'preliminary' },
}

export function sizeEdge(band: SizeBand): SizeEdge {
  return SIZE_EDGES[band]
}

// ─────────────────────────────────────────────────────────────────────────────
// Playbook — the recommended fade sequence + cautions
// ─────────────────────────────────────────────────────────────────────────────

/** The A-setup one-liner. */
export const PLAYBOOK_A_SETUP =
  'A-setup: the chop-day IB fade (verified, 6/6 years). Mid & expanded are tradeable but preliminary.'

/** The mechanical rules, in order. */
export const PLAYBOOK_RULES: readonly string[] = [
  'Fade the first IB-edge break — rest a limit at the edge and enter on the fade-back to it.',
  'Stop = max(the break’s excursion extreme, 0.5×ATR-at-entry). ATR = entry_atr_1m.',
  'Target 2R.',
  'Cap at 2 trades per session — the edge is a 2-entry sequence.',
]

/** Situational cautions the panel raises when the classification warrants. */
export const PLAYBOOK_CAUTIONS = {
  largeIb:
    'Large IB (>1.25× the 10-day avg) → size down. The size edge is thin (4/6 years), so treat it as a tilt.',
  nonChopRegime:
    'Mid / expanded regime: tradeable, but the edge tilts to chop — this is a preliminary finding, not the A-setup.',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Signed net-R string, e.g. +0.702 / −0.100. */
export function formatNetR(r: number): string {
  return `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(3)}`
}

/** Human label for a confidence tier. */
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  verified: 'verified',
  preliminary: 'preliminary',
}
