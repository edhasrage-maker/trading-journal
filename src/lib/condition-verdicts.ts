/**
 * Verdict-first condition reads (alpha-readiness item 14).
 *
 * Pure functions that turn the day's market-context numbers into plain-language
 * verdicts: a banner headline + sentence, and one chip per metric with the
 * verdict word first and the raw number second ("Volume pace — very quiet ·
 * RVOL 25%"), never a bare "ATR is 69".
 *
 * All bands are relative to the trader's own baselines, so nothing here is
 * instrument-specific:
 *   - rvol is stored as a percent of the 10-day average (100 = normal)
 *   - bar volatility is atr_1m / atr_eod_10d_avg (both points, SAME basis —
 *     see the note on BAR_VOL_BANDS; the old atr_10d_avg denominator was a
 *     different measurement and skewed every reading low)
 *   - overnight + day range are % of ADR
 *   - IB is the stored ratio vs its 10-day average
 * Every band is anchored to the metric's own realized distribution rather
 * than to round numbers, using one scheme: a fat middle that spans the median
 * (~p30–p70) with the tails at roughly the outer 10% / 20%. Overnight was
 * re-anchored 2026-07-24; bar volatility, range used, IB and RVOL followed on
 * 2026-07-27 (Pt 23) — every one had the same failure mode as overnight, where
 * a perfectly ordinary day read as compressed/below-normal and the extreme
 * words almost never fired. Distributions came
 * from the 514-day NQ 1m series (2024-03-21 → 2026-03-19) and were
 * cross-checked against the prod `market_context` rows. Verdict words are
 * display-only, so retuning is safe: nothing is persisted off them.
 */

export type VerdictTone = 'red' | 'amber' | 'dim' | 'plain'

export interface VerdictChip {
  /** Plain-language metric label, e.g. "Volume pace" */
  label: string
  /** Verdict word(s), e.g. "very quiet". Null = data present but no baseline
   *  to judge against — the chip shows the labeled raw value only. */
  verdict: string | null
  tone: VerdictTone
  /** Raw metric in the quiet pill, e.g. "RVOL 25%" */
  pill: string
  /** Tooltip explaining the read */
  title: string
}

export interface ConditionRead {
  /** Banner headline, e.g. "Thin, violent tape." Null when neither volume nor
   *  bar volatility can be judged. */
  headline: string | null
  /** Supporting sentence under the headline. */
  sentence: string | null
  chips: VerdictChip[]
  /** Raw values for the collapsed "show raw numbers" grid. */
  raw: Array<{ label: string; value: string }>
}

export interface ConditionInputs {
  /** RVOL as % of 10-day average (100 = normal). Values < 5 are tolerated as
   *  ratios (1.05) and converted. */
  rvol: number | null
  /** Today's 1-min ATR-10 in points. */
  atr1m: number | null
  /** 10-day average of the 1-min ATR, in points — the "typical" baseline. */
  atrBaseline: number | null
  /** ADR in points — the whole-day trailing average, also shown as a raw value. */
  adr: number | null
  /** ADR measured at the same point of the session the day has reached. While a
   *  session is still running, comparing its partial range against a WHOLE-day
   *  ADR reports the hour rather than the day's character — the same defect RVOL
   *  had. Falls back to `adr` when absent; equal to it on a completed day. */
  adrAtNow?: number | null
  /** Overnight high/low in price. */
  onh: number | null
  onl: number | null
  /** Realized day range in points (null until the session has printed). */
  dayRange: number | null
  /** IB size / 10-day average IB, as a ratio (0.99). Values > 5 are tolerated
   *  as percents (99) and converted. */
  ibRatio: number | null
}

interface BandDef {
  /** Band applies while value < max (checked in order). */
  max: number
  word: string
  tone: VerdictTone
}

function band(value: number, bands: BandDef[]): BandDef {
  for (const b of bands) if (value < b.max) return b
  return bands[bands.length - 1]
}

// ── Band definitions (approved spec) ─────────────────────────────────────────

// RVOL as a percent of the 10-day average. Re-anchored 2026-07-27 (Pt 23) to
// the trader's own day-level distribution (n=455: p10 73, p25 87, median 102,
// p75 124, p90 145). The old 40/70/130/180 cuts were inherited from the
// analytics Condition Buckets breaks — but those had drifted with the tape, and
// checking them showed "very busy" (>=180%) firing on ~1% of days and "very
// quiet" (<40%) on essentially none, while "normal" swallowed 72%. The
// analytics table has since been re-quintiled too, but the two no longer share
// numbers on purpose: that table wants five equal 20% buckets for comparison,
// this wants a fat middle that spans the median for judgement. Same data,
// different jobs.
const VOLUME_BANDS: BandDef[] = [
  { max: 75, word: 'very quiet', tone: 'red' },      // bottom ~11%
  { max: 90, word: 'quiet', tone: 'dim' },           // ~p11-p29
  { max: 120, word: 'normal', tone: 'plain' },       // ~p29-p72, spans the 102 median
  { max: 145, word: 'busy', tone: 'dim' },           // ~p72-p90
  { max: Infinity, word: 'very busy', tone: 'amber' }, // top ~10%
]

