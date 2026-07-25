/**
 * Tag-free auto-insights (Pt 15).
 *
 * On a fresh CSV / Sierra import trades land as raw fills with NO tags, so every
 * tag-based analytic (Setup Performance, Patterns) collapses to a single
 * "Discretionary/No Setup" bucket and a new account gets nothing. This engine
 * derives insights from the RAW trade data alone — zero trader knowledge, zero
 * tags — by computing a catalog of candidate contrasts across dimensions
 * (time-of-day, instrument, direction, trades-per-day, re-entry, capture,
 * hold time, size, prev-outcome, day-of-week), ranking them by
 * (effect size × sample confidence), and surfacing only the few that clear a
 * significance + min-sample bar. Everything below the bar is silently
 * suppressed — never "ES beats NQ on n=4". The suppression is the trust
 * feature.
 *
 * Pure + dependency-light (reuses analytics.ts capture math, the
 * behavioral-proxies re-entry detector, and the futures-symbols root map) so it
 * runs both server-side (the first-read teaser route) and client-side (the
 * Patterns page insights block), mirroring behavioral-proxies.ts.
 *
 * ── The one statistical model ────────────────────────────────────────────────
 * Every candidate is a TWO-GROUP CONTRAST: group A (highlighted) vs group B
 * (its complement or paired group), on ONE outcome metric with a known unit.
 * Both groups always share the unit, so the comparison is clean; cross-dimension
 * ranking uses a UNITLESS standardized effect (Cohen's d for continuous
 * metrics, Cohen's h for win-rate proportions) so "instrument in $" and
 * "time-of-day in win%" are directly comparable.
 *
 *   score  = |standardized effect| × w,  w = clamp(|z| / Z_REF, 0, 1)
 *   gate   = nA ≥ nMin AND nB ≥ nMin AND |z| ≥ Z_MIN AND |std effect| ≥ EFFECT_MIN
 *
 * Z_MIN = 1.96 (two-sided 95%, deliberately conservative because we cherry-pick
 * the top few from ~10 contrasts = multiple-comparison risk). EFFECT_MIN = 0.2
 * (small-effect floor) stops a huge-n portfolio from surfacing a
 * statistically-real-but-trivial gap. nMin = MIN_SAMPLE (10) on BOTH sides.
 */

import { MIN_SAMPLE } from '@/lib/sample-size'
import { symbolRoot } from '@/lib/futures-symbols'
import { revengeReentryIds } from '@/lib/behavioral-proxies'
import { captureComponents, type TradeWithExcursion } from '@/lib/analytics'

// ── Tunables ────────────────────────────────────────────────────────────────
/** Confidence saturates here: |z| ≥ 3.29 (≈ p .001) → weight 1. */
const Z_REF = 3.29
/** Significance bar — two-sided 95%. */
export const INSIGHT_Z_MIN = 1.96
/** Practical-magnitude floor on the standardized effect (Cohen's d / h). */
export const INSIGHT_EFFECT_MIN = 0.2
/** Default min sample on BOTH sides of a contrast. */
const DEFAULT_MIN_N = MIN_SAMPLE
/** Rarer-event dimensions (revenge re-entries) may drop to this, never below. */
const RARE_MIN_N = 6
/** Capture-leakage benchmark: below this fraction of the favorable move booked,
 *  a low-capture read is worth surfacing. */
const CAPTURE_BENCHMARK = 0.5

// ── Trade shape the engine reads (a superset satisfied by both the analytics
//    TradeWithContext rows and the first-read TeaserTrade rows). All fields
//    nullable — a fills-only import may be missing any of them. ────────────────
export interface InsightTrade {
  id: string
  pnl: number | null
  direction: 'long' | 'short' | null
  entry_time: string | null
  exit_time: string | null
  symbol: string | null
  quantity: number | null
  entry_price: number | null
  stop_price: number | null
  high_during_position: number | null
  low_during_position: number | null
  entry_atr_1m?: number | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exits_json?: any
  mfe_dollars_per_leg?: number | null
  /** PT trading-day date (YYYY-MM-DD) when the caller has it (analytics rows). */
  date?: string | null
  trading_day_id?: string | null
}

