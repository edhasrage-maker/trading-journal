// The deep-dive REGISTRY — one place that knows which investigations can run on
// a given trade book, runs them, and serves the two trigger paths:
//
//   1. PROACTIVE  — rank findings by severity into the coach's opener, so the
//                   trader is handed their biggest leak without asking.
//   2. ON-ASK     — match a natural question ("is scaling out working?") to the
//                   dive that answers it, and hand the model the DETERMINISTIC
//                   numbers to narrate. The model never computes; it reads.
//
// PURE: rows in → results out. The caller does the query (see gather.ts), which
// keeps every analyzer and the registry itself unit-testable.
//
// Cold-start behaviour is the point: a brand-new broker CSV with zero tags runs
// every dive whose inputs are present, and dives whose data is missing return
// null instead of a hedged guess.

import { analyzeTiltCascade, type TiltTrade } from './tilt-cascade'
import { analyzeScaleOutEv, type ScaleOutTrade } from './scale-out-ev'
import { analyzeTimeOfDay, type TimeOfDayTrade } from './time-of-day'
import type { ExitFill } from './exit-events'
import type { DeepDiveResult } from './types'
// Type-only: dives render into the same "what your data already says" list as
// the contrast engine, but the two libs stay decoupled at runtime.
import type { RankedInsight } from '@/lib/data-insights'

/** The lean trade row every server-side dive reads. One query feeds them all. */
export interface DiveRow {
  id: string
  entry_time: string | null
  direction: 'long' | 'short' | null
  entry_price: number | null
  quantity: number | null
  pnl: number | null
  symbol: string | null
  high_during_position: number | null
  low_during_position: number | null
  entry_atr_1m: number | null
  exits_json: ExitFill[] | null
}

export interface DiveOptions {
  /** Trader's session timezone for the clock dive. PT is the house default. */
  timeZone?: string
}

/** How a dive presents itself in the "what your data already says" list, whose
 *  voice is a short CLAIM followed by the numbers. The dive's own headline is
 *  the numbers, so each dive supplies the claim — one for a finding that costs
 *  money, one for a clean read. */
interface InsightCopy {
  /** Eyebrow, matching the contrast engine's dimension labels. */
  dimension: string
  /** Claim when the dive found something worth fixing. No trailing period. */
  leak: string
  /** Claim when it didn't. */
  ok: string
  /** Tone for the clean read — 'good' is a genuine all-clear, 'neutral' is
   *  "nothing separated itself", which is not the same thing. */
  okTone: 'good' | 'neutral'
  /** Noun for the footnote sample count ("205 scale-outs"). */
  sampleUnit: string
  /** Contrast-engine insight keys this dive supersedes, so the list never runs
   *  two reads of the same subject side by side. */
  supersedes: string[]
}

interface DiveRunner {
  id: string
  title: string
  /** Natural-language triggers for on-ask routing. */
  keywords: string[]
  /** What gets sent to the coach when the trader clicks the opener topic. Phrased
   *  so it ALSO matches this dive's own keywords — clicking routes back here. */
  followUp: string
  insight: InsightCopy
  run(rows: DiveRow[], opts: DiveOptions): DeepDiveResult | null
}

const dayOf = (iso: string | null): string => (iso ?? '').slice(0, 10)

