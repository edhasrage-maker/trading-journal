// Infer a trader's STYLE from their imported trades (Pt 11), so the coach can
// personalize capture/leak analysis without a long onboarding form. "Infer
// everything, confirm": this produces a best-guess style + a plain-English basis
// for each field, which the client shows as one editable confirmation card.
//
// PURE (no server imports) so it can run client- or server-side and be
// unit-tested — same contract as coach-suggestions.ts / scoring-profile.ts.
//
// The coach reads the CONFIRMED result (persisted to
// scoring_profile_json.style); this module only proposes the defaults.

import { followFade, type Regime } from '@/lib/market-structure'

export type Timeframe = 'scalp' | 'intraday' | 'swing'
export type ExitStyle = 'fixed_target' | 'scale_out' | 'trail' | 'let_run' | 'discretionary'
export type UsesStops = 'always' | 'sometimes' | 'never'
export type EdgeStyle = 'trend' | 'mean_reversion' | 'breakout' | 'range'

/** The style fields persisted under ScoringProfile.style (all nullable). */
export interface TradingStyle {
  timeframe: Timeframe | null
  exit_style: ExitStyle | null
  uses_stops: UsesStops | null
  scales_out: boolean | null
  edge_style: EdgeStyle | null
}

/** A single inferred field: the guessed value + why (shown on the confirm card),
 *  and whether we had enough data to guess at all. */
export interface Inferred<T> {
  value: T | null
  basis: string
  confident: boolean
}

export interface InferredStyle {
  timeframe: Inferred<Timeframe>
  exit_style: Inferred<ExitStyle>
  uses_stops: Inferred<UsesStops>
  scales_out: Inferred<boolean>
  edge_style: Inferred<EdgeStyle>
}

/** The trade fields the inference reads (superset-safe). */
export interface StyleTrade {
  entry_time: string | null
  exit_time: string | null
  stop_price: number | null
  pnl: number | null
  direction: 'long' | 'short' | null
  entry_price: number | null
  high_during_position: number | null
  low_during_position: number | null
  structure_5m_regime: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json: any
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}
const fmtDur = (sec: number): string => {
  if (sec < 90) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}
const legCount = (ej: unknown): number => (Array.isArray(ej) ? ej.filter(l => l && (l.qty ?? 0) > 0).length : 0)

/**
 * Infer trading style from a sample of the trader's trades (best-effort per
 * field — a field with too little signal comes back `confident: false` with a
 * conservative default the user can accept or override).
 */
export function inferTradingStyle(trades: StyleTrade[]): InferredStyle {
  const withTimes = trades.filter(t => t.entry_time && t.exit_time)
  const holdsSec = withTimes
    .map(t => (Date.parse(t.exit_time!) - Date.parse(t.entry_time!)) / 1000)
    .filter(s => Number.isFinite(s) && s > 0)

  // ── timeframe: median hold time ──
  const medHold = median(holdsSec)
  const timeframe: Inferred<Timeframe> = (() => {
    if (!Number.isFinite(medHold)) return { value: null, basis: 'no entry/exit times to read hold length', confident: false }
    const v: Timeframe = medHold < 300 ? 'scalp' : medHold < 3600 ? 'intraday' : 'swing'
    return { value: v, basis: `median hold ${fmtDur(medHold)}`, confident: holdsSec.length >= 20 }
  })()

  // ── uses_stops: share of trades carrying a stop ──
  const stopShare = trades.length ? trades.filter(t => t.stop_price != null).length / trades.length : 0
  const uses_stops: Inferred<UsesStops> = (() => {
    if (trades.length < 10) return { value: null, basis: 'too few trades to tell', confident: false }
    const v: UsesStops = stopShare >= 0.8 ? 'always' : stopShare >= 0.2 ? 'sometimes' : 'never'
    return { value: v, basis: `${Math.round(stopShare * 100)}% of trades have a logged stop`, confident: true }
  })()

  // ── scales_out: share of trades with >1 exit leg ──
  const scaleShare = trades.length ? trades.filter(t => legCount(t.exits_json) > 1).length / trades.length : 0
  const scales_out: Inferred<boolean> = (() => {
    // exits_json is native-only; if NOTHING has legs we can't distinguish
    // "all-out" from "no leg data".
    const anyLegs = trades.some(t => legCount(t.exits_json) >= 1)
    if (!anyLegs) return { value: null, basis: 'no per-leg exit data in this import', confident: false }
    const v = scaleShare >= 0.15
    return { value: v, basis: `${Math.round(scaleShare * 100)}% of trades scaled out`, confident: true }
  })()

  // ── exit_style ──
  const exit_style: Inferred<ExitStyle> = (() => {
    if (scales_out.value) return { value: 'scale_out', basis: `${Math.round(scaleShare * 100)}% scale out`, confident: scales_out.confident }
    // Winner-size skew: a right-skewed winner distribution (a few big runners
    // dwarf the median) reads as "let it run"; tightly-clustered winners read as
    // "fixed target". Uses $ pnl (works without stops).
    const winners = trades.filter(t => (t.pnl ?? 0) > 0).map(t => t.pnl as number)
    if (winners.length < 15) return { value: 'discretionary', basis: 'not enough winners to read an exit pattern', confident: false }
    const med = median(winners)
    const p90 = [...winners].sort((a, b) => a - b)[Math.floor(winners.length * 0.9)]
    if (med > 0 && p90 / med >= 2.8) return { value: 'let_run', basis: `top winners ≫ typical (p90 ${Math.round(p90 / med)}× median)`, confident: true }
    return { value: 'fixed_target', basis: 'winners cluster near a consistent size', confident: true }
  })()

  // ── edge_style: follow vs fade the 5m pivot structure ──
  const edge_style: Inferred<EdgeStyle> = (() => {
    let follow = 0, fade = 0
    for (const t of trades) {
      if (!t.direction || !t.structure_5m_regime) continue
      const ff = followFade(t.direction, t.structure_5m_regime as Regime)
      if (ff === 'follow') follow++; else if (ff === 'fade') fade++
    }
    const n = follow + fade
    if (n < 20) return { value: null, basis: 'not enough trades with 5m structure', confident: false }
    const followPct = follow / n
    if (followPct >= 0.6) return { value: 'trend', basis: `${Math.round(followPct * 100)}% follow the 5m trend`, confident: true }
    if (followPct <= 0.4) return { value: 'mean_reversion', basis: `${Math.round((1 - followPct) * 100)}% fade the 5m trend`, confident: true }
    return { value: null, basis: 'mixed follow/fade — no clear lean', confident: false }
  })()

  return { timeframe, exit_style, uses_stops, scales_out, edge_style }
}

/** Collapse an InferredStyle down to the persisted TradingStyle (values only). */
export function toTradingStyle(i: InferredStyle): TradingStyle {
  return {
    timeframe: i.timeframe.value,
    exit_style: i.exit_style.value,
    uses_stops: i.uses_stops.value,
    scales_out: i.scales_out.value,
    edge_style: i.edge_style.value,
  }
}