export type InsightTone = 'good' | 'bad' | 'neutral'

export interface RankedInsight {
  /** Dimension key — one per family, so a family emits at most one insight. */
  key: string
  /** Short group label for the eyebrow, e.g. "Time of day". */
  dimension: string
  headline: string
  detail: string
  /** Sample line, e.g. "34 vs 51 trades". */
  footnote: string
  tone: InsightTone
  /** |standardized effect| × confidence weight — the rank key. */
  score: number
}

// ── Stats core ───────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
/** Sample variance (n−1). 0 for n < 2. */
function variance(xs: number[], m: number): number {
  if (xs.length < 2) return 0
  return xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1)
}
function clamp01(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p
}

interface Contrast {
  nA: number
  nB: number
  meanA: number
  meanB: number
  /** meanA − meanB, native unit. */
  effect: number
  /** Cohen's d (continuous) or h (proportion) — unitless, cross-dim comparable. */
  stdEffect: number
  z: number
  score: number
  passes: boolean
}

/** Welch two-sample contrast on a continuous metric (PnL $, R, hold-min, …). */
function contrastContinuous(a: number[], b: number[], minN = DEFAULT_MIN_N): Contrast | null {
  const nA = a.length, nB = b.length
  if (nA < 2 || nB < 2) return null
  const mA = mean(a), mB = mean(b)
  const vA = variance(a, mA), vB = variance(b, mB)
  const se = Math.sqrt(vA / nA + vB / nB)
  const pooledSD = Math.sqrt(((nA - 1) * vA + (nB - 1) * vB) / (nA + nB - 2))
  const effect = mA - mB
  const z = se > 0 ? effect / se : 0
  const stdEffect = pooledSD > 0 ? effect / pooledSD : 0
  return finish(nA, nB, mA, mB, effect, stdEffect, z, minN)
}

/** Two-proportion contrast on win-rate (a, b are 0/1 win flags). Uses the
 *  pooled-proportion SE (textbook two-proportion z-test) so a group with a
 *  degenerate 0%/100% rate doesn't blow the denominator up; effect size is
 *  Cohen's h on the raw proportions. */
function contrastProportion(a: number[], b: number[], minN = DEFAULT_MIN_N): Contrast | null {
  const nA = a.length, nB = b.length
  if (nA < 2 || nB < 2) return null
  const xA = a.reduce((s, v) => s + v, 0), xB = b.reduce((s, v) => s + v, 0)
  const pA = xA / nA, pB = xB / nB
  const pPool = (xA + xB) / (nA + nB)
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nA + 1 / nB))
  const effect = pA - pB
  const z = se > 0 ? effect / se : 0
  const h = 2 * Math.asin(Math.sqrt(clamp01(pA))) - 2 * Math.asin(Math.sqrt(clamp01(pB)))
  return finish(nA, nB, pA, pB, effect, h, z, minN)
}

/** One-sample contrast of a metric vs a fixed benchmark (capture % vs 0.5).
 *  nB carries the sample count for the footnote; meanB is the benchmark. */
function contrastVsBenchmark(xs: number[], mu0: number, minN = DEFAULT_MIN_N): Contrast | null {
  const n = xs.length
  if (n < 2) return null
  const m = mean(xs)
  const sd = Math.sqrt(variance(xs, m))
  const se = sd > 0 ? sd / Math.sqrt(n) : 0
  const effect = m - mu0
  const z = se > 0 ? effect / se : 0
  const stdEffect = sd > 0 ? effect / sd : 0
  // One-sample gate: only the single group needs to clear minN.
  const w = Math.min(1, Math.abs(z) / Z_REF)
  const score = Math.abs(stdEffect) * w
  const passes =
    n >= minN &&
    Math.abs(z) >= INSIGHT_Z_MIN &&
    Math.abs(stdEffect) >= INSIGHT_EFFECT_MIN &&
    Number.isFinite(z) && Number.isFinite(stdEffect)
  return { nA: n, nB: n, meanA: m, meanB: mu0, effect, stdEffect, z, score, passes }
}