export const SERVER_DIVES: DiveRunner[] = [
  {
    id: 'tilt-cascade',
    title: 'The tilt cascade',
    keywords: ['tilt', 'revenge', 'after a loss', 'losing streak', 'consecutive losses', 'chasing', 'on tilt'],
    followUp: 'Walk me through my tilt cascade after consecutive losses — what does the data say?',
    insight: {
      dimension: 'Tilt', okTone: 'good', sampleUnit: 'trades',
      leak: 'A losing streak turns you into a different trader',
      ok: "Losing streaks don't knock you off your game",
      // 'prev_outcome' is the contrast engine's after-a-win/after-a-loss read —
      // the same subject, one layer shallower.
      supersedes: ['prev_outcome'],
    },
    run: rows => analyzeTiltCascade(rows
      .filter(r => r.entry_time)
      .map((r): TiltTrade => ({ day: dayOf(r.entry_time), entryTime: r.entry_time!, pnl: r.pnl, quantity: r.quantity }))),
  },
  {
    id: 'scale-out-ev',
    title: 'Is scaling out paying you?',
    keywords: ['scale out', 'scaling', 'partials', 'runner', 'tp1', 'first target', 'take profit', 'let it run', 'trim'],
    followUp: 'Is scaling out actually paying me, or should I take the full size at my first target?',
    insight: {
      dimension: 'Exits', okTone: 'good', sampleUnit: 'scale-outs',
      leak: 'Your runners cost more than they pay',
      ok: 'Your scale-out is earning its keep',
      // Supersede the capture read: on its own "you keep 39% of the move" reads
      // as "hold longer", which is the OPPOSITE of what the EV math says when
      // the runner is the leak. One read of the exit, not two that fight.
      supersedes: ['capture_efficiency'],
    },
    run: rows => analyzeScaleOutEv(rows.map((r): ScaleOutTrade => ({
      id: r.id,
      direction: r.direction,
      entryPrice: r.entry_price,
      symbol: r.symbol,
      fills: Array.isArray(r.exits_json) ? r.exits_json : null,
      // The favorable extreme is direction-relative: a long's best price is the
      // high, a short's is the low.
      favorableExtreme: r.direction === 'long' ? r.high_during_position : r.low_during_position,
      atrPts: r.entry_atr_1m,
    }))),
  },
  {
    id: 'time-of-day',
    title: 'Your session clock',
    keywords: ['time of day', 'session', 'morning', 'afternoon', 'open', 'lunch', 'power hour', 'what time', 'which hour', 'too early', 'too late'],
    followUp: 'What does my session clock say — is there a time of day I should stop trading?',
    insight: {
      dimension: 'Session clock', okTone: 'neutral', sampleUnit: 'trades',
      leak: 'Part of your trading day is pure tuition',
      ok: 'No part of your session stands out as the problem',
      supersedes: ['time_of_day'],
    },
    run: (rows, opts) => analyzeTimeOfDay(
      rows.map((r): TimeOfDayTrade => ({ entryTime: r.entry_time, pnl: r.pnl })),
      { timeZone: opts.timeZone },
    ),
  },
]

/**
 * Dives that exist and are tested but have NO server-side data path yet, so the
 * registry can't run them. Listed rather than silently absent — a dive that is
 * unavailable for a data reason is a fact about the account, not a missing
 * feature, and the reason belongs somewhere a human will read it.
 */
export const UNAVAILABLE_DIVES: { id: string; title: string; reason: string }[] = [
  {
    id: 'stopped-reversal',
    title: 'Stopped, then reversed',
    reason: 'needs the ORDERED post-exit path (worst heat before the snap-back). No column holds it — trades.post_exit_* are two independent 30-min maxima — so it is measured off SCID ticks locally via scripts/dive-stop-reversal-ticks.ts until a migration persists the path fields.',
  },
]

/** Run every available dive and return the findings, strongest first. */
export function runDives(rows: DiveRow[], opts: DiveOptions = {}): DeepDiveResult[] {
  const out: DeepDiveResult[] = []
  for (const dive of SERVER_DIVES) {
    let result: DeepDiveResult | null = null
    // One dive throwing must never take the whole opener down with it.
    try { result = dive.run(rows, opts) } catch { result = null }
    if (result) out.push(result)
  }
  return out.sort((a, b) => b.severity - a.severity)
}

/** Opener topic for a finding — same {id,line,followUp} shape the coach's
 *  existing suggestion list renders, so a dive needs no new UI. */
export function diveSuggestions(results: DeepDiveResult[]): { id: string; line: string; followUp: string; score: number }[] {
  return results.map(r => ({
    id: `dive:${r.id}`,
    line: r.headline,
    followUp: SERVER_DIVES.find(d => d.id === r.id)?.followUp
      ?? `Dig into "${r.title}" — show me the breakdown.`,
    score: r.severity,
  }))
}

/** Normalize any trade-ish row set (the first-read teaser rows, the analytics
 *  rows) into DiveRows, so a call site that already fetched trades doesn't need
 *  a second query just to run the dives. */
export function toDiveRows(rows: (Partial<DiveRow> & { id: string })[]): DiveRow[] {
  return rows.map(r => ({
    id: r.id,
    entry_time: r.entry_time ?? null,
    direction: r.direction ?? null,
    entry_price: r.entry_price ?? null,
    quantity: r.quantity ?? null,
    pnl: r.pnl ?? null,
    symbol: r.symbol ?? null,
    high_during_position: r.high_during_position ?? null,
    low_during_position: r.low_during_position ?? null,
    entry_atr_1m: r.entry_atr_1m ?? null,
    exits_json: Array.isArray(r.exits_json) ? r.exits_json : null,
  }))
}

