/**
 * IB-fade day-type classifier — a pure, prep-time classifier that mirrors the
 * `market-structure.ts` porting precedent (faithful port of the trader's own
 * study definitions, no side effects, exported types + band constants).
 *
 * It classifies today's Initial Balance along THREE INDEPENDENT lenses. They
 * are deliberately kept marginal (each read on its own axis) rather than crossed
 * into one bucket — the fully-crossed cell is too thin to trade off. The lenses:
 *
 *   1. Session      — which trading session the prep targets (RTH / London /
 *                     Asia). This is the user's pick (SessionKind), not derived
 *                     from a timestamp; the classifier just carries it through
 *                     so the reference edge can be keyed on it.
 *
 *   2. IB / ATR     — IB range ÷ ATR, bucketed chop / mid / expanded. The study
 *      regime         ATR is meanHL10 = mean(High−Low of the last 10 IB 1-min
 *                     bars), NOT Wilder. Cuts are 7.7 / 13 on the meanHL10 basis
 *                     (distribution terciles sit at 8.7 / 11.8; the chop and
 *                     expanded zones are slightly widened from the terciles).
 *                     When only the Wilder-10 ATR (atr_at_ib_close, ~3% smaller)
 *                     is available the cuts shift to ~7.5 / 12.7 and the read is
 *                     labelled as the fallback basis — an approximation, not the
 *                     study-exact regime.
 *
 *   3. IB size      — IB range ÷ trailing-10-day-average IB, bucketed small /
 *                     normal / large at 0.75 / 1.25. This is `ib_vs_10d_avg`,
 *                     which is RTH-baselined, so the size lens is only supported
 *                     for RTH; overnight sessions carry it null (mute in the UI).
 *
 * Everything here is normalized (ratios and bands) — the panel renders these as
 * a day-character read (choppy / normal / extended + small / normal / large) and
 * maps them onto the trader's day-type chips. Feed the classifier the day's IB
 * range, meanHL10, Wilder-10 fallback, and ib_vs_10d_avg — all available from
 * `contextStatsForDate()` in `market-context-from-bars.ts`.
 */

import type { SessionKind } from './session-levels'

export type RegimeBand = 'chop' | 'mid' | 'expanded'
export type SizeBand = 'small' | 'normal' | 'large'
/** Which ATR drove the regime ratio — meanHL10 is the study-exact basis;
 *  'wilder' is the labelled ~3%-off fallback (atr_at_ib_close). */
export type RegimeBasis = 'meanHL10' | 'wilder'

/**
 * IB/ATR regime cuts on the study-native meanHL10 basis. chop < 7.7 · mid
 * 7.7–13 · expanded ≥ 13. Distribution terciles (8.7 / 11.8) are kept for
 * documentation; the operative band cuts widen the chop and expanded zones.
 */
export const REGIME_CUTS_MEANHL10 = { chopMax: 7.7, midMax: 13 } as const
export const REGIME_TERCILES_MEANHL10 = { t1: 8.7, t2: 11.8 } as const
/**
 * Fallback cuts when classifying off the Wilder-10 ATR (atr_at_ib_close), which
 * runs ~3% smaller than meanHL10. Approximate + labelled — use only when the
 * study-native meanHL10 isn't available.
 */
export const REGIME_CUTS_WILDER = { chopMax: 7.5, midMax: 12.7 } as const

/** IB size cuts on IB range ÷ trailing-10-day-avg IB. small < 0.75 · normal
 *  0.75–1.25 · large > 1.25. */
export const SIZE_CUTS = { smallMax: 0.75, normalMax: 1.25 } as const

/** Bucket an IB/ATR ratio into a regime band on the given ATR basis. */
export function regimeBandFor(ratio: number, basis: RegimeBasis): RegimeBand {
  const cuts = basis === 'wilder' ? REGIME_CUTS_WILDER : REGIME_CUTS_MEANHL10
  if (ratio < cuts.chopMax) return 'chop'
  if (ratio < cuts.midMax) return 'mid'
  return 'expanded'
}

/** Bucket an IB-vs-10d-avg ratio into a size band. Normal is inclusive of both
 *  0.75 and 1.25 (small is strictly below 0.75, large strictly above 1.25). */
export function sizeBandFor(ratio: number): SizeBand {
  if (ratio < SIZE_CUTS.smallMax) return 'small'
  if (ratio <= SIZE_CUTS.normalMax) return 'normal'
  return 'large'
}