/** Volume cuts reused by the banner's 3-way quiet/normal/busy grouping — kept
 *  in sync with VOLUME_BANDS so the headline can't disagree with the chip. */
const VOLUME_GROUP_CUTS = { quietMax: 90, normalMax: 120 } as const

// Bar volatility = today's 1-min Wilder ATR-10 ÷ its own trailing-10 average
// (`atr_eod_10d_avg`, derived in market-context-from-bars.ts).
//
// This ratio was BROKEN until 2026-07-27: it divided `atr_1m` (the ATR at the
// 12:59 PT bar — a full-session average) by `atr_10d_avg` (the trailing-10 of
// the ATR at the 07:29 IB close — the busiest hour). Different measurements, so
// an ordinary day computed to ~0.77× and the chip could read "1.0× normal →
// elevated". Bands were first re-anchored to that skewed ratio, then the
// numerator and denominator were put on the same basis, which is the real fix.
//
// Now anchored to the same-basis distribution (514-day NQ 1m series 2024-03 →
// 2026-03, n=484: p10 0.63, p25 0.75, median 0.94, p75 1.19, p90 1.49). A
// typical day genuinely lands near 1.0×, so the words track the number the way
// a reader expects: 1.2× is elevated, 1.6× is very high.
const BAR_VOL_BANDS: BandDef[] = [
  { max: 0.65, word: 'very compressed', tone: 'red' },  // bottom ~12%
  { max: 0.8, word: 'compressed', tone: 'dim' },        // ~p12–p32
  { max: 1.15, word: 'normal', tone: 'plain' },         // ~p32–p72, spans the 0.94 median
  { max: 1.5, word: 'elevated', tone: 'amber' },        // ~p72–p90
  { max: Infinity, word: 'very high', tone: 'amber' },  // top ~10%
]

/** Bar-vol cuts reused by the banner's 3-way low/normal/high grouping — kept
 *  in sync with BAR_VOL_BANDS so the headline can't disagree with the chip. */
const BAR_VOL_GROUP_CUTS = { lowMax: 0.8, normalMax: 1.15 } as const

// Overnight range as % of ADR. Anchored to the ACTUAL NQ distribution (461-day
// sample: median 73%, p25 54%, p75 104%, p90 155%) — the old round-number
// 30/60/90 cutoffs called the median day "large" and tagged 35% of days "very
// large". A "normal" overnight on NQ is a big fraction of the RTH range (the
// overnight session is ~15h vs 6.5h RTH), so the fat middle sits at 50–100% and
// "large" only fires once overnight has covered a full typical RTH day's range.
const OVERNIGHT_BANDS: BandDef[] = [
  { max: 50, word: 'small', tone: 'plain' },        // ~bottom 20%
  { max: 100, word: 'normal', tone: 'plain' },      // covers the 73% median
  { max: 150, word: 'large', tone: 'amber' },       // overnight ≥ a full RTH range (~top 25%)
  { max: Infinity, word: 'very large', tone: 'red' }, // ~top 10%
]

// Day range as % of ADR. Anchored to the real RTH-range ÷ trailing-10-ADR
// distribution (same 514-day series, n=504: p10 53, p25 69, median 95, p75 127,
// p90 165). ADR is a trailing MEAN of a right-skewed range distribution, so the
// median day sits a little under 100% — the old 85/115 "normal" band held only
// ~22% of days and called a p35 day "below normal". The prod `day_range` column
// isn't usable for grounding here (n=35, and the older screenshot-extracted
// values are a full-day range measured against an RTH ADR); bars now fill it
// RTH-consistently, which is the basis these cuts assume.
const RANGE_USED_BANDS: BandDef[] = [
  { max: 55, word: 'compressed', tone: 'dim' },          // bottom ~12%
  { max: 75, word: 'below normal', tone: 'dim' },        // ~p12–p31
  { max: 115, word: 'normal', tone: 'plain' },           // ~p31–p69, spans the 95% median
  { max: 165, word: 'extended', tone: 'amber' },         // ~p69–p90
  { max: Infinity, word: 'very extended', tone: 'amber' }, // top ~10%
]