function finish(
  nA: number, nB: number, meanA: number, meanB: number,
  effect: number, stdEffect: number, z: number, minN: number,
): Contrast {
  const w = Math.min(1, Math.abs(z) / Z_REF)
  const score = Math.abs(stdEffect) * w
  const passes =
    nA >= minN && nB >= minN &&
    Math.abs(z) >= INSIGHT_Z_MIN &&
    Math.abs(stdEffect) >= INSIGHT_EFFECT_MIN &&
    Number.isFinite(z) && Number.isFinite(stdEffect)
  return { nA, nB, meanA, meanB, effect, stdEffect, z, score, passes }
}

// ── Per-trade metric extractors ──────────────────────────────────────────────

/** Win flags (1 = pnl>0, 0 = pnl<0), scratches (pnl===0) excluded — matches the
 *  win-rate denominator used everywhere else (decided trades only). */
function winFlags(ts: InsightTrade[]): number[] {
  const out: number[] = []
  for (const t of ts) if (t.pnl != null && t.pnl !== 0) out.push(t.pnl > 0 ? 1 : 0)
  return out
}
function pnlValues(ts: InsightTrade[]): number[] {
  const out: number[] = []
  for (const t of ts) if (t.pnl != null) out.push(t.pnl)
  return out
}
function netPnl(ts: InsightTrade[]): number {
  return ts.reduce((s, t) => s + (t.pnl ?? 0), 0)
}

// ── PT time helpers (entry_time is UTC ISO; the trader lives in PT) ───────────
const PT_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23',
})
const PT_WEEKDAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'long',
})
const PT_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
})

function ptHour(iso: string): number | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const h = Number(PT_HOUR.format(new Date(ms)))
  return Number.isFinite(h) ? h : null
}
function ptWeekday(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return PT_WEEKDAY.format(new Date(ms))
}
function ptDate(iso: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return PT_YMD.format(new Date(ms)) // en-CA → YYYY-MM-DD
}

/** Stable day key: caller-supplied PT date, else trading_day_id, else PT-derived. */
function dayKeyOf(t: InsightTrade): string | null {
  if (t.date) return t.date
  if (t.trading_day_id) return t.trading_day_id
  return t.entry_time ? ptDate(t.entry_time) : null
}

// ── Formatting ───────────────────────────────────────────────────────────────
function pct(p: number): string {
  return `${Math.round(p * 100)}%`
}
function fmtSignedUsd(n: number): string {
  const r = Math.round(n)
  return `${r >= 0 ? '+' : '−'}$${Math.abs(r).toLocaleString('en-US')}`
}
function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
function footN(nA: number, nB: number, unit = 'trades'): string {
  return `${nA} vs ${nB} ${unit}`
}

// ── Day-level rollup (shared by trades-per-day + day-of-week) ─────────────────
interface DayRollup {
  key: string
  pnl: number
  count: number
  weekday: string | null
}
function rollupDays(trades: InsightTrade[]): DayRollup[] {
  const byDay = new Map<string, InsightTrade[]>()
  for (const t of trades) {
    const k = dayKeyOf(t)
    if (!k) continue
    const arr = byDay.get(k) ?? []
    arr.push(t)
    byDay.set(k, arr)
  }
  const out: DayRollup[] = []
  for (const [key, ts] of byDay) {
    const wd = ts.find(t => t.entry_time)?.entry_time
    out.push({
      key,
      pnl: netPnl(ts),
      count: ts.length,
      weekday: wd ? ptWeekday(wd) : null,
    })
  }
  return out
}

// ── Dimension builders — each returns ≤1 candidate (its strongest contrast) ───
type Builder = (trades: InsightTrade[]) => RankedInsight | null

