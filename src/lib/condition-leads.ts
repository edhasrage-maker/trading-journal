import type { ConditionLookupRow, ConditionMetric, ConditionThreshold } from '@/lib/supabase/types'
import { assignBuckets, type MetricInputs } from '@/lib/condition-lookup'
import {
  bucketTrades,
  buildLookupRows,
  computeThresholds,
  deriveMetrics,
  matchesConstraint,
  type BucketedTrade,
  type ConditionData,
} from '@/lib/condition-lookup-refresh'

/**
 * Morning Conditions as FORWARD TESTS, not findings.
 *
 * Why this exists. The panel used to grade the day ("Be selective · Grade C")
 * and the proposed replacement named the trader's "edge" — the lookup row whose
 * results most clearly beat their average. A hold-out on the owner's 2026
 * trades (scripts/study-morning-conditions-holdout.mts, 2026-10-13) showed
 * neither is supportable:
 *   - the headline edge (+$59 over 146 trades) was 2025 trades plus seven
 *     sessions of Jan–Apr; from June it ran PF 1.06 against 1.09 for everything
 *     else;
 *   - of the rows the same rule picked on Jan–May, two of three flipped sign on
 *     Jun–Oct;
 *   - with conditions shuffled across sessions the rule still "finds" rows about
 *     as often as it does in the real data, and a third of shuffles produce a
 *     positive "edge".
 * A row that clears the baseline in-sample is therefore a LEAD — something
 * worth watching — and the only honest thing to show beside it is what it has
 * done since it was picked.
 *
 * How it works, with no stored state:
 *   - the FREEZE DATE is the first day of the current calendar quarter;
 *   - leads and their cut points are chosen from sessions BEFORE that date
 *     only (so nothing a lead is later scored on helped to choose it);
 *   - every trade from the freeze date on is the forward test.
 * Because the freeze date is a function of the calendar, the same inputs always
 * give the same leads — no table, no migration, and it works for every trader.
 * Each new quarter re-picks from everything before it and starts a fresh count.
 */

/** A lead needs this much behind it before it is worth tracking. The session
 *  floor matters as much as the trade floor: the dead "edge" above had 36
 *  trades in one period, taken across just seven sessions. */
export const LEAD_MIN_TRADES = 30
export const LEAD_MIN_SESSIONS = 10
/** Tracking more than a few at once is just a smaller version of the search
 *  that produced false positives in the first place. */
export const LEAD_MAX = 3
/** Below this many forward trades inside the lead, say "too few to judge". */
export const FORWARD_MIN_TRADES = 20

const METRICS: ConditionMetric[] = ['RVOL', 'DR_ADR', 'IB', 'ATR_730', 'IB_ATR']
const BUCKET_COL: Record<ConditionMetric, keyof ConditionLookupRow> = {
  RVOL: 'rvol_b', DR_ADR: 'dr_adr_b', IB: 'ib_b', ATR_730: 'atr_730_b', IB_ATR: 'ib_atr_b',
}

export interface SideStats {
  n: number
  sessions: number
  /** 0–1, wins / (wins + losses); null with no decided trades. */
  wr: number | null
  pf: number | null
  /** Average P&L per trade. */
  ev: number | null
}

export interface LeadCut {
  metric: ConditionMetric
  bucket: string
  /** Plain statement of the frozen cut, e.g. "RVOL above 102". */
  text: string
}

export type ForwardState = 'too-few' | 'holding' | 'not-holding'

export interface Lead {
  condition_id: string
  /** Plain-language name, e.g. "Busier volume, choppier IB". */
  name: string
  cuts: LeadCut[]
  /** Which side of the trader's average the lead sat on when it was picked. */
  side: 'above' | 'below'
  /** In-sample: the trades that made it a lead (all before the freeze date). */
  picked: SideStats & { ci_lo: number | null; ci_hi: number | null }
  /** Out-of-sample: trades since the freeze date, inside vs everything else. */
  forwardIn: SideStats
  forwardOut: SideStats
  forwardState: ForwardState
  /** Does the session being viewed fall inside the lead? null = can't tell. */
  matchesDay: boolean | null
}

export interface LeadsResult {
  status: 'ok' | 'no-leads' | 'not-enough-history'
  /** YYYY-MM-DD — leads were chosen from sessions before this date. */
  freezeDate: string
  /** The trader's average over the sessions the leads were chosen from. */
  pickedBaseline: SideStats
  /** Everything since the freeze date. */
  forwardBaseline: SideStats
  leads: Lead[]
}

