/**
 * IB break timing — how long after the Initial Balance closes price first
 * trades outside it.
 *
 * The bands were "Early (within first 15min) / Normal (15-60min) / Late
 * (60min+)": round numbers that never met the data. Measured on 946 front-month
 * NQ sessions (2023-01-03 → 2026-09-03, 1-minute bars from the raw .scid) the
 * MEDIAN break comes 13 minutes after the close, so "Early" described half of
 * all sessions (49.6%) and "Normal" barely a quarter (27.3%). Percentiles, in
 * minutes after the 07:30 PT close: p10 0 · p25 2 · p50 13 · p75 46 · p90 117;
 * 3.4% of sessions never break the IB at all.
 *
 * The bands below are cut on that distribution so each carries about a quarter
 * of sessions (26 / 24 / 23 / 24%), with two things the old scale could not say:
 *   - "Immediate": 17.5% of breaks come within one minute of the close. That is
 *     price already leaning on the edge when the hour ended, not a break that
 *     developed, and it trades differently from one at +14 minutes.
 *   - "Never broke": it had no option, so a session that stayed inside the IB
 *     was left on "Still developing" (which means "not decided yet") or
 *     mislabelled Late.
 * The label now says what the minutes are counted FROM — "first 15 min" read as
 * the first 15 minutes of the session, which is inside the IB.
 */

export const IB_BREAK_DEFAULT = 'Still developing'
export const IB_BREAK_NEVER = 'Never broke'

/** Upper bound (exclusive) in minutes after the IB close, checked in order. */
const BANDS: Array<{ max: number; label: string }> = [
  { max: 3, label: 'Immediate (under 3 min after the IB close)' },
  { max: 15, label: 'Early (3–15 min after)' },
  { max: 45, label: 'Normal (15–45 min after)' },
  { max: Infinity, label: 'Late (45 min+ after)' },
]

export const IB_BREAK_OPTIONS: string[] = [IB_BREAK_DEFAULT, ...BANDS.map(b => b.label), IB_BREAK_NEVER]

/** The old scale's labels. A prep saved with one keeps it — the old "Early"
 *  spans today's Immediate AND Early, so it cannot be converted, only shown. */
const LEGACY = new Set(['Early (within first 15min)', 'Normal (15-60min)', 'Late (60min+)'])
export const isLegacyIbBreak = (v: string | undefined | null): boolean => !!v && LEGACY.has(v)

/** Band for a measured break, e.g. 13 → "Early (3–15 min after)". */
export function ibBreakBand(minutes: number): string {
  return (BANDS.find(b => minutes < b.max) ?? BANDS[BANDS.length - 1]).label
}

/** What the bars say about the IB right now. */
export type IbTiming =
  | { state: 'forming' }                                                  // IB window still printing
  | { state: 'unbroken' }                                                 // closed, session running, no break yet
  | { state: 'broke'; minutes: number; side: 'above' | 'below' | 'both' }
  | { state: 'never' }                                                    // session over, IB never broken

/** The dropdown value a measurement implies; null = nothing to record yet. */
export function ibTimingValue(t: IbTiming | null): string | null {
  if (!t) return null
  if (t.state === 'broke') return ibBreakBand(t.minutes)
  if (t.state === 'never') return IB_BREAK_NEVER
  return null
}

/** One plain line for the form, e.g. "Broke below the IBL 13 min after the IB close". */
export function describeIbTiming(t: IbTiming | null): string | null {
  if (!t) return null
  switch (t.state) {
    case 'forming': return 'The IB is still forming.'
    case 'unbroken': return 'The IB has closed and has not been broken yet.'
    case 'never': return 'The session finished without breaking the IB.'
    case 'broke': {
      const where = t.side === 'above' ? 'above the IBH' : t.side === 'below' ? 'below the IBL' : 'both sides in the same minute'
      const when = t.minutes < 1 ? 'in the first minute after the IB close' : `${t.minutes} min after the IB close`
      return `Broke ${where} ${when}.`
    }
  }
}