/** 1. Time-of-day — best/worst PT entry-hour session bucket vs the rest. */
const timeOfDay: Builder = trades => {
  const bins: Record<string, { label: string; ts: InsightTrade[] }> = {
    open: { label: 'right after the open (6:30–8am PT)', ts: [] },
    mid: { label: 'late morning (8–11am PT)', ts: [] },
    close: { label: 'the afternoon (11am–1pm PT)', ts: [] },
    off: { label: 'off-hours', ts: [] },
  }
  for (const t of trades) {
    const h = t.entry_time ? ptHour(t.entry_time) : null
    if (h == null) continue
    const k = h >= 6 && h < 8 ? 'open' : h >= 8 && h < 11 ? 'mid' : h >= 11 && h < 14 ? 'close' : 'off'
    bins[k].ts.push(t)
  }
  let best: { c: Contrast; label: string } | null = null
  for (const k of ['open', 'mid', 'close'] as const) {
    const inBin = bins[k].ts
    const rest = trades.filter(t => !inBin.includes(t))
    const c = contrastProportion(winFlags(inBin), winFlags(rest))
    if (c?.passes && (!best || c.score > best.c.score)) best = { c, label: bins[k].label }
  }
  if (!best) return null
  const { c, label } = best
  const better = c.effect > 0
  return {
    key: 'time_of_day', dimension: 'Time of day',
    headline: better ? `You're sharpest ${label.replace(/ \(.*/, '')}` : `${cap(label.replace(/ \(.*/, ''))} is your weak spot`,
    detail: better
      ? `You win ${pct(c.meanA)} of trades ${label} vs ${pct(c.meanB)} the rest of the day.`
      : `You win only ${pct(c.meanA)} ${label} vs ${pct(c.meanB)} otherwise.`,
    footnote: footN(c.nA, c.nB), tone: better ? 'good' : 'bad', score: c.score,
  }
}

/** 2. Instrument — the single most extreme symbol-root vs everything else. */
const instrument: Builder = trades => {
  const byRoot = new Map<string, InsightTrade[]>()
  for (const t of trades) {
    if (!t.symbol) continue
    const r = symbolRoot(t.symbol)
    if (!r) continue
    const arr = byRoot.get(r) ?? []
    arr.push(t)
    byRoot.set(r, arr)
  }
  let best: { c: Contrast; root: string; net: number } | null = null
  for (const [root, ts] of byRoot) {
    const rest = trades.filter(t => !ts.includes(t))
    const c = contrastProportion(winFlags(ts), winFlags(rest))
    if (c?.passes && (!best || c.score > best.c.score)) best = { c, root, net: netPnl(ts) }
  }
  if (!best) return null
  const { c, root, net } = best
  const better = c.effect > 0
  return {
    key: 'instrument', dimension: 'Instrument',
    headline: better ? `${root} is your best instrument` : `${root} is bleeding you`,
    detail: better
      ? `${root} wins ${pct(c.meanA)} (${fmtSignedUsd(net)} across ${c.nA} decided) vs ${pct(c.meanB)} on everything else.`
      : `${root} wins just ${pct(c.meanA)} (${fmtSignedUsd(net)} across ${c.nA} decided) vs ${pct(c.meanB)} elsewhere.`,
    footnote: footN(c.nA, c.nB), tone: better ? 'good' : 'bad', score: c.score,
  }
}

/** 3. Direction — long vs short win rate. */
const direction: Builder = trades => {
  const longs = trades.filter(t => t.direction === 'long')
  const shorts = trades.filter(t => t.direction === 'short')
  const c = contrastProportion(winFlags(longs), winFlags(shorts))
  if (!c?.passes) return null
  const longBetter = c.effect > 0
  const winSide = longBetter ? 'long' : 'short'
  const loseSide = longBetter ? 'short' : 'long'
  const pWin = longBetter ? c.meanA : c.meanB
  const pLose = longBetter ? c.meanB : c.meanA
  return {
    key: 'direction', dimension: 'Direction',
    headline: `Your ${winSide}s work, your ${loseSide}s don't`,
    detail: `${cap(winSide)}s win ${pct(pWin)}; ${loseSide}s win ${pct(pLose)}.`,
    footnote: footN(longBetter ? c.nA : c.nB, longBetter ? c.nB : c.nA), tone: 'neutral', score: c.score,
  }
}