// IB vs its 10-day average. Anchored to the real distribution (n=504 bars:
// p10 0.52, p25 0.70, median 0.93, p75 1.27, p90 1.66; prod market_context
// n=448 agrees — median 0.95, p25 0.72, p75 1.28). The inner cuts are shared
// verbatim with `SIZE_CUTS` in ib-day-type.ts so the Opening-range chip and the
// IB day-type size read can never disagree about what a "small" IB is.
const IB_BANDS: BandDef[] = [
  { max: 0.55, word: 'very tight', tone: 'amber' },     // bottom ~11%
  { max: 0.75, word: 'tight', tone: 'dim' },            // ~p11–p31 (= SIZE_CUTS.smallMax)
  { max: 1.25, word: 'normal', tone: 'plain' },         // ~p31–p74, spans the 0.93 median (= SIZE_CUTS.normalMax)
  { max: 1.75, word: 'wide', tone: 'dim' },             // ~p74–p91
  { max: Infinity, word: 'very wide', tone: 'amber' },  // top ~9%
]

// ── Headline matrix ───────────────────────────────────────────────────────────
// Rows: volume group (quiet / normal / busy). Cols: bar-vol group (low / normal / high).

type VolGroup = 'quiet' | 'normal' | 'busy'
type AtrGroup = 'low' | 'normal' | 'high'

const HEADLINES: Record<VolGroup, Record<AtrGroup, string>> = {
  quiet: { low: 'Dead tape.', normal: 'Slow tape.', high: 'Thin, violent tape.' },
  normal: { low: 'Grinding tape.', normal: 'Ordinary tape.', high: 'Whippy tape.' },
  busy: { low: 'Heavy, slow grind.', normal: 'Active tape.', high: 'Fast tape.' },
}

const CONSEQUENCES: Record<VolGroup, Record<AtrGroup, string>> = {
  quiet: {
    low: 'Very little on offer — the main risk is forcing trades.',
    normal: 'Expect slow development and shallow follow-through.',
    high: 'Expect air pockets, not follow-through.',
  },
  normal: {
    low: 'Grind conditions — moves develop slowly.',
    normal: 'No edge from conditions either way.',
    high: 'Swings are bigger than the participation behind them — size accordingly.',
  },
  busy: {
    low: 'Heavy volume into small bars reads as absorption — expect grinding moves.',
    normal: 'Healthy participation — follow-through is more likely.',
    high: 'Real participation and big bars — moves travel; manage size.',
  },
}

// Short "so what do I do" hints per condition, for the beginner Highlights read
// (Detailed Tape shows the raw numbers instead). Keyed by chip label + verdict
// word. Behavioral/neutral — what the condition implies for how you trade it,
// not directional advice.
const CONDITION_ACTIONS: Record<string, Record<string, string>> = {
  'Volume pace': {
    'very quiet': 'thin tape — don’t force trades',
    'quiet': 'slow — expect little follow-through',
    'normal': 'no edge from volume either way',
    'busy': 'real participation — follow-through more likely',
    'very busy': 'heavy flow — moves can travel',
  },
  'Bar volatility': {
    'very compressed': 'tiny bars — moves grind, be patient',
    'compressed': 'small bars — wait for your spot',
    'normal': 'normal-sized bars',
    'elevated': 'bigger swings — size down',
    'very high': 'violent bars — size down hard',
  },
  'Overnight range': {
    'small': 'lots of room to run in RTH',
    'normal': 'typical overnight — room left in RTH',
    'large': 'much of the day’s range already used',
    'very large': 'range mostly spent — careful chasing extension',
  },
  'Range used': {
    'compressed': 'range still available',
    'below normal': 'room left in the day’s range',
    'normal': 'typical range used',
    'extended': 'most of the move is spent',
    'very extended': 'day’s range nearly exhausted',
  },
  'Opening range': {
    'very tight': 'coiled — watch for a break',
    'tight': 'narrow open — watch for expansion',
    'normal': 'typical opening range',
    'wide': 'big open — trend potential',
    'very wide': 'large open — respect the range',
  },
}

/** The short beginner action hint for a condition verdict, or null. */
export function conditionActionHint(label: string, verdict: string | null): string | null {
  if (!verdict) return null
  return CONDITION_ACTIONS[label]?.[verdict] ?? null
}

const num = (v: number | null | undefined): number | null =>
  v != null && Number.isFinite(v) ? v : null

