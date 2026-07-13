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
 *   - bar volatility is atr_1m / atr_10d_avg (both points)
 *   - overnight + day range are % of ADR
 *   - IB is the stored ratio vs its 10-day average
 * Band edges are anchored to the analytics Condition Buckets quintile breaks
 * (RVOL 70/100/130/180) so the words agree with the tables. Spec approved
 * 2026-07-12 (Pt 12).
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
  /** ADR in points. */
  adr: number | null
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

const VOLUME_BANDS: BandDef[] = [
  { max: 40, word: 'very quiet', tone: 'red' },
  { max: 70, word: 'quiet', tone: 'dim' },
  { max: 130, word: 'normal', tone: 'plain' },
  { max: 180, word: 'busy', tone: 'dim' },
  { max: Infinity, word: 'very busy', tone: 'amber' },
]

const BAR_VOL_BANDS: BandDef[] = [
  { max: 0.6, word: 'very compressed', tone: 'red' },
  { max: 0.85, word: 'compressed', tone: 'dim' },
  { max: 1.25, word: 'normal', tone: 'plain' },
  { max: 2.0, word: 'elevated', tone: 'amber' },
  { max: Infinity, word: 'very high', tone: 'amber' },
]

const OVERNIGHT_BANDS: BandDef[] = [
  { max: 30, word: 'small', tone: 'plain' },
  { max: 60, word: 'normal', tone: 'plain' },
  { max: 90, word: 'large', tone: 'amber' },
  { max: Infinity, word: 'very large', tone: 'red' },
]

const RANGE_USED_BANDS: BandDef[] = [
  { max: 60, word: 'compressed', tone: 'dim' },
  { max: 85, word: 'below normal', tone: 'dim' },
  { max: 115, word: 'normal', tone: 'plain' },
  { max: 150, word: 'extended', tone: 'amber' },
  { max: Infinity, word: 'very extended', tone: 'amber' },
]

const IB_BANDS: BandDef[] = [
  { max: 0.6, word: 'very tight', tone: 'amber' },
  { max: 0.85, word: 'tight', tone: 'dim' },
  { max: 1.25, word: 'normal', tone: 'plain' },
  { max: 1.7, word: 'wide', tone: 'dim' },
  { max: Infinity, word: 'very wide', tone: 'amber' },
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
        ? `Average 1-minute bar range (ATR-10). Today is ${atr.toFixed(1)} pts vs a 10-day typical of ${atrBase!.toFixed(1)} pts — ${atrRatio.toFixed(1)}× normal.`
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
      title: onPct >= 90
        ? `The overnight session already covered ${Math.round(onPct)}% of a normal day's range — most of the expected move may be spent.`
        : `The overnight session covered ${Math.round(onPct)}% of a normal day's range (ADR).`,
    })
    raw.push({ label: 'Overnight range', value: `${(onh! - onl!).toFixed(2)} pts (${Math.round(onPct)}% of ADR)` })
  }

  // Range used — realized only; hidden pre-session so prep mornings don't show
  // a meaningless 12%.
  const dayRange = num(i.dayRange)
  const drPct = dayRange != null && adr != null && adr > 0 ? (dayRange / adr) * 100 : null
  const drBand = drPct != null ? band(drPct, RANGE_USED_BANDS) : null
  if (drPct != null && drBand) {
    chips.push({
      label: 'Range used',
      verdict: drBand.word,
      tone: drBand.tone,
      pill: `${Math.round(drPct)}% of ADR`,
      title: `Today's range so far is ${Math.round(drPct)}% of a normal day's range (ADR). Past ~100%, the expected daily move is spent — extension gets harder to chase.`,
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
      title: `First-hour range (Initial Balance) vs its 10-day average. ${ibRatio.toFixed(2)}× normal.`,
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
  const volGroup: VolGroup | null = rvol == null ? null : rvol < 70 ? 'quiet' : rvol < 130 ? 'normal' : 'busy'
  const atrGroup: AtrGroup | null = atrRatio == null ? null : atrRatio < 0.85 ? 'low' : atrRatio < 1.25 ? 'normal' : 'high'

  const overnightClause = onPct != null && onPct >= 90
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