/** 4. Trades-per-day — quiet days vs busy days, on day-level PnL. */
const tradesPerDay: Builder = trades => {
  const days = rollupDays(trades)
  if (days.length < DEFAULT_MIN_N * 2) return null
  const med = median(days.map(d => d.count))
  const low = days.filter(d => d.count < med)
  const high = days.filter(d => d.count >= med)
  const c = contrastContinuous(low.map(d => d.pnl), high.map(d => d.pnl))
  if (!c?.passes) return null
  const fewerBetter = c.effect > 0
  return {
    key: 'trades_per_day', dimension: 'Activity',
    headline: fewerBetter ? 'Fewer trades, better days' : 'You warm up on busy days',
    detail: fewerBetter
      ? `On days with fewer than ${med} trades you average ${fmtSignedUsd(c.meanA)} vs ${fmtSignedUsd(c.meanB)} on busier days.`
      : `On busier days (${med}+ trades) you average ${fmtSignedUsd(c.meanB)} vs ${fmtSignedUsd(c.meanA)} on quieter ones.`,
    footnote: footN(c.nA, c.nB, 'days'), tone: fewerBetter ? 'good' : 'neutral', score: c.score,
  }
}

/** 5. Revenge re-entries — quick re-entry after a loss vs everything else. */
const revengeReentry: Builder = trades => {
  const flagged = new Set<string>()
  const byDay = new Map<string, InsightTrade[]>()
  for (const t of trades) {
    const k = dayKeyOf(t)
    if (!k) continue
    const arr = byDay.get(k) ?? []
    arr.push(t)
    byDay.set(k, arr)
  }
  for (const ts of byDay.values()) {
    for (const id of revengeReentryIds(ts.map(toProxy))) flagged.add(id)
  }
  if (flagged.size === 0) return null
  const re = trades.filter(t => flagged.has(t.id))
  const rest = trades.filter(t => !flagged.has(t.id))
  const c = contrastContinuous(pnlValues(re), pnlValues(rest), RARE_MIN_N)
  if (!c?.passes || c.effect >= 0) return null // only surface when re-entries are WORSE
  return {
    key: 'revenge_reentry', dimension: 'Behavior',
    headline: 'Revenge re-entries cost you',
    detail: `Your quick re-entries after a loss average ${fmtSignedUsd(c.meanA)} vs ${fmtSignedUsd(c.meanB)} on every other trade.`,
    footnote: footN(c.nA, c.nB), tone: 'bad', score: c.score,
  }
}

/** 6. Capture leakage — booking too little of the favorable move offered.
 *  Native trades only (trading_day_id present): imported/historical rows carry a
 *  null symbol → multiplier 1, which puts their capture denominator on a
 *  different unit basis than native trades (the same native-only rule
 *  computeStats uses). Reported as a PERCENTAGE, not an absolute "$ left on the
 *  table" — MFE is the unreachable peak, so summing it across thousands of
 *  trades produces a headline dollar figure that dwarfs real P&L and reads as
 *  broken. The catalog item is "you book X% of the move", and X% is the honest
 *  unit. */
const captureLeakage: Builder = trades => {
  const ratios: number[] = []
  for (const t of trades) {
    if (!t.trading_day_id) continue // native only — see note above
    const c = captureComponents(t as unknown as TradeWithExcursion)
    if (!c) continue
    ratios.push(Math.max(0, c.pnl / c.mfeDollars))
  }
  const c = contrastVsBenchmark(ratios, CAPTURE_BENCHMARK)
  if (!c?.passes || c.effect >= 0) return null // only when BELOW the benchmark
  return {
    key: 'capture_leakage', dimension: 'Exits',
    headline: 'You leave part of the move on the table',
    detail: `You book ${pct(c.meanA)} of the favorable move on average across ${c.nA} trades — earlier partial exits would lift your profit factor.`,
    footnote: `${c.nA} trades with a clean read`, tone: 'bad', score: c.score,
  }
}