/** Build the full verdict-first read from the day's context numbers. */
export function readConditions(i: ConditionInputs): ConditionRead {
  const chips: VerdictChip[] = []
  const raw: Array<{ label: string; value: string }> = []

  // Volume pace — tolerate ratio entry (1.05) for hand-typed values.
  let rvol = num(i.rvol)
  if (rvol != null && rvol < 5) rvol = rvol * 100
  const volBand = rvol != null ? band(rvol, VOLUME_BANDS) : null
  if (rvol != null && volBand) {
    chips.push({
      label: 'Volume pace',
      verdict: volBand.word,
      tone: volBand.tone,
      pill: `RVOL ${Math.round(rvol)}%`,
      title: `Relative volume vs your 10-day average for this window (100% = normal). Today is running at ${Math.round(rvol)}%.`,
    })
    raw.push({ label: 'RVOL', value: `${Math.round(rvol)}%` })
  }

  // Bar volatility — only judged against the trader's own 10-day ATR baseline.
  const atr = num(i.atr1m)
  const atrBase = num(i.atrBaseline)
  const atrRatio = atr != null && atrBase != null && atrBase > 0 ? atr / atrBase : null
  const atrBand = atrRatio != null ? band(atrRatio, BAR_VOL_BANDS) : null
  if (atr != null) {
    chips.push({
      label: 'Bar volatility',
      verdict: atrBand?.word ?? null,
      tone: atrBand?.tone ?? 'plain',
      pill: atrRatio != null
        ? `1-min ATR ${atr.toFixed(1)} pts · ${atrRatio.toFixed(1)}× normal`
        : `1-min ATR ${atr.toFixed(1)} pts`,
      title: atrRatio != null
        ? `Average 1-minute bar range (ATR-10). Today is ${atr.toFixed(1)} pts vs a 10-day typical of ${atrBase!.toFixed(1)} pts — ${atrRatio.toFixed(1)}× normal. Roughly 0.8–1.15× is an ordinary day.`
        : `Average 1-minute bar range (ATR-10). No 10-day baseline yet, so no verdict — just the raw value.`,
    })
    raw.push({ label: '1-min ATR', value: `${atr.toFixed(2)} pts` })
    if (atrBase != null) raw.push({ label: 'ATR 10-day avg', value: `${atrBase.toFixed(2)} pts` })
  }

  // Overnight range as % of ADR.
  const onh = num(i.onh)
  const onl = num(i.onl)
  const adr = num(i.adr)
  const onPct = onh != null && onl != null && adr != null && adr > 0
    ? ((onh - onl) / adr) * 100
    : null
  const onBand = onPct != null ? band(onPct, OVERNIGHT_BANDS) : null
  if (onPct != null && onBand) {
    chips.push({
      label: 'Overnight range',
      verdict: onBand.word,
      tone: onBand.tone,
      pill: `${Math.round(onPct)}% of ADR`,
      title: onPct >= 100
        ? `The overnight session already covered ${Math.round(onPct)}% of a normal day's range — most of the expected move may be spent.`
        : `The overnight session covered ${Math.round(onPct)}% of a normal day's range (ADR).`,
    })
    raw.push({ label: 'Overnight range', value: `${(onh! - onl!).toFixed(2)} pts (${Math.round(onPct)}% of ADR)` })
  }

  // Range used — realized only; hidden pre-session so prep mornings don't show
  // a meaningless 12%.
  const dayRange = num(i.dayRange)
  // Judge the ratio against the time-matched baseline; keep `adr` for display.
  const adrForRatio = num(i.adrAtNow) ?? adr
  const drPct = dayRange != null && adrForRatio != null && adrForRatio > 0 ? (dayRange / adrForRatio) * 100 : null
  const drBand = drPct != null ? band(drPct, RANGE_USED_BANDS) : null
  if (drPct != null && drBand) {
    chips.push({
      label: 'Range used',
      verdict: drBand.word,
      tone: drBand.tone,
      pill: `${Math.round(drPct)}% of ADR`,
      title: `Today's range so far is ${Math.round(drPct)}% of a normal day's range (ADR). A typical day finishes near 95%; past ~115% you're in the top third of days by range and extension gets harder to chase.`,
    })
    raw.push({ label: 'Day range', value: `${dayRange!.toFixed(2)} pts (${Math.round(drPct)}% of ADR)` })
  }

  // Opening range (IB) — tolerate percent entry (99) for hand-typed values.
  let ibRatio = num(i.ibRatio)
  if (ibRatio != null && ibRatio > 5) ibRatio = ibRatio / 100
  const ibBand = ibRatio != null ? band(ibRatio, IB_BANDS) : null
  if (ibRatio != null && ibBand) {
    chips.push({
      label: 'Opening range',
      verdict: ibBand.word,
      tone: ibBand.tone,
      pill: `${ibRatio.toFixed(2)}× 10-day avg`,
      title: `First-hour range (Initial Balance) vs its 10-day average. ${ibRatio.toFixed(2)}× normal — a typical open is 0.93×, and 0.75–1.25× covers the middle ~45% of your days.`,
    })
    raw.push({ label: 'IB vs 10-day avg', value: `${ibRatio.toFixed(2)}×` })
  }

  if (adr != null) raw.push({ label: 'ADR', value: `${Math.round(adr)} pts` })

  return { ...buildBanner(rvol, volBand, atr, atrRatio, atrBand, onPct), chips, raw }
}

