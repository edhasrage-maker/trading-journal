/**
 * The Review → Prep carryover — the engine behind the Prep bridge.
 *
 * The bridge is the approved centrepiece of the Prep redesign (Pt 13 R2.1):
 * Review diagnoses, Prep prescribes. It takes what the trader's own recent
 * sessions actually showed and turns it into ONE commitment for today, which
 * they can track and resolve at review time.
 *
 * Two hard rules from the design lock, both enforced here:
 *
 *   1. FACTS, NOT CAUSAL STORIES. Every sentence is a measured comparison
 *      ("X averaged +0.9R, everything else +0.1R"). We never claim one caused
 *      the other. Numbers come from the trader's data; the prose is fixed
 *      copy around them, so the seam stays visible.
 *
 *   2. REFUSE TO MANUFACTURE A FINDING. If nothing separates itself at a
 *      defensible sample size, this returns null and the bridge renders its
 *      honest "no read yet" state. Not every month has a lesson — inventing
 *      one is the mistake.
 *
 * Everything is normalised to R (risk multiples) so candidates from different
 * families are comparable, and so the numbers mean the same thing whether the
 * trader is on MNQ or ES.
 */

import {
  rMultiple,
  aggregateByTag,
  avgCaptureRatio,
  avgMaeHeatRatio,
  type TradeLike,
  type TradeWithExcursion,
  type TradeWithContext,
} from './analytics'
import type { TradeTags } from './supabase/types'
import { deriveEntryFeatures, ENTRY_FEATURES, type EntryFeatures, type FeatureDef } from './derived-features'

// ── Thresholds ──────────────────────────────────────────────────────────────
// Deliberately conservative: a wrong "finding" that a trader acts on for a
// session is far more costly than showing nothing for another week.

/** Minimum trades with a computable R on BOTH sides of a comparison. */
const MIN_N = 10
/** Minimum trades carrying a mistake/emotion tag before we'll call it out. */
const MIN_TAG_N = 8
/** Minimum R-per-trade gap vs the rest of the book to count as separation. */
const MIN_GAP_R = 0.35
/** Minimum trades with a computable capture/heat ratio for those findings. */
const MIN_RATIO_N = 12
/** Minimum trades on BOTH arms of a tag x feature split. Lower than MIN_N
 *  because a conjunction is inherently a smaller slice, but still enough that
 *  one bad session can't create the finding. */
const MIN_CONJ_N = 10
/** Setup labels that are residual buckets rather than real setups. "This trade
 *  wasn't one of my named setups" underperforming the named ones is close to
 *  definitional, and "skip the discretionary trade unless it's textbook" is not
 *  an instruction anyone can follow. They can still appear, but they have to
 *  out-separate a real finding by a wide margin to do it. */
const RESIDUAL_SETUPS = /^(discretionary|other|misc|random|scalp)/i
const RESIDUAL_PENALTY = 0.5

/** Capture below this (fraction of the offered move kept) is a real leak. */
const CAPTURE_FLOOR = 0.5
/** Average MAE above this share of planned risk is a real leak. */
const HEAT_CEILING = 0.85
/** Below this many scored trades in the window, we don't read anything at all. */
const MIN_WINDOW_N = 20

export type CarryoverMode = 'protect' | 'correct'

/** One comparison bar for the Review evidence rail — a labelled R-per-trade
 *  value with its sample count. `pct` is the bar length relative to the row's
 *  strongest reading; `tone` colours it (pos green / neg red / acc neutral). */
export interface EvidenceBar {
  label: string
  /** Formatted R, e.g. "+0.9R". */
  value: string
  n: number
  /** 0-100 bar length. */
  pct: number
  tone: 'pos' | 'neg' | 'acc'
}