export interface IbDayTypeInputs {
  /** The session this prep targets (user pick, from the SessionPicker). */
  session: SessionKind
  /** IB range for the active session = IBH − IBL (equals `ib_size`). */
  ibRange: number | null
  /** Study-native ATR: mean(High−Low of the last 10 IB 1-min bars) = `meanHL10`. */
  atrMeanHL10: number | null
  /** Wilder-10 ATR at IB close (`atr_at_ib_close`) — ~3%-off fallback basis. */
  atrWilder10: number | null
  /** IB range ÷ trailing-10-day-avg IB (`ib_vs_10d_avg`) — RTH-baselined. */
  ibVs10dAvg: number | null
}

export interface IbDayType {
  session: SessionKind
  /** chop / mid / expanded, or null when the IB (hence meanHL10) hasn't printed. */
  regimeBand: RegimeBand | null
  /** IB range ÷ ATR, on whichever basis was available. Null when unclassifiable. */
  regimeRatio: number | null
  /** Which ATR drove the ratio; null when the regime is unclassifiable. */
  regimeBasis: RegimeBasis | null
  /** small / normal / large, or null when unsupported (non-RTH) or no data. */
  sizeBand: SizeBand | null
  /** IB range ÷ trailing-10d-avg IB. Null when unsupported / no data. */
  sizeRatio: number | null
  /** True only for RTH — the size lens is RTH-baselined, muted overnight. */
  sizeSupported: boolean
  /** One-line factual summary of the three lenses. */
  read: string
}

const SESSION_LABEL: Record<SessionKind, string> = {
  rth: 'RTH',
  london: 'London',
  asia: 'Asia',
}

const REGIME_LABEL: Record<RegimeBand, string> = {
  chop: 'chop',
  mid: 'mid',
  expanded: 'expanded',
}

const SIZE_LABEL: Record<SizeBand, string> = {
  small: 'small',
  normal: 'normal',
  large: 'large',
}

/**
 * Classify today's IB into the three fade-study lenses. Pure — same inputs
 * always give the same output. Any lens that lacks its inputs comes back null
 * (the UI mutes it) rather than guessing; `regimeBand` falls back to the Wilder
 * basis only when meanHL10 is missing, and always labels which basis it used.
 */