/** 7. Hold time — quick exits vs long holds, on win rate. */
const holdTime: Builder = trades => {
  const withHold = trades
    .map(t => {
      if (!t.entry_time || !t.exit_time) return null
      const m = (Date.parse(t.exit_time) - Date.parse(t.entry_time)) / 60000
      return Number.isFinite(m) && m >= 0 ? { t, m } : null
    })
    .filter((x): x is { t: InsightTrade; m: number } => x != null)
  if (withHold.length < DEFAULT_MIN_N * 2) return null
  const med = median(withHold.map(x => x.m))
  const short = withHold.filter(x => x.m < med).map(x => x.t)
  const long = withHold.filter(x => x.m >= med).map(x => x.t)
  const c = contrastProportion(winFlags(short), winFlags(long))
  if (!c?.passes) return null
  // DESCRIPTIVE only — hold time is partly a FUNCTION of the outcome (winners
  // get held, losers get cut, or vice-versa), so "hold longer / cut faster"
  // would be reverse-causality advice. State the pattern, prescribe nothing.
  const shortBetter = c.effect > 0
  const label = fmtDuration(med)
  return {
    key: 'hold_time', dimension: 'Hold time',
    headline: shortBetter ? 'Your quick exits are the winners' : 'Your winners are the ones you hold',
    detail: shortBetter
      ? `Trades you exit under ${label} win ${pct(c.meanA)} vs ${pct(c.meanB)} on longer holds.`
      : `Trades held past ${label} win ${pct(c.meanB)} vs ${pct(c.meanA)} on quicker exits.`,
    footnote: footN(c.nA, c.nB), tone: 'neutral', score: c.score,
  }
}

/** 8. Size vs outcome — biggest-size tercile vs smallest, on win rate. */
const sizeVsOutcome: Builder = trades => {
  const withQty = trades.filter(t => t.quantity != null && t.quantity > 0) as (InsightTrade & { quantity: number })[]
  if (withQty.length < DEFAULT_MIN_N * 3) return null
  const sorted = [...withQty].sort((a, b) => a.quantity - b.quantity)
  const q1 = sorted[Math.floor(sorted.length / 3)].quantity
  const q2 = sorted[Math.floor((2 * sorted.length) / 3)].quantity
  if (q1 === q2) return null // not enough size spread to tercile meaningfully
  const small = sorted.filter(t => t.quantity <= q1)
  const big = sorted.filter(t => t.quantity >= q2)
  const c = contrastProportion(winFlags(big), winFlags(small))
  if (!c?.passes) return null
  const bigBetter = c.effect > 0
  return {
    key: 'size_vs_outcome', dimension: 'Size',
    headline: bigBetter ? 'Your conviction trades win' : "Sizing up isn't paying",
    detail: bigBetter
      ? `Your biggest trades (${q2}+ contracts) win ${pct(c.meanA)} vs ${pct(c.meanB)} on your smaller ones.`
      : `Your biggest trades (${q2}+ contracts) win just ${pct(c.meanA)} vs ${pct(c.meanB)} on your smaller ones.`,
    footnote: footN(c.nA, c.nB), tone: bigBetter ? 'good' : 'bad', score: c.score,
  }
}

