// Deep dive: TIME-OF-DAY EDGE. Tier 0 — entry timestamps and P&L, nothing else,
// so it runs on a broker CSV the hour it lands.
//
// Distinct from the time-of-day line in data-insights.ts, which contrasts three
// fixed session bins on win rate and emits one sentence. This decomposes the
// whole session bucket by bucket, finds where the money actually concentrates,
// and proposes a SESSION TRIM with a modelled dollar impact.
//
// Overfitting guard: the only trims considered are contiguous cuts from the
// EDGES of the trading day ("don't trade before X", "stop after Y"). Carving a
// losing hour out of the middle of the session fits noise and isn't a rule anyone
// can follow, so it's never proposed — even when it would score better.
//
// PURE + unit-tested (Intl formatting is deterministic given the input).

import { DIVE_Z_MIN_DIRECTIONAL, severityImpactShare, welchZ } from './stats'
import { type DeepDiveResult, type DiveSegment, type Investigation, fmtUsd, fmtPct } from './types'

export interface TimeOfDayTrade {
  /** ISO-8601 entry timestamp (UTC in the DB). */
  entryTime: string | null
  pnl: number | null
}

export interface TimeOfDayOptions {
  /** Trader's session timezone. PT is the house default (see data-insights). */
  timeZone?: string
  /** 60 by default; 30 once there are enough trades to support finer buckets. */
  bucketMinutes?: number
}

const DEFAULT_TZ = 'America/Los_Angeles'
/** Below this the session decomposition is noise. */
const MIN_TRADES = 40
/** Trades needed in a bucket before it can carry a claim. */
const MIN_BUCKET_N = 10
/** Below this a slot is a one-off; it's pooled into a single display row. */
const MIN_DISPLAY_N = 3
/** Half-hour buckets only once the sample supports them. */
const HALF_HOUR_AT = 150
/** A trim must leave at least this share of the trader's trades alive. */
const MIN_KEPT_SHARE = 0.6
/** …and this many trades. */
const MIN_KEPT_N = 20

interface Bucket {
  /** Minutes since local midnight at the bucket start. */
  start: number
  label: string
  pnls: number[]
  wins: number
  net: number
}

function localMinutes(iso: string, fmt: Intl.DateTimeFormat): number | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const [h, m] = fmt.format(new Date(ms)).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