function buildBanner(
  rvol: number | null,
  volBand: BandDef | null,
  atr: number | null,
  atrRatio: number | null,
  atrBand: BandDef | null,
  onPct: number | null,
): { headline: string | null; sentence: string | null } {
  const volGroup: VolGroup | null = rvol == null
    ? null
    : rvol < VOLUME_GROUP_CUTS.quietMax ? 'quiet'
      : rvol < VOLUME_GROUP_CUTS.normalMax ? 'normal'
        : 'busy'
  const atrGroup: AtrGroup | null = atrRatio == null
    ? null
    : atrRatio < BAR_VOL_GROUP_CUTS.lowMax ? 'low'
      : atrRatio < BAR_VOL_GROUP_CUTS.normalMax ? 'normal'
        : 'high'

  const overnightClause = onPct != null && onPct >= 100
    ? ` Overnight already used ${Math.round(onPct)}% of a normal day's range — be careful chasing extension.`
    : ''

  // Both reads available → full matrix.
  if (volGroup && atrGroup && rvol != null && atrRatio != null && atr != null) {
    let headline = HEADLINES[volGroup][atrGroup]
    // Extreme-corner sharpening (approved spec).
    if (volBand?.word === 'very quiet' && atrBand?.word === 'very high') headline = 'Dead, violent tape.'
    if (volBand?.word === 'very busy' && atrBand?.word === 'very high') headline = 'Fast, violent tape.'

    const volClause =
      volGroup === 'quiet'
        ? `Volume is running at ${Math.round(rvol)}% of its normal pace`
        : volGroup === 'busy'
          ? `Volume is running ${Math.round(rvol - 100)}% above normal`
          : `Volume is near normal (${Math.round(rvol)}%)`
    const atrClause =
      atrGroup === 'high'
        ? `each move is violent — 1-min bars averaging ${atr.toFixed(1)} pts, ~${atrRatio.toFixed(1)}× typical`
        : atrGroup === 'low'
          ? `the bars are small — 1-min ATR ${atr.toFixed(1)} pts, ${atrRatio.toFixed(1)}× typical`
          : `1-min bars are averaging ${atr.toFixed(1)} pts, in line with typical`
    // "but" when the two reads pull in opposite directions, "and" otherwise.
    const opposed = (volGroup === 'quiet' && atrGroup === 'high') || (volGroup === 'busy' && atrGroup === 'low')
    const sentence = `${volClause}, ${opposed ? 'but' : 'and'} ${atrClause}. ${CONSEQUENCES[volGroup][atrGroup]}${overnightClause}`
    return { headline, sentence }
  }

  // Volume only.
  if (volGroup && rvol != null && volBand) {
    const headline =
      volBand.word === 'very quiet' ? 'Dead tape.'
        : volBand.word === 'quiet' ? 'Slow tape.'
          : volBand.word === 'busy' ? 'Active tape.'
            : volBand.word === 'very busy' ? 'Fast tape.'
              : 'Ordinary tape.'
    const sentence = `Volume is ${volBand.word === 'normal' ? 'near normal' : volBand.word} — running at ${Math.round(rvol)}% of its usual pace.${overnightClause}`
    return { headline, sentence }
  }

  // Bar volatility only.
  if (atrGroup && atr != null && atrRatio != null && atrBand) {
    const headline =
      atrBand.word === 'very compressed' ? 'Flat tape.'
        : atrBand.word === 'compressed' ? 'Quiet tape.'
          : atrBand.word === 'elevated' ? 'Whippy tape.'
            : atrBand.word === 'very high' ? 'Violent tape.'
              : 'Ordinary tape.'
    const sentence = `1-min bars are averaging ${atr.toFixed(1)} pts, ${atrRatio.toFixed(1)}× your typical.${overnightClause}`
    return { headline, sentence }
  }

  // No banner-able read — chips (e.g. overnight-only pre-open) still render.
  return { headline: null, sentence: overnightClause.trim() || null }
}