/** 9. Prev-outcome — the trade after a loss vs the trade after a win. */
const prevOutcome: Builder = trades => {
  const afterLoss: InsightTrade[] = []
  const afterWin: InsightTrade[] = []
  const byDay = new Map<string, InsightTrade[]>()
  for (const t of trades) {
    const k = dayKeyOf(t)
    if (!k) continue
    const arr = byDay.get(k) ?? []
    arr.push(t)
    byDay.set(k, arr)
  }
  for (const ts of byDay.values()) {
    const ordered = [...ts].sort((a, b) => cmpTime(a, b))
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1].pnl
      if (prev == null || prev === 0) continue
      ;(prev < 0 ? afterLoss : afterWin).push(ordered[i])
    }
  }
  const c = contrastProportion(winFlags(afterLoss), winFlags(afterWin))
  if (!c?.passes) return null
  const afterLossWorse = c.effect < 0
  return {
    key: 'prev_outcome', dimension: 'Behavior',
    headline: afterLossWorse ? 'You trade worse after a loss' : 'You bounce back well after a loss',
    detail: `After a loss you win ${pct(c.meanA)}; after a win ${pct(c.meanB)}.`,
    footnote: footN(c.nA, c.nB), tone: afterLossWorse ? 'bad' : 'good', score: c.score,
  }
}

/** 10. Day-of-week — the most extreme weekday vs the rest, on day-level PnL. */
const dayOfWeek: Builder = trades => {
  const days = rollupDays(trades).filter(d => d.weekday)
  if (days.length < DEFAULT_MIN_N * 2) return null
  const weekdays = Array.from(new Set(days.map(d => d.weekday as string)))
  let best: { c: Contrast; weekday: string } | null = null
  for (const wd of weekdays) {
    const inWd = days.filter(d => d.weekday === wd).map(d => d.pnl)
    const rest = days.filter(d => d.weekday !== wd).map(d => d.pnl)
    const c = contrastContinuous(inWd, rest)
    if (c?.passes && (!best || c.score > best.c.score)) best = { c, weekday: wd }
  }
  if (!best) return null
  const { c, weekday } = best
  const better = c.effect > 0
  return {
    key: 'day_of_week', dimension: 'Weekday',
    headline: better ? `${weekday}s are your money day` : `${weekday}s are your worst day`,
    detail: `${weekday}s average ${fmtSignedUsd(c.meanA)} vs ${fmtSignedUsd(c.meanB)} the rest of the week.`,
    footnote: footN(c.nA, c.nB, 'days'), tone: better ? 'good' : 'bad', score: c.score,
  }
}

const BUILDERS: Builder[] = [
  timeOfDay, instrument, direction, tradesPerDay, revengeReentry,
  captureLeakage, holdTime, sizeVsOutcome, prevOutcome, dayOfWeek,
]

/**
 * Compute the gated, ranked tag-free insights for a set of trades. Each
 * dimension emits at most one candidate; only those clearing the significance +
 * min-sample bar survive; the survivors are sorted by score (effect ×
 * confidence) descending. Pass `limit` to cap (card = 3, analytics = 5); omit
 * to get every survivor.
 */
export function computeInsights(trades: InsightTrade[], opts?: { limit?: number }): RankedInsight[] {
  const out: RankedInsight[] = []
  for (const build of BUILDERS) {
    try {
      const r = build(trades)
      if (r) out.push(r)
    } catch { /* a bad row in one dimension never sinks the rest */ }
  }
  out.sort((a, b) => b.score - a.score)
  return opts?.limit != null ? out.slice(0, opts.limit) : out
}

// ── small helpers ────────────────────────────────────────────────────────────
function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}
function cmpTime(a: InsightTrade, b: InsightTrade): number {
  const ta = a.entry_time ? Date.parse(a.entry_time) : Infinity
  const tb = b.entry_time ? Date.parse(b.entry_time) : Infinity
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
function fmtDuration(min: number): string {
  if (min < 1) return `${Math.round(min * 60)}s`
  if (min < 60) return `${min < 10 ? min.toFixed(1) : Math.round(min)}m`
  return `${(min / 60).toFixed(1)}h`
}
/** Narrow an InsightTrade to the ProxyTrade shape revengeReentryIds wants. */
function toProxy(t: InsightTrade) {
  return {
    id: t.id, direction: t.direction, entry_time: t.entry_time,
    exit_time: t.exit_time, pnl: t.pnl, quantity: t.quantity,
  }
}