/** First day of the calendar quarter containing `date` (YYYY-MM-DD). */
export function quarterStart(date: string): string {
  const [y, m] = date.split('-').map(Number)
  const qm = Math.floor((m - 1) / 3) * 3 + 1
  return `${y}-${String(qm).padStart(2, '0')}-01`
}

function sideStats(trades: BucketedTrade[]): SideStats {
  const rows = trades.filter(b => b.trade.pnl != null && Number.isFinite(b.trade.pnl))
  const pnls = rows.map(b => b.trade.pnl as number)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p < 0)
  const sumW = wins.reduce((s, v) => s + v, 0)
  const sumL = losses.reduce((s, v) => s + v, 0)
  return {
    n: pnls.length,
    sessions: new Set(rows.map(b => b.trade.date)).size,
    wr: wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : null,
    pf: sumL < 0 ? sumW / Math.abs(sumL) : null,
    ev: pnls.length > 0 ? pnls.reduce((s, v) => s + v, 0) / pnls.length : null,
  }
}

// ─── Plain-language names ────────────────────────────────────────────────────
// Comparatives on purpose ("larger", "choppier"): a median bucket only says
// which HALF of the trader's days this is. Calling 0.96× the 10-day average a
// "large opening range" contradicted the ledger, which calls the same number
// "normal".

const WORDS: Record<ConditionMetric, Record<string, string>> = {
  RVOL: { LOW: 'quieter volume', HIGH: 'busier volume', L: 'quietest-third volume', M: 'middle-third volume', H: 'busiest-third volume' },
  DR_ADR: { LOW: 'less of the day’s range used', HIGH: 'more of the day’s range used', L: 'little of the day’s range used', M: 'a typical share of the range used', H: 'much of the day’s range used' },
  IB: { LOW: 'smaller opening range', HIGH: 'larger opening range', L: 'smallest-third opening range', M: 'middle-third opening range', H: 'largest-third opening range' },
  ATR_730: { LOW: 'smaller bars', HIGH: 'bigger bars', L: 'smallest-third bars', M: 'middle-third bars', H: 'biggest-third bars' },
  IB_ATR: { LOW: 'choppier IB', HIGH: 'cleaner IB', L: 'choppy IB', M: 'mid IB', H: 'expanded IB' },
}

const METRIC_LABEL: Record<ConditionMetric, string> = {
  RVOL: 'RVOL at IB close',
  DR_ADR: 'IB ÷ ADR',
  IB: 'IB vs 10-day',
  ATR_730: 'ATR vs typical',
  IB_ATR: 'IB ÷ ATR',
}

const fmtCut = (metric: ConditionMetric, v: number): string =>
  metric === 'RVOL' ? v.toFixed(0)
    : metric === 'DR_ADR' ? `${v.toFixed(0)}%`
      : metric === 'IB_ATR' ? v.toFixed(1)
        : `${v.toFixed(2)}×`