export function classifyIbDayType(inputs: IbDayTypeInputs): IbDayType {
  const { session, ibRange, atrMeanHL10, atrWilder10, ibVs10dAvg } = inputs

  // ── Lens 2: IB / ATR regime (meanHL10 preferred, Wilder fallback) ──
  let regimeRatio: number | null = null
  let regimeBand: RegimeBand | null = null
  let regimeBasis: RegimeBasis | null = null
  if (ibRange != null && atrMeanHL10 != null && atrMeanHL10 > 0) {
    regimeRatio = ibRange / atrMeanHL10
    regimeBasis = 'meanHL10'
    regimeBand = regimeBandFor(regimeRatio, 'meanHL10')
  } else if (ibRange != null && atrWilder10 != null && atrWilder10 > 0) {
    regimeRatio = ibRange / atrWilder10
    regimeBasis = 'wilder'
    regimeBand = regimeBandFor(regimeRatio, 'wilder')
  }

  // ── Lens 3: IB size (RTH-first; ib_vs_10d_avg is RTH-baselined) ──
  const sizeSupported = session === 'rth'
  let sizeRatio: number | null = null
  let sizeBand: SizeBand | null = null
  if (sizeSupported && ibVs10dAvg != null) {
    sizeRatio = ibVs10dAvg
    sizeBand = sizeBandFor(ibVs10dAvg)
  }

  // ── Read: a compact, factual one-liner across the lenses ──
  const parts: string[] = [SESSION_LABEL[session]]
  if (regimeBand != null && regimeRatio != null) {
    const basisTag = regimeBasis === 'wilder' ? ' Wilder' : ''
    parts.push(`${REGIME_LABEL[regimeBand]} regime (${regimeRatio.toFixed(1)}×${basisTag} ATR)`)
  } else {
    parts.push('IB not yet printed')
  }
  if (sizeBand != null && sizeRatio != null) {
    parts.push(`${SIZE_LABEL[sizeBand]} IB (${sizeRatio.toFixed(2)}× 10-day)`)
  } else if (!sizeSupported) {
    parts.push('size n/a overnight')
  }
  const read = parts.join(' · ')

  return {
    session,
    regimeBand,
    regimeRatio,
    regimeBasis,
    sizeBand,
    sizeRatio,
    sizeSupported,
    read,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-type mapping + presentation — the classification → the trader's day-type
// chips, validated against tagging history: IB size (magnitude) → the action
// level, IB÷ATR regime (directionality) → the structural read.
// ─────────────────────────────────────────────────────────────────────────────

/** IB size band → action-level day-type chip. Labels mirror the trader's
 *  library; callers guard against their own dayTypeOptions before offering one. */
export const IB_SIZE_TO_CHIP: Record<SizeBand, string> = {
  small: 'Low Participation/Compressed',
  normal: 'Medium Mush Market (Indecisive)',
  large: 'High Action Market',
}
/** IB÷ATR regime → structural day-type chip. Mid is deliberately absent (the
 *  ambiguous middle makes no clean Trend/Range call). */
export const IB_REGIME_TO_CHIP: Partial<Record<RegimeBand, string>> = {
  chop: 'Range Day',
  expanded: 'Trend Day',
}

/** The day-type chips implied by a classification (action from size, structure
 *  from regime). Undefined when that lens isn't classifiable / has no clean call. */
export function ibDayTypeChips(c: IbDayType): { action?: string; structure?: string } {
  return {
    action: c.sizeBand ? IB_SIZE_TO_CHIP[c.sizeBand] : undefined,
    structure: c.regimeBand ? IB_REGIME_TO_CHIP[c.regimeBand] : undefined,
  }
}

/** Structured IB read handed to the AI day-type predictor as a strong prior. */
export interface IbAiRead {
  character: string                 // Choppy | Normal | Extended
  regimeRatio: number | null
  regimeBasis: RegimeBasis | null
  size: string | null              // Small | Normal | Large (null overnight / pre-IB)
  sizeRatio: number | null
  impliedStructure: string | null  // Trend Day | Range Day
  impliedAction: string | null     // the action-level chip
}

const REGIME_TITLE: Record<RegimeBand, string> = { chop: 'Choppy', mid: 'Normal', expanded: 'Extended' }
const SIZE_TITLE: Record<SizeBand, string> = { small: 'Small', normal: 'Normal', large: 'Large' }

/** The structured IB read for the AI predictor — null until the IB has printed
 *  (nothing to hand the model yet). */
export function ibDayTypeAiRead(c: IbDayType): IbAiRead | null {
  if (!c.regimeBand) return null
  const chips = ibDayTypeChips(c)
  return {
    character: REGIME_TITLE[c.regimeBand],
    regimeRatio: c.regimeRatio,
    regimeBasis: c.regimeBasis,
    size: c.sizeBand ? SIZE_TITLE[c.sizeBand] : null,
    sizeRatio: c.sizeRatio,
    impliedStructure: chips.structure ?? null,
    impliedAction: chips.action ?? null,
  }
}

const REGIME_CHARACTER: Record<RegimeBand, string> = { chop: 'choppy', mid: 'balanced', expanded: 'extended' }
const SIZE_WORD: Record<SizeBand, string> = { small: 'compressed', normal: 'normal-sized', large: 'large' }
const REGIME_LEAN: Partial<Record<RegimeBand, string>> = { chop: 'range', expanded: 'trend' }
const SIZE_LEAN: Record<SizeBand, string> = { small: 'low-participation', normal: 'medium/mush', large: 'high-action' }

/**
 * Beginner one-liner describing today's IB in plain language, e.g.
 * "Today's IB is normal-sized and balanced — leans a medium/mush day."
 * Returns null before the IB has printed (nothing to say yet).
 */
export function ibDayTypeHeadline(c: IbDayType): string | null {
  if (!c.regimeBand) return null
  const character = REGIME_CHARACTER[c.regimeBand]
  const sizeWord = c.sizeBand ? SIZE_WORD[c.sizeBand] : null
  const leans = [c.regimeBand ? REGIME_LEAN[c.regimeBand] : undefined, c.sizeBand ? SIZE_LEAN[c.sizeBand] : undefined]
    .filter((x): x is string => !!x)
  const desc = sizeWord ? `${sizeWord} and ${character}` : character
  const lean = leans.length ? ` — leans a ${leans.join(', ')} day` : ''
  return `Today's IB is ${desc}${lean}.`
}