/** At most this many of the list's slots go to dives, so the block keeps at
 *  least one classic contrast when both kinds have something to say. */
const MAX_DIVE_INSIGHTS = 2

/**
 * Render findings in the voice of the "what your data already says" list: a
 * short claim, then the dive's own headline as the number-carrying detail.
 */
export function diveInsights(results: DeepDiveResult[]): RankedInsight[] {
  const out: RankedInsight[] = []
  for (const r of results) {
    const dive = SERVER_DIVES.find(d => d.id === r.id)
    if (!dive) continue
    const { insight } = dive
    // A dive that proposes a test found something that costs money; one that
    // doesn't looked and found nothing to fix.
    const isLeak = r.test != null && r.test.impactUsd > 0
    const sample = r.segments.reduce((m, s) => Math.max(m, s.n ?? 0), 0)
    out.push({
      key: `dive_${r.id.replace(/-/g, '_')}`,
      dimension: insight.dimension,
      headline: isLeak ? insight.leak : insight.ok,
      detail: r.headline,
      footnote: sample > 0 ? `${sample.toLocaleString('en-US')} ${insight.sampleUnit}` : '',
      tone: isLeak ? 'bad' : insight.okTone,
      score: r.severity,
    })
  }
  return out
}

/**
 * Merge dive findings into the contrast-engine list: drop any insight a dive
 * supersedes, rank everything together on score, and cap the dive share so the
 * list doesn't become all dives.
 */
export function mergeDiveInsights(
  insights: RankedInsight[],
  results: DeepDiveResult[],
  limit: number,
): RankedInsight[] {
  const dives = diveInsights(results)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DIVE_INSIGHTS)
  const superseded = new Set(
    dives.flatMap(d => SERVER_DIVES.find(s => `dive_${s.id.replace(/-/g, '_')}` === d.key)?.insight.supersedes ?? []),
  )
  return [...insights.filter(i => !superseded.has(i.key)), ...dives]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Route a free-text question to the dives that answer it. Matching is on whole
 * words/phrases so "open" doesn't fire on "opened a position" — and a query can
 * legitimately hit more than one dive ("do I revenge trade in the afternoon?").
 */
export function matchDiveIds(query: string): string[] {
  const q = ` ${query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `
  const hits: string[] = []
  for (const dive of SERVER_DIVES) {
    if (dive.keywords.some(k => q.includes(` ${k} `))) hits.push(dive.id)
  }
  return hits
}

/**
 * Render a finding as a deterministic block for the model to NARRATE. Every
 * number here was computed from the trader's fills; the instruction is explicit
 * that these are the only figures it may quote for this dive, because the whole
 * trust argument is that the coach reads real analysis rather than inventing it.
 */
export function formatDiveForPrompt(r: DeepDiveResult): string {
  const lines: string[] = [
    `### DEEP DIVE: ${r.title}`,
    `FINDING: ${r.headline}`,
    'BREAKDOWN:',
    ...r.segments.map(s => {
      const bits = [`  - ${s.label}: ${s.value}`]
      if (s.n != null) bits.push(`n=${s.n}`)
      if (s.pnl != null) bits.push(`P&L=${s.pnl}`)
      if (s.extra) bits.push(Object.entries(s.extra).map(([k, v]) => `${k}=${v}`).join(' '))
      return bits.join('  ')
    }),
    'DETAIL:',
    ...r.detail.map(d => `  - ${d}`),
  ]
  if (r.reframe) lines.push(`REFRAME: ${r.reframe}`)
  if (r.test) {
    lines.push(
      `PROPOSED TEST: ${r.test.rule}`,
      `  modelled impact: ${r.test.impactUsd >= 0 ? '+' : '−'}$${Math.abs(Math.round(r.test.impactUsd)).toLocaleString('en-US')}`,
      `  basis: ${r.test.basis}`,
    )
  }
  return lines.join('\n')
}

/** The per-turn system block injected when a question routes to a dive. */
export function diveContextBlock(results: DeepDiveResult[]): string {
  if (!results.length) return ''
  return `

The trader's question matches a deep-dive investigation that has ALREADY BEEN COMPUTED from their own fills. Narrate the finding below — lead with it, quote its numbers EXACTLY as given, and walk them through the breakdown. Do NOT recompute, re-estimate, or substitute numbers from the general context block; if something isn't in this block, say you don't have it. End on the proposed test, framed as something they can try and measure.

${results.map(formatDiveForPrompt).join('\n\n')}`
}