function cutText(metric: ConditionMetric, bucket: string, t: ConditionThreshold): string {
  const label = METRIC_LABEL[metric]
  const med = fmtCut(metric, t.median), lo = fmtCut(metric, t.tertile_low), hi = fmtCut(metric, t.tertile_high)
  switch (bucket) {
    case 'LOW': return `${label} at or under ${med}`
    case 'HIGH': return `${label} over ${med}`
    case 'L': return `${label} at or under ${lo}`
    case 'M': return `${label} ${lo}–${hi}`
    case 'H': return `${label} over ${hi}`
    default: return label
  }
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * Pick this quarter's leads from the sessions before it, then score them on the
 * sessions since. `dayInputs` are the five metrics of the session being viewed,
 * used only to say whether that session falls inside each lead.
 */
export function buildLeads(
  data: ConditionData,
  today: string,
  dayInputs?: MetricInputs | null,
): LeadsResult {
  const freezeDate = quarterStart(today)
  const empty: SideStats = { n: 0, sessions: 0, wr: null, pf: null, ev: null }

  // Cuts come from pre-freeze sessions only — a cut that moved with later data
  // would let the forward test leak into its own definition.
  const pickedContexts = data.contexts.filter(c => c.date < freezeDate)
  const thresholds = computeThresholds(pickedContexts.map(c => deriveMetrics(c)))
  const byMetric = new Map(thresholds.map(t => [t.metric, t]))

  const pickedTrades = data.trades.filter(t => t.date < freezeDate)
  const forwardTrades = data.trades.filter(t => t.date >= freezeDate)
  const forwardBucketed = bucketTrades(forwardTrades, data.metricsByKey, thresholds)
  const forwardBaseline = sideStats(forwardBucketed)

  const rows = buildLookupRows(pickedTrades, data.metricsByKey, thresholds)
  const base = rows.find(r => r.specificity === 0)
  const pickedBaseline: SideStats = base
    ? { n: base.n_trades ?? 0, sessions: base.n_sessions ?? 0, wr: base.trade_wr ?? null, pf: base.profit_factor ?? null, ev: base.ev_per_trade ?? null }
    : empty

  if (!base || base.ev_per_trade == null || (base.n_trades ?? 0) < LEAD_MIN_TRADES) {
    return { status: 'not-enough-history', freezeDate, pickedBaseline, forwardBaseline, leads: [] }
  }
  const baseEv = base.ev_per_trade

  const clears = (r: ConditionLookupRow) =>
    (r.ev_ci_lo != null && r.ev_ci_lo > baseEv) || (r.ev_ci_hi != null && r.ev_ci_hi < baseEv)
  const sideOf = (r: ConditionLookupRow): 'above' | 'below' => ((r.ev_per_trade ?? 0) > baseEv ? 'above' : 'below')
  /** Constrained metrics by direction only (LOW and L are one family), so a row
   *  and its near-duplicate in the other view aren't both tracked. */
  const family = (r: ConditionLookupRow) =>
    new Set(METRICS.filter(m => r[BUCKET_COL[m]] !== 'ANY').map(m => `${m}=${String(r[BUCKET_COL[m]])[0]}`))

  const candidates = rows
    .filter(r => r.specificity > 0
      && (r.n_trades ?? 0) >= LEAD_MIN_TRADES
      && (r.n_sessions ?? 0) >= LEAD_MIN_SESSIONS
      && clears(r))
    // Most evidence first — NOT most extreme, which would be picking noise.
    .sort((a, b) => (b.n_trades ?? 0) - (a.n_trades ?? 0) || a.condition_id.localeCompare(b.condition_id))

  const chosen: ConditionLookupRow[] = []
  for (const r of candidates) {
    const fam = family(r)
    const nested = chosen.some(o => {
      const of = family(o)
      const subset = [...of].every(x => fam.has(x)) || [...fam].every(x => of.has(x))
      return subset && sideOf(o) === sideOf(r)
    })
    if (!nested) chosen.push(r)
    if (chosen.length >= LEAD_MAX) break
  }

  const dayBuckets = dayInputs ? assignBuckets(dayInputs, thresholds) : null

  const leads: Lead[] = chosen.map(r => {
    const mode: 'median' | 'tertile' = r.combo_type.includes('tertile') ? 'tertile' : 'median'
    const constraint = Object.fromEntries(METRICS.map(m => [m, r[BUCKET_COL[m]] as string])) as Record<ConditionMetric, string>
    const constrained = METRICS.filter(m => constraint[m] !== 'ANY')
    const inside = forwardBucketed.filter(b => matchesConstraint(b, constraint, mode))
    const insideSet = new Set(inside)
    const forwardIn = sideStats(inside)
    const forwardOut = sideStats(forwardBucketed.filter(b => !insideSet.has(b)))
    const side = sideOf(r)

    let forwardState: ForwardState = 'too-few'
    if (forwardIn.n >= FORWARD_MIN_TRADES && forwardOut.n >= FORWARD_MIN_TRADES && forwardIn.ev != null && forwardOut.ev != null) {
      const sameSide = side === 'above' ? forwardIn.ev > forwardOut.ev : forwardIn.ev < forwardOut.ev
      forwardState = sameSide ? 'holding' : 'not-holding'
    }

    let matchesDay: boolean | null = null
    if (dayBuckets) {
      matchesDay = true
      for (const m of constrained) {
        const b = dayBuckets.find(x => x.metric === m)
        const mine = b ? (mode === 'median' ? b.median_bucket : b.tertile_bucket) : null
        if (mine == null) { matchesDay = null; break }
        if (mine !== constraint[m]) { matchesDay = false; break }
      }
    }

    return {
      condition_id: r.condition_id,
      name: capitalise(constrained.map(m => WORDS[m][constraint[m]] ?? constraint[m]).join(', ')),
      cuts: constrained.map(m => ({ metric: m, bucket: constraint[m], text: cutText(m, constraint[m], byMetric.get(m)!) })),
      side,
      picked: {
        n: r.n_trades ?? 0, sessions: r.n_sessions ?? 0, wr: r.trade_wr ?? null, pf: r.profit_factor ?? null,
        ev: r.ev_per_trade ?? null, ci_lo: r.ev_ci_lo ?? null, ci_hi: r.ev_ci_hi ?? null,
      },
      forwardIn, forwardOut, forwardState, matchesDay,
    }
  })

  return { status: leads.length > 0 ? 'ok' : 'no-leads', freezeDate, pickedBaseline, forwardBaseline, leads }
}