/** "6:30am" / "12pm" — compact, no leading zeros. */
function clockLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const ampm = h24 < 12 ? 'am' : 'pm'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`
}

/** Short zone name ("PDT") taken from the trader's MOST RECENT trade, so labels
 *  match the offset they're trading in now. A multi-year window straddles DST, so
 *  some reference instant has to be chosen; the earliest trade was the first pick
 *  and it labelled a July session "PST" for an account whose history starts in
 *  winter. Latest is the least-wrong anchor — and never depends on the clock. */
function zoneAbbrev(iso: string, timeZone: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(ms))
  return parts.find(p => p.type === 'timeZoneName')?.value ?? ''
}

/**
 * Decompose the session, then propose the edge trim that recovers the most money
 * — but only when the trimmed region is both big enough to trust and separated
 * from the kept region by a real margin (Welch z on $/trade).
 */
export function analyzeTimeOfDay(trades: TimeOfDayTrade[], opts: TimeOfDayOptions = {}): DeepDiveResult | null {
  const timeZone = opts.timeZone ?? DEFAULT_TZ
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  const scored = trades.filter(t => t.pnl != null && t.entryTime)
  if (scored.length < MIN_TRADES) return null
  const size = opts.bucketMinutes ?? (scored.length >= HALF_HOUR_AT ? 30 : 60)

  const byStart = new Map<number, Bucket>()
  let latest: string | null = null
  for (const t of scored) {
    const mins = localMinutes(t.entryTime!, fmt)
    if (mins == null) continue
    if (latest == null || Date.parse(t.entryTime!) > Date.parse(latest)) latest = t.entryTime!
    const start = Math.floor(mins / size) * size
    let b = byStart.get(start)
    if (!b) { b = { start, label: clockLabel(start), pnls: [], wins: 0, net: 0 }; byStart.set(start, b) }
    b.pnls.push(t.pnl!)
    if (t.pnl! > 0) b.wins++
    b.net += t.pnl!
  }
  const buckets = [...byStart.values()].sort((a, b) => a.start - b.start)
  if (buckets.length < 2) return null
  const tz = latest ? zoneAbbrev(latest, timeZone) : ''
  const totalN = buckets.reduce((s, b) => s + b.pnls.length, 0)
  const totalNet = buckets.reduce((s, b) => s + b.net, 0)

  // Display: a real trading history has a long tail of one-off slots (a 4am fill,
  // a 1:30pm fill) that make the table unreadable and mean nothing individually.
  // They stay in ALL the analysis; they're just rolled into one row for display.
  const shown = buckets.filter(b => b.pnls.length >= MIN_DISPLAY_N)
  const thin = buckets.filter(b => b.pnls.length < MIN_DISPLAY_N)
  const segments: DiveSegment[] = shown.map(b => ({
    label: `${b.label}${tz ? ` ${tz}` : ''}`,
    value: Math.round(b.net / b.pnls.length),      // $/trade — the comparable metric
    n: b.pnls.length,
    pnl: Math.round(b.net),
    extra: { winRate: Math.round((b.wins / b.pnls.length) * 100) },
  }))
  if (thin.length) {
    const thinN = thin.reduce((s, b) => s + b.pnls.length, 0)
    const thinNet = thin.reduce((s, b) => s + b.net, 0)
    segments.push({
      label: `${thin.length} one-off slots (<${MIN_DISPLAY_N} trades each)`,
      value: Math.round(thinNet / thinN),
      n: thinN,
      pnl: Math.round(thinNet),
    })
  }

  // ── Edge trims: drop a contiguous run of buckets off the front, or off the
  //    back. i is the first kept bucket (front trim) / first dropped one (back).
  interface Trim { kind: 'before' | 'after'; boundary: number; dropped: Bucket[]; kept: Bucket[] }
  const candidates: Trim[] = []
  for (let i = 1; i < buckets.length; i++) {
    candidates.push({ kind: 'before', boundary: buckets[i].start, dropped: buckets.slice(0, i), kept: buckets.slice(i) })
    candidates.push({ kind: 'after', boundary: buckets[i].start, dropped: buckets.slice(i), kept: buckets.slice(0, i) })
  }

  let bestTrim: { trim: Trim; impact: number; z: number; droppedN: number } | null = null
  for (const trim of candidates) {
    const droppedPnls = trim.dropped.flatMap(b => b.pnls)
    const keptPnls = trim.kept.flatMap(b => b.pnls)
    const droppedNet = droppedPnls.reduce((s, x) => s + x, 0)
    if (droppedPnls.length < MIN_BUCKET_N || droppedNet >= 0) continue
    if (keptPnls.length < MIN_KEPT_N || keptPnls.length / totalN < MIN_KEPT_SHARE) continue
    const z = welchZ(keptPnls, droppedPnls)
    if (z < DIVE_Z_MIN_DIRECTIONAL) continue
    const impact = -droppedNet
    if (!bestTrim || impact > bestTrim.impact) bestTrim = { trim, impact, z, droppedN: droppedPnls.length }
  }

  // Best / worst buckets that carry enough sample to be quoted. The floor is
  // RELATIVE as well as absolute: on live data a 16-trade slot was out-ranking a
  // 771-trade slot on $/trade and getting quoted as "your best time of day",
  // which is just the small-sample tail talking.
  const quotableFloor = Math.max(MIN_BUCKET_N, Math.round(totalN * 0.01))
  const quotable = buckets.filter(b => b.pnls.length >= quotableFloor)
  const byPerTrade = [...quotable].sort((a, b) => b.net / b.pnls.length - a.net / a.pnls.length)
  const bestB = byPerTrade[0], worstB = byPerTrade[byPerTrade.length - 1]

  const detail: string[] = [
    `${totalN} trades across ${buckets.length} ${size}-minute slots of your session, ${fmtUsd(totalNet)} net.`,
  ]
  if (bestB && worstB && bestB !== worstB) {
    detail.push(
      `Best slot ${bestB.label}${tz ? ` ${tz}` : ''}: ${fmtUsd(bestB.net / bestB.pnls.length)}/trade over ${bestB.pnls.length} trades (${fmtPct((bestB.wins / bestB.pnls.length) * 100)} win rate).`,
      `Worst slot ${worstB.label}${tz ? ` ${tz}` : ''}: ${fmtUsd(worstB.net / worstB.pnls.length)}/trade over ${worstB.pnls.length} trades (${fmtPct((worstB.wins / worstB.pnls.length) * 100)}).`,
    )
  }
  const losers = buckets.filter(b => b.net < 0)
  if (losers.length) {
    const bleed = losers.reduce((s, b) => s + b.net, 0)
    const share = losers.reduce((s, b) => s + b.pnls.length, 0) / totalN
    detail.push(`Your losing slots are ${fmtPct(share * 100)} of your trades and ${fmtUsd(bleed)} of damage.`)
  }

  if (!bestTrim) {
    return {
      id: 'time-of-day',
      title: 'Your session clock',
      headline: bestB && worstB && bestB !== worstB
        ? `Your best slot pays ${fmtUsd(bestB.net / bestB.pnls.length)}/trade and your worst ${fmtUsd(worstB.net / worstB.pnls.length)}/trade — but no clean cut in the clock survives a significance check.`
        : `Your P&L is spread evenly across the session — the clock isn't where your edge lives.`,
      severity: 0.05,
      segments,
      detail: [...detail, `No trim of the start or end of your day separates from the rest by enough to act on, so shortening your session isn't the lever here.`],
    }
  }

  const { trim, impact, z, droppedN } = bestTrim
  // Severity base: gross |P&L| across the whole analyzed window — the trader's
  // own scale, not a fixed dollar bar.
  const grossAbsAll = buckets.reduce((s, b) => s + b.pnls.reduce((x, p) => x + Math.abs(p), 0), 0)
  const boundaryLabel = `${clockLabel(trim.boundary)}${tz ? ` ${tz}` : ''}`
  const keptN = trim.kept.reduce((s, b) => s + b.pnls.length, 0)
  const keptNet = trim.kept.reduce((s, b) => s + b.net, 0)
  // Name the cut region as a RANGE — enumerating it listed 16 labels on live data.
  const droppedRange = trim.dropped.length === 1
    ? trim.dropped[0].label
    : `${trim.dropped[0].label}–${trim.dropped[trim.dropped.length - 1].label}`
  const window = trim.kind === 'before'
    ? `before ${boundaryLabel}`
    : `from ${boundaryLabel} on`

  return {
    id: 'time-of-day',
    title: 'Your session clock',
    headline: `Everything you trade ${window} is a net ${fmtUsd(-impact)} — cutting it models ${fmtUsd(impact)} without touching the rest of your day.`,
    severity: Math.min(1, severityImpactShare(impact, grossAbsAll) * 0.6 + Math.min(1, z / 3.29) * 0.4),
    segments,
    detail: [
      ...detail,
      `The ${droppedN} trades ${window} (${droppedRange}, ${trim.dropped.length} slot${trim.dropped.length === 1 ? '' : 's'}) net ${fmtUsd(-impact)}; the ${keptN} inside your kept window net ${fmtUsd(keptNet)}.`,
      `Difference in $/trade between the two regions: z = ${z.toFixed(2)} — past the ${DIVE_Z_MIN_DIRECTIONAL} bar, so it's unlikely to be a run of bad luck.`,
    ],
    reframe: trim.kind === 'before'
      ? `You're not losing money trading — you're losing it WARMING UP. The same strategy pays from ${boundaryLabel} on; everything before it is tuition you pay every day.`
      : `Your edge has a shelf life. From ${boundaryLabel} on you're trading the same setups into a different tape, and it hands back what the good part of your day earned.`,
    test: {
      rule: trim.kind === 'before'
        ? `Take no entries before ${boundaryLabel}`
        : `Take no entries from ${boundaryLabel} onward`,
      impactUsd: impact,
      basis: `sum of the realized P&L of the ${droppedN} trades you'd have skipped, over the same window. Assumes the kept trades are unaffected — it removes entries, it doesn't move them.`,
    },
  }
}

export const timeOfDayInvestigation: Investigation<TimeOfDayTrade[]> = {
  id: 'time-of-day',
  title: 'Your session clock',
  requires: ['fills'],
  keywords: ['time of day', 'session', 'morning', 'afternoon', 'open', 'lunch', 'power hour', 'what time', 'hour'],
  run: trades => analyzeTimeOfDay(trades),
}