export interface Carryover {
  /** 'protect' = an edge worth keeping; 'correct' = a leak worth avoiding.
   *  The bridge is NOT always a mistake import — protecting what works is
   *  half the point (founder, R2.1). */
  mode: CarryoverMode
  /** Rendered as "From your {source}", e.g. "July review". */
  source: string
  /** The measured fact, without the number. */
  finding: string
  /** The number itself, emphasised in the UI and never editorialised. */
  metric: string
  /** The single commitment for today. */
  today: string
  /** Stable identity so a tracked commitment can be matched back at review
   *  time even if the numbers move. */
  key: string
  /** Trades behind the finding — shown as provenance. */
  n: number
  /** The two-sided comparison behind the finding, for the Review evidence rail.
   *  Empty for tier-2 execution findings that have no comparison group. */
  evidence: EvidenceBar[]
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Mean R across trades that have a computable R. */
function avgR(trades: TradeLike[]): { avg: number | null; n: number } {
  let sum = 0
  let n = 0
  for (const t of trades) {
    const r = rMultiple(t)
    if (r != null && Number.isFinite(r)) { sum += r; n++ }
  }
  return { avg: n > 0 ? sum / n : null, n }
}

function labelsOf(t: TradeLike, category: keyof TradeTags): string[] {
  const tags = t.tags_json as TradeTags | null
  const arr = tags ? (tags[category] as string[] | undefined) : undefined
  return Array.isArray(arr) ? arr.map(l => l.trim()).filter(Boolean) : []
}

/** "+0.9R" / "−0.4R" — always signed, one decimal, real minus sign. */
function fmtR(r: number): string {
  const s = r < 0 ? '−' : '+'
  return `${s}${Math.abs(r).toFixed(1)}R`
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`
}

/** Two comparison bars for the Review evidence rail, scaled to the larger
 *  magnitude so the stronger reading fills the track. */
function twoBar(aLabel: string, aR: number, aN: number, bLabel: string, bR: number, bN: number): EvidenceBar[] {
  const max = Math.max(Math.abs(aR), Math.abs(bR)) || 1
  const bar = (label: string, r: number, n: number): EvidenceBar => ({
    label,
    value: fmtR(r),
    n,
    pct: Math.round((Math.abs(r) / max) * 100),
    tone: r > 0 ? 'pos' : r < 0 ? 'neg' : 'acc',
  })
  return [bar(aLabel, aR, aN), bar(bLabel, bR, bN)]
}

/** Split a set of trades by whether they carry `label` in `category`. */
function splitByLabel(
  trades: TradeLike[],
  category: keyof TradeTags,
  label: string,
): { withLabel: TradeLike[]; without: TradeLike[] } {
  const withLabel: TradeLike[] = []
  const without: TradeLike[] = []
  for (const t of trades) {
    if (labelsOf(t, category).includes(label)) withLabel.push(t)
    else without.push(t)
  }
  return { withLabel, without }
}

// ── Candidate findings ──────────────────────────────────────────────────────
// Each candidate carries an `effect` (absolute R gap, or an R-equivalent) and a
// `tier`. Tier 1 = a direct like-for-like comparison inside the book, which is
// the strongest evidence we can produce. Tier 2 = a single-sided execution
// ratio with no comparison group, so it only wins when tier 1 is empty.

interface Candidate extends Carryover {
  tier: 1 | 2
  /** The finding's size, in R. This is what the copy talks about. */
  effect: number
  /** What the ranking actually sorts on: the effect discounted by how thin the
   *  smaller arm is. Ranking on raw effect alone hands the win to the smallest
   *  slice every time — an 8-vs-8 split showing a 1.2R gap outranked a 28-vs-14
   *  split showing 0.86R, and the second is far likelier to still be true next
   *  month. sqrt(min n) is the standard shape of a standard error and needs no
   *  distributional assumption. */
  weight: number
}

/** Effect discounted by the thinner arm of the comparison. */
function weigh(effect: number, ...arms: number[]): number {
  return effect * Math.sqrt(Math.max(1, Math.min(...arms)))
}

/** Setup-level separation, in both directions. The comparison is always
 *  "this setup vs everything else you traded", never against a benchmark the
 *  trader has no relationship with. */
function setupCandidates(trades: TradeLike[], source: string): Candidate[] {
  const out: Candidate[] = []
  const labels = aggregateByTag(trades, 'setups').map(p => p.label)

  for (const label of labels) {
    const { withLabel, without } = splitByLabel(trades, 'setups', label)
    const a = avgR(withLabel)
    const b = avgR(without)
    if (a.avg == null || b.avg == null) continue
    if (a.n < MIN_N || b.n < MIN_N) continue

    const gap = a.avg - b.avg
    if (Math.abs(gap) < MIN_GAP_R) continue

    if (gap > 0 && a.avg > 0) {
      out.push({
        tier: 1,
        effect: Math.abs(gap),
        weight: weigh(Math.abs(gap), a.n, b.n),
        mode: 'protect',
        source,
        key: `setup:${label}`,
        n: a.n,
        finding: `${label} was your best setup`,
        metric: `${fmtR(a.avg)} per trade across ${a.n} trades · everything else ${fmtR(b.avg)}`,
        today: `Protect it — take the ${label} and let the marginal ones go.`,
        evidence: twoBar(label, a.avg, a.n, 'Other setups', b.avg, b.n),
      })
    } else if (gap < 0 && a.avg < 0) {
      out.push({
        tier: 1,
        effect: Math.abs(gap),
        weight: weigh(Math.abs(gap), a.n, b.n),
        mode: 'correct',
        source,
        key: `setup:${label}`,
        n: a.n,
        finding: `${label} cost you`,
        metric: `${fmtR(a.avg)} per trade across ${a.n} trades · everything else ${fmtR(b.avg)}`,
        today: `Skip the ${label} unless it is textbook.`,
        evidence: twoBar(label, a.avg, a.n, 'Other setups', b.avg, b.n),
      })
    }
  }
  return out
}

// ── Mistake/emotion concentration ───────────────────────────────────────────
// The old shape of this family — `Trades tagged "FOMO" went worse` — was a
// tautology (founder, 2026-07-29): the trader authored the tag, usually
// BECAUSE the trade went badly, so the tag-vs-rest gap restates their own
// judgment and (being outcome-contaminated) out-ranks every genuinely
// informative finding on effect size. A mistake tag is only worth the hero
// when we can say WHERE it concentrates — a condition the trader can actually
// gate on. No concentration ⇒ no candidate at all.

/** A concentration must cover this share of the tagged trades... */
const TAG_CONC_MIN_SHARE = 0.6
/** ...and be at least this multiple of the condition's base rate across the
 *  whole window (the anti-tautology test — "first two trades" means nothing
 *  if 60% of ALL trading is the first two trades). */
const TAG_CONC_MIN_LIFT = 1.5
/** "Re-entered within N minutes of a losing exit" window, also quoted in the
 *  suggested cooldown. */
const AFTER_LOSS_WINDOW_MIN = 15

/** Callers pass full trade rows; exit_time isn't part of TradeLike but is
 *  needed for the after-loss trigger, so read it structurally when present. */
type SequencedTrade = TradeLike & { exit_time?: string | null }

const PT_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit',
})
function ptHour(iso: string): number | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const h = Number(PT_HOUR_FMT.format(new Date(ms)))
  return Number.isFinite(h) ? h : null
}

interface TradeFeatures {
  /** Trade #1 or #2 of its trading day (by entry_time order). */
  firstTwo: boolean
  /** Entered within AFTER_LOSS_WINDOW_MIN of the previous trade's LOSING exit. */
  afterLoss: boolean
  /** PT hour of entry, for the clustering dimension. */
  hour: number | null
}

/** Per-trade deterministic features for the concentration dimensions. Only
 *  trades with a parseable entry_time get features (and only those count in
 *  the base rates, so numerator and denominator stay consistent). */
function computeFeatures(trades: SequencedTrade[]): Map<string, TradeFeatures> {
  const out = new Map<string, TradeFeatures>()
  const byDay = new Map<string, SequencedTrade[]>()
  for (const t of trades) {
    if (!t.entry_time || !Number.isFinite(Date.parse(t.entry_time))) continue
    const day = t.trading_day_id ?? t.entry_time.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day)!.push(t)
  }
  for (const dayTrades of byDay.values()) {
    dayTrades.sort((x, y) => Date.parse(x.entry_time!) - Date.parse(y.entry_time!))
    for (let i = 0; i < dayTrades.length; i++) {
      const t = dayTrades[i]
      const prev = i > 0 ? dayTrades[i - 1] : null
      let afterLoss = false
      if (prev && prev.pnl != null && prev.pnl < 0 && prev.exit_time) {
        const gapMs = Date.parse(t.entry_time!) - Date.parse(prev.exit_time)
        afterLoss = Number.isFinite(gapMs) && gapMs >= 0 && gapMs <= AFTER_LOSS_WINDOW_MIN * 60_000
      }
      out.set(t.id, { firstTwo: i < 2, afterLoss, hour: ptHour(t.entry_time!) })
    }
  }
  return out
}

/** Self-tagged mistakes and emotional states, surfaced ONLY where the tag
 *  concentrates in a gateable condition (sequence, cooldown, clock). The
 *  labels stay the trader's own; the numbers stay measured facts. */
function taggedCostCandidates(trades: SequencedTrade[], source: string): Candidate[] {
  const out: Candidate[] = []
  const features = computeFeatures(trades)
  const featured = trades.filter(t => features.has(t.id))
  if (featured.length === 0) return out

  const baseFirstTwo = featured.filter(t => features.get(t.id)!.firstTwo).length / featured.length
  const baseAfterLoss = featured.filter(t => features.get(t.id)!.afterLoss).length / featured.length
  const hourCounts = new Map<number, number>()
  for (const t of featured) {
    const h = features.get(t.id)!.hour
    if (h != null) hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1)
  }

  for (const category of ['mistakes', 'emotions'] as const) {
    const seen = new Set<string>()
    for (const t of trades) for (const l of labelsOf(t, category)) seen.add(l)

    for (const label of seen) {
      const { withLabel, without } = splitByLabel(trades, category, label)
      const a = avgR(withLabel)
      const b = avgR(without)
      if (a.avg == null || b.avg == null) continue
      if (a.n < MIN_TAG_N || b.n < MIN_N) continue
      const gap = a.avg - b.avg
      if (gap > -MIN_GAP_R) continue

      const tagged = withLabel.filter(t => features.has(t.id))
      if (tagged.length < MIN_TAG_N) continue
      const n = tagged.length

      // Evaluate every dimension that passes share + lift; keep the highest
      // lift (the most concentrated, least "well, that's just when you trade").
      interface Conc { lift: number; finding: string; metric: string; today: string }
      const passing: Conc[] = []
      const rComparison = `tagged ${fmtR(a.avg)}, the rest ${fmtR(b.avg)}`

      const kLoss = tagged.filter(t => features.get(t.id)!.afterLoss).length
      const shareLoss = kLoss / n
      if (shareLoss >= TAG_CONC_MIN_SHARE && baseAfterLoss > 0 && shareLoss / baseAfterLoss >= TAG_CONC_MIN_LIFT) {
        passing.push({
          lift: shareLoss / baseAfterLoss,
          finding: `"${label}" follows a loss`,
          metric: `${kLoss} of ${n} tagged entries came within ${AFTER_LOSS_WINDOW_MIN} min of a losing exit · ${fmtPct(baseAfterLoss)} of all trades do · ${rComparison}`,
          today: `Consider a ${AFTER_LOSS_WINDOW_MIN}-minute cooldown after any losing exit — that is where "${label}" lands.`,
        })
      }

      const kFirst = tagged.filter(t => features.get(t.id)!.firstTwo).length
      const shareFirst = kFirst / n
      if (shareFirst >= TAG_CONC_MIN_SHARE && baseFirstTwo > 0 && shareFirst / baseFirstTwo >= TAG_CONC_MIN_LIFT) {
        passing.push({
          lift: shareFirst / baseFirstTwo,
          finding: `"${label}" shows up in your first two trades of the day`,
          metric: `${kFirst} of ${n} tagged entries were trade #1 or #2 · that slot is ${fmtPct(baseFirstTwo)} of your book · ${rComparison}`,
          today: `Slow the first two entries — plan trade #1 before the open and let it come to you.`,
        })
      }

      let bestHour: { h: number; k: number } | null = null
      for (const t of tagged) {
        const h = features.get(t.id)!.hour
        if (h == null) continue
        const k = tagged.filter(x => features.get(x.id)!.hour === h).length
        if (!bestHour || k > bestHour.k) bestHour = { h, k }
      }
      if (bestHour) {
        const shareHour = bestHour.k / n
        const baseHour = (hourCounts.get(bestHour.h) ?? 0) / featured.length
        if (shareHour >= TAG_CONC_MIN_SHARE && baseHour > 0 && shareHour / baseHour >= TAG_CONC_MIN_LIFT) {
          const hourLabel = `${bestHour.h}:00–${bestHour.h + 1}:00 PT`
          passing.push({
            lift: shareHour / baseHour,
            finding: `"${label}" clusters in the ${hourLabel} hour`,
            metric: `${bestHour.k} of ${n} tagged entries fired there · that hour is ${fmtPct(baseHour)} of your book · ${rComparison}`,
            today: `Extra caution ${hourLabel} — smaller size or full confirmation before entering there.`,
          })
        }
      }

      if (passing.length === 0) continue // costly tag, but nothing gateable — say nothing
      passing.sort((x, y) => y.lift - x.lift)
      const best = passing[0]

      out.push({
        tier: 1,
        effect: Math.abs(gap),
        weight: weigh(Math.abs(gap), a.n, b.n),
        mode: 'correct',
        source,
        key: `${category}:${label}`,
        n,
        finding: best.finding,
        metric: best.metric,
        today: best.today,
        evidence: twoBar(`Tagged "${label}"`, a.avg, a.n, 'The rest', b.avg, b.n),
      })
    }
  }
  return out
}

/** Execution-quality ratios. No comparison group, so tier 2 — they describe
 *  how the trader handled the moves they got, not which trades to take. */
function executionCandidates(trades: TradeWithExcursion[], source: string): Candidate[] {
  const out: Candidate[] = []

  const capture = avgCaptureRatio(trades)
  if (capture.avg != null && capture.count >= MIN_RATIO_N && capture.avg < CAPTURE_FLOOR) {
    out.push({
      tier: 2,
      effect: CAPTURE_FLOOR - capture.avg,
      weight: weigh(CAPTURE_FLOOR - capture.avg, capture.count),
      mode: 'correct',
      source,
      key: 'exec:capture',
      n: capture.count,
      finding: 'You kept less than half of the move you were offered',
      metric: `${fmtPct(capture.avg)} captured across ${capture.count} trades`,
      today: 'Hold to your planned target before taking anything off.',
      evidence: [],
    })
  }

  const heat = avgMaeHeatRatio(trades)
  if (heat.avg != null && heat.count >= MIN_RATIO_N && heat.avg > HEAT_CEILING) {
    out.push({
      tier: 2,
      effect: heat.avg - HEAT_CEILING,
      weight: weigh(heat.avg - HEAT_CEILING, heat.count),
      mode: 'correct',
      source,
      key: 'exec:heat',
      n: heat.count,
      finding: 'Your average trade sat through most of its planned risk',
      metric: `${fmtPct(heat.avg)} of planned risk across ${heat.count} trades`,
      today: 'Wait for your trigger — do not take the entry early.',
      evidence: [],
    })
  }

  // The mirror of the capture leak: exits that consistently banked the move.
  // Worth protecting, and it keeps the bridge from only ever importing faults.
  if (capture.avg != null && capture.count >= MIN_RATIO_N && capture.avg >= 0.7) {
    out.push({
      tier: 2,
      effect: capture.avg - 0.7,
      weight: weigh(capture.avg - 0.7, capture.count),
      mode: 'protect',
      source,
      key: 'exec:capture-strong',
      n: capture.count,
      finding: 'Your exits banked most of what the market offered',
      metric: `${fmtPct(capture.avg)} captured across ${capture.count} trades`,
      today: 'Keep exiting the way you have been — do not start improvising.',
      evidence: [],
    })
  }

  return out
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Pick the single strongest carryover from a window of trades, or null when
 * nothing separates itself.
 *
 * @param trades  Scored trades from the review window (exclude today's).
 * @param source  Human label for the window, e.g. "July review".
 */

// ── Derived + conjunction candidates ────────────────────────────────────────
// The tags are the trader's own input; these are the patterns they did not
// record. See src/lib/derived-features.ts for why only entry-time features
// qualify.

/** Split a trade list by an entry feature. Trades the feature can't classify
 *  (no timestamps, no ATR, first trade of the day) join neither arm. */
function splitByFeature(
  trades: TradeLike[],
  feats: Map<string, EntryFeatures>,
  def: FeatureDef,
): { on: TradeLike[]; off: TradeLike[] } {
  const on: TradeLike[] = []
  const off: TradeLike[] = []
  for (const t of trades) {
    const f = feats.get(t.id)
    if (!f) continue
    const v = def.test(f)
    if (v === true) on.push(t)
    else if (v === false) off.push(t)
  }
  return { on, off }
}

/** Findings from a derived feature alone — patterns in how the trader entered,
 *  independent of anything they tagged. */
function derivedCandidates(
  trades: TradeLike[],
  feats: Map<string, EntryFeatures>,
  source: string,
): Candidate[] {
  const out: Candidate[] = []
  for (const def of ENTRY_FEATURES) {
    const { on, off } = splitByFeature(trades, feats, def)
    const a = avgR(on)
    const b = avgR(off)
    if (a.avg == null || b.avg == null || a.n < MIN_N || b.n < MIN_N) continue
    const gap = a.avg - b.avg
    if (Math.abs(gap) < MIN_GAP_R) continue

    const costly = gap < 0
    out.push({
      tier: 1,
      effect: Math.abs(gap),
      weight: weigh(Math.abs(gap), a.n, b.n),
      mode: costly ? 'correct' : 'protect',
      source,
      key: `entry:${def.key}`,
      n: a.n,
      finding: costly
        ? `The trades you ${def.phrase} cost you`
        : `The trades you ${def.phrase} carried you`,
      metric: `${fmtR(a.avg)} per trade across ${a.n} · ${def.counterPhrase} ${fmtR(b.avg)} across ${b.n}`,
      today: costly ? def.costlyAction : def.protectAction,
      evidence: twoBar(`You ${def.phrase}`, a.avg, a.n, def.counterPhrase, b.avg, b.n),
    })
  }
  return out
}

/** Tag x feature. The comparison arm is the SAME tag without the feature, which
 *  is what makes these worth reading: it turns "you revenge trade" (which the
 *  trader typed) into "your revenge trades inside five minutes bleed, the later
 *  ones don't" (which they can act on). */
function conjunctionCandidates(
  trades: TradeLike[],
  feats: Map<string, EntryFeatures>,
  source: string,
): Candidate[] {
  const out: Candidate[] = []
  const categories: Array<keyof TradeTags> = ['mistakes', 'emotions', 'setups']

  for (const category of categories) {
    const labels = Array.from(new Set(trades.flatMap(t => labelsOf(t, category))))
    for (const label of labels) {
      const tagged = trades.filter(t => labelsOf(t, category).includes(label))
      if (tagged.length < MIN_CONJ_N * 2) continue

      for (const def of ENTRY_FEATURES) {
        const { on, off } = splitByFeature(tagged, feats, def)
        const a = avgR(on)
        const b = avgR(off)
        if (a.avg == null || b.avg == null) continue
        if (a.n < MIN_CONJ_N || b.n < MIN_CONJ_N) continue
        const gap = a.avg - b.avg
        // A conjunction has to separate harder than a plain finding to earn its
        // extra complexity — it is a smaller slice and an easier place to fool
        // yourself.
        if (Math.abs(gap) < MIN_GAP_R * 1.5) continue

        const costly = gap < 0
        out.push({
          tier: 1,
          effect: Math.abs(gap),
          weight: weigh(Math.abs(gap), a.n, b.n),
          mode: costly ? 'correct' : 'protect',
          source,
          key: `conj:${category}:${label}:${def.key}`,
          n: a.n,
          finding: costly
            ? `It is the ${label} trades you ${def.phrase} that hurt`
            : `Your ${label} trades work when you ${def.phrase}`,
          metric: `${fmtR(a.avg)} across ${a.n} · the other ${label} trades ${fmtR(b.avg)} across ${b.n}`,
          today: costly ? def.costlyAction : def.protectAction,
          evidence: twoBar(`${label} — ${def.phrase}`, a.avg, a.n, `${label} — ${def.counterPhrase}`, b.avg, b.n),
        })
      }
    }
  }
  return out
}

export function computeCarryover(
  trades: TradeWithExcursion[],
  source: string,
): Carryover | null {
  const scored = avgR(trades)
  if (scored.n < MIN_WINDOW_N) return null

  const feats = deriveEntryFeatures(trades)
  const candidates: Candidate[] = [
    ...setupCandidates(trades, source),
    ...taggedCostCandidates(trades, source),
    ...derivedCandidates(trades, feats, source),
    ...conjunctionCandidates(trades, feats, source),
    ...executionCandidates(trades, source),
  ]
  if (candidates.length === 0) return null

  // Residual setup buckets are demoted, not banned — see RESIDUAL_SETUPS.
  for (const c of candidates) {
    if (c.key.startsWith('setup:') && RESIDUAL_SETUPS.test(c.key.slice('setup:'.length))) {
      c.weight *= RESIDUAL_PENALTY
    }
  }

  // Strongest tier first, then largest effect. Ties break toward 'protect' —
  // when an edge and a leak are equally strong, telling a trader what is
  // working is the more actionable instruction.
  candidates.sort((a, b) =>
    a.tier !== b.tier ? a.tier - b.tier
      : b.weight !== a.weight ? b.weight - a.weight
        : a.mode === b.mode ? 0 : a.mode === 'protect' ? -1 : 1,
  )

  const { tier: _tier, effect: _effect, weight: _weight, ...winner } = candidates[0]
  void _tier; void _effect; void _weight
  return winner
}

/**
 * Per-day-type consequence for the Detailed Tape day-type section — turns a
 * descriptive taxonomy into something with a personal stake ("on high-action
 * days you average +0.6R/trade"). Returns null unless the trader has enough
 * scored trades on that day type to say anything honest.
 */
export function dayTypeConsequence(
  trades: TradeWithContext[],
  dayTypes: string[],
): { label: string; avgR: number; n: number } | null {
  if (dayTypes.length === 0) return null

  let best: { label: string; avgR: number; n: number } | null = null
  for (const label of dayTypes) {
    const onType = trades.filter(t => t.day_types.includes(label))
    const a = avgR(onType)
    if (a.avg == null || a.n < MIN_N) continue
    // Surface the day type with the strongest signal either way — that's the
    // one worth knowing about before the open.
    if (!best || Math.abs(a.avg) > Math.abs(best.avgR)) {
      best = { label, avgR: a.avg, n: a.n }
    }
  }
  return best
}

/** Formatted R for display, exported so the UI never re-implements the sign
 *  and precision rules. */
export const formatR = fmtR
