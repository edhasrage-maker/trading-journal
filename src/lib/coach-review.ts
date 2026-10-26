/**
 * Coach Review — Replay Review's read of one trade at the fill, by Claude,
 * from the numbers the page already has (founder-approved mockup, Design
 * canvas row "Coach Review", 2026-10-24). It opens only after the trader's own
 * call is saved, so their read stays their own.
 *
 * BLIND BY CONSTRUCTION. The input is built from a Blind payload only (the
 * server cut at the fill second: buildSnapshot with no display end) plus the
 * trade's two entry-time reads — its entry-rule results (review_json.entry_ctx)
 * and its order-flow Score facts (review_json.score), both read off what had
 * printed before the fill. buildCoachReviewInput refuses anything else and
 * checks every bar and bubble it uses is stamped before the fill. The result,
 * exit, P&L, tags, notes, screenshot, size and the trader's call are not
 * parameters, so none of them can reach the prompt (scripts/test-coach-review.ts).
 *
 * THE HAZARD this product keeps hitting: absent context becomes a confident
 * judgement about the trader. Every kind of claim the prompt allows has the
 * field that would disprove it in the input, or the prompt forbids the claim
 * (canvas board "What it reads, and what it may say"). checkLine then drops
 * any line naming a time the data doesn't have (all of it is before the fill)
 * or a price off the chart.
 *
 * Pure: no I/O. The route (src/app/api/deep-dive/coach-review) reads the rows,
 * builds the Blind payload and calls the model.
 */
import type { DeepDivePayload } from '@/lib/orderflow/server/deep-dive-payload'
import type { EntryRuleConfig, RuleResult } from '@/lib/entry-rules'
import { isEmptyScoringProfile, type ScoringProfile } from '@/lib/scoring-profile'
import type { CoachReviewItem, TradeCoachReview, TradeEntryCtx, TradeFlowScore } from '@/lib/supabase/types'
import { aggregateFrom, atr1m5m, toBars1m, vapPerBar, type Bar1m, type VapRow } from '@/lib/orderflow/bars'
import { emaOnTf, vwap24h, vwapRth } from '@/lib/orderflow/indicators'
import { volumeProfile } from '@/lib/orderflow/profile'
import { footprintStats } from '@/lib/orderflow/footprint'
import { ptClock, ptDate, utcToPtMs } from '@/lib/orderflow/pt-clock'

/** Prompt and input version. A saved review made under another one offers "Ask again". */
export const COACH_REVIEW_VERSION = 'cr-2'

/**
 * What the route reads from review_json beside the Blind trade columns: the
 * call (the gate only — never sent), the saved review, and the two entry-time
 * reads.
 */
export const COACH_REVIEW_EXTRA = 'verdict:review_json->verdict, coach:review_json->coach_review, entry_ctx:review_json->entry_ctx, score:review_json->score'

const M1_LOOKBACK = 90 * 60
const M5_LOOKBACK = 8 * 3600
const BUBBLES_SHOWN = 100
const FP_BARS = 5
/** Footprint and profile rows, in ticks: Replay Review's defaults (replay-settings DEFAULTS.g). */
const ROW_TICKS = { NQ: 4, ES: 1 } as const
const TICK = 0.25
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const KIND_ORDER: CoachReviewItem['kind'][] = ['for', 'against', 'look']

export class CoachReviewInputError extends Error {}

export interface CoachReviewData {
  payload: DeepDivePayload
  /** The trader's profile uses order flow (resolveRubric().usesOrderFlow). Off: no order flow is sent at all. */
  usesOrderFlow: boolean
  /** The trader's entry rules judged at this fill, the ones that count on its date; null = they have none. */
  rules: RuleResult[] | null
  /** The fill's entry snapshot when it is this fill's (entryCtxIsCurrent), else null. */
  entryCtx: TradeEntryCtx | null
  /** The order-flow Score read at this fill (flowScoreIsCurrent), else null. */
  flow: TradeFlowScore | null
  /** The trader's stop rule in × ATR (stopBandOf), or null when they have none in ATR. */
  stopBand: [number, number] | null
}

/**
 * The trader's stop rule as the Score judges it: 0.5× to 1.5× their ATR stop
 * setting (coach-score.ts stop_in_atr_band). The owner's empty profile is the
 * 1× default, so 0.5–1.5× ATR. Null when they set no ATR stop (points, or none).
 */
export function stopBandOf(sp: ScoringProfile | null, atrStopTarget: number): [number, number] | null {
  const atrRule = isEmptyScoringProfile(sp) || (sp?.stop?.mode?.toLowerCase() === 'atr' && typeof sp.stop.value === 'number' && sp.stop.value > 0)
  return atrRule ? [0.5 * atrStopTarget, 1.5 * atrStopTarget] : null
}
const bandWords = (b: [number, number]) => `${+b[0].toFixed(2)} to ${+b[1].toFixed(2)} x the 1m ATR`

export interface CoachReviewInput {
  /** The data block sent to the model. */
  text: string
  /** Every bar and bubble time it holds (PT-clock seconds): all before the fill. */
  times: number[]
  /** The clock labels in `text` ("08:40", "08:40:51"): a line naming any other time is dropped. */
  labels: string[]
  /** The price range on the chart (bars, levels, plan, VWAP / EMAs, bubbles). */
  lo: number
  hi: number
  entryPrice: number
  /** HH:MM:SS PT of the fill, and of the last second the data covers. */
  fill: string
  cutoff: string
  /** What it can't see, in plain words, for the "Couldn't see" line. */
  unseen: string[]
  of: boolean
}

const f2 = (x: number) => x.toFixed(2)
const sgn = (x: number, d = 2) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(d)}`

/** The Blind payload, plus the entry-time reads, as the model's data block. */
export function buildCoachReviewInput(d: CoachReviewData): CoachReviewInput {
  const P = d.payload, S = P.snapshot
  if (!P.blind || !S.cut.blind || P.exits || S.bubbles?.raw) throw new CoachReviewInputError('Coach Review reads the Blind cut only.')
  const entry = S.times.entry
  const fillUtc = Date.parse(S.cut.fill_utc)
  if (Date.parse(S.cut.data_end_utc) > fillUtc || (S.cut.last_tick_utc && Date.parse(S.cut.last_tick_utc) >= fillUtc)) {
    throw new CoachReviewInputError('the data runs to the fill or past it')
  }
  const m1 = toBars1m(S.bars, S.has_partial)
  if (!m1.length) throw new CoachReviewInputError('no bars before the fill')
  // the fill's own minute may only be there as the partial bar, cut before the fill
  for (const b of m1) if (b.partial ? b.t > entry : b.t + 60 > entry) throw new CoachReviewInputError(`the ${ptClock(b.t * 1000)} bar is not before the fill`)
  // A bubble is stamped with the whole second of its last trade, the fill to the millisecond: a bubble that
  // finished earlier in the fill's own second (09:04:10.2 before a fill at 09:04:10.6) is stamped 09:04:10 and
  // is before the fill. Compare against the exact fill instant, not its second.
  const fillPtMs = utcToPtMs(fillUtc)
  const BB = S.bubbles
  if (BB) for (const t of BB.t) if (t * 1000 >= fillPtMs) throw new CoachReviewInputError(`a bubble at ${ptClock(t * 1000)} is not before the fill`)

  const inst = S.row.inst, px = S.row.price, of = d.usesOrderFlow
  const fill = S.row.time, cutoff = S.cutoff_label, fillDate = S.row.date
  const labels = new Set<string>([fill, fill.slice(0, 5), cutoff, cutoff.slice(0, 5)])
  const times: number[] = []
  const clock = (t: number, sec = false) => {
    const ms = t * 1000, c = ptClock(ms), lab = sec ? c : c.slice(0, 5)
    labels.add(lab); times.push(t)
    return ptDate(ms) === fillDate ? lab : `${WEEKDAY[new Date(ms).getUTCDay()]} ${lab}`
  }
  let lo = Infinity, hi = -Infinity
  const seen = (...xs: (number | null | undefined)[]) => { for (const x of xs) if (x != null && Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x } }

  const vap = vapPerBar(S.vap, m1.length)
  const fi = m1.length - 1
  const vw = vwap24h(m1)[fi], rv = vwapRth(m1)[fi], e9 = emaOnTf(m1, 9)[fi], e20 = emaOnTf(m1, 20)[fi]
  const { atr1, atr5 } = atr1m5m(m1, entry)
  const B = S.bracket, atr = B.atr ?? atr1
  const dev = volumeProfile(m1, vap, S.times.profile_anchor, Infinity, ROW_TICKS[inst])
  m1.forEach(b => seen(b.h, b.l))
  seen(B.stop, B.tp, vw, rv, e9, e20, dev?.pocPx, dev?.vahPx, dev?.valPx, ...S.levels.map(l => l.price), ...(BB?.px ?? []))

  const L: string[] = []
  // ---- the trade ----
  L.push('THE TRADE AT THE FILL')
  L.push(`${inst}, ${S.row.direction} at ${f2(px)}, filled ${fill} PT on ${S.row.weekday} ${fillDate}.`)
  L.push(`The data stops at the fill: everything below printed before ${fill} PT. Nothing from the fill on is known.`)
  if (S.times.in_rth) {
    labels.add('06:30'); labels.add('07:30')
    L.push(`Regular session (opened 06:30 PT); the fill is ${Math.round((entry - S.times.rth_open) / 60)} minutes after the open.`
      + (entry < S.times.ib_end ? ' The initial balance (06:30 to 07:30) was still forming.' : ''))
  } else {
    labels.add('06:30'); labels.add('13:00')
    L.push('Outside the regular session (06:30 to 13:00 PT).')
  }

  // ---- the plan ----
  L.push('', 'THE PLAN AT THE FILL')
  const src = (s: 'recorded' | 'assumed') => (s === 'recorded' ? 'recorded by the trader' : 'not recorded: an assumed one')
  if (B.stop != null) {
    const dist = Math.abs(px - B.stop), k = atr ? dist / atr : null, band = d.stopBand
    // where the stop sits against the trader's own stop rule, said here so it is never judged against the bare setting
    const rule = k != null && band
      ? `: ${k < band[0] ? 'tighter than' : k > band[1] ? 'wider than' : 'inside'} their stop rule (${bandWords(band)})`
      : ''
    L.push(`Stop ${f2(B.stop)} (${src(B.stop_src)}), ${f2(dist)} points from entry${k != null ? `, ${k.toFixed(2)} x the 1m ATR${rule}` : ''}.`)
  } else L.push('Stop: none recorded, and no ATR to assume one.')
  if (B.tp != null) {
    const dist = Math.abs(B.tp - px), risk = B.stop != null ? Math.abs(px - B.stop) : null
    L.push(`Target ${f2(B.tp)} (${src(B.tp_src)}), ${f2(dist)} points from entry${risk ? `, ${(dist / risk).toFixed(2)}R` : ''}.`)
  } else L.push('Target: none recorded.')
  L.push(`ATR (points): 1m ${atr != null ? atr.toFixed(2) : 'n/a'}, 5m ${atr5 != null ? atr5.toFixed(2) : 'n/a'}.`)

  // ---- levels, VWAP, EMAs ----
  const near: { name: string; price: number }[] = S.levels.map(l => ({ name: l.name + (l.dev ? ' (still forming)' : ''), price: l.price }))
  if (vw != null) near.push({ name: 'VWAP 24h', price: vw })
  if (rv != null) near.push({ name: 'VWAP RTH', price: rv })
  near.push({ name: '9 EMA (5m)', price: e9 }, { name: '20 EMA (5m)', price: e20 })
  if (dev) near.push({ name: 'session POC so far', price: dev.pocPx }, { name: 'session VAH so far', price: dev.vahPx }, { name: 'session VAL so far', price: dev.valPx })
  near.sort((a, b) => Math.abs(a.price - px) - Math.abs(b.price - px))
  L.push('', 'LEVELS AS OF THE FILL (nearest first: price, points from entry, x 1m ATR)')
  for (const n of near) {
    const dd = n.price - px
    L.push(`${n.name}: ${f2(n.price)}, ${sgn(dd)}${atr ? `, ${(Math.abs(dd) / atr).toFixed(1)} ATR` : ''} ${dd > 0 ? 'above' : dd < 0 ? 'below' : 'at entry'}`)
  }

  // ---- the session so far ----
  if (S.times.in_rth) {
    let h: Bar1m | null = null, l: Bar1m | null = null
    for (const b of m1) if (b.t >= S.times.rth_open) { if (!h || b.h > h.h) h = b; if (!l || b.l < l.l) l = b }
    if (h && l) L.push('', `REGULAR SESSION SO FAR: high ${f2(h.h)} at ${clock(h.t)}, low ${f2(l.l)} at ${clock(l.t)}, range ${f2(h.h - l.l)} points.`)
  }

  // ---- candles ----
  const bar = (b: { t: number; o: number; h: number; l: number; c: number; v: number; d: number; partial: boolean }) =>
    `${clock(b.t)} ${f2(b.o)} ${f2(b.h)} ${f2(b.l)} ${f2(b.c)}, vol ${Math.round(b.v)}${of ? `, delta ${sgn(b.d, 0)}` : ''}${b.partial ? ` (still forming: to ${cutoff})` : ''}`
  const cols = `time open high low close, volume${of ? ', delta (ask minus bid volume)' : ''}`
  const m1Shown = m1.filter(b => b.t >= entry - M1_LOOKBACK)
  L.push('', `1-MINUTE CANDLES, the last 90 minutes (${cols})`)
  for (const b of m1Shown) L.push(bar(b))
  const m5 = aggregateFrom(m1.filter(b => b.t >= entry - M5_LOOKBACK), 5)
  L.push('', `5-MINUTE CANDLES, the last 8 hours (${cols})`)
  for (const b of m5) L.push(bar(b))

  // ---- the trader's entry rules ----
  L.push('', "THE TRADER'S ENTRY RULES AT THE FILL")
  if (d.rules == null) L.push('They have no entry rules set.')
  else if (!d.rules.length) L.push('None of their entry rules count on this date.')
  else if (!d.entryCtx) L.push('Their entry rules could not be read for this fill.')
  else {
    for (const b of d.entryCtx.bars) labels.add(b.t)
    for (const r of d.rules) {
      for (const t of timeLabelsIn(r.reason)) labels.add(t)
      L.push(`${r.name} "${r.label}": ${r.status === 'unknown' ? 'not judged' : r.status}. ${r.reason}`)
    }
  }

  // ---- order flow, only when the trader reads it ----
  if (of) {
    L.push('', 'ORDER FLOW (the trader reads it)')
    const tape = d.entryCtx?.tape
    if (tape != null) L.push(`Tape Reader at the fill (ask share of the 480 seconds before the fill, minus 50; + means buyers ahead): ${sgn(tape, 1)}`)
    if (d.flow) {
      L.push(`Their order-flow Score at the fill: ${d.flow.total} of ${d.flow.max}.`)
      for (const f of d.flow.facts) for (const t of timeLabelsIn(f.text)) labels.add(t)
      for (const f of d.flow.facts) L.push(`- ${f.label} ${f.state === 'with' ? '(with the trade)' : f.state === 'against' ? '(against the trade)' : '(neutral)'}: ${f.text}`)
    } else L.push('No order-flow Score for this fill.')
    if (BB && BB.t.length) {
      const n = BB.t.length, k0 = Math.max(0, n - BUBBLES_SHOWN), live = BB.live_trades < 40
      L.push('', `40-TRADE BUBBLES, the last ${n - k0} before the fill (time of the last trade, side, volume, price, size against the lookback)`)
      for (let k = k0; k < n; k++) {
        const isLive = live && k === n - 1
        L.push(`${clock(BB.t[k], true)} ${BB.dir[k] > 0 ? 'BUY' : 'SELL'} ${BB.vol[k]} at ${f2(BB.px[k])}, ${['small', 'medium', 'large'][isLive ? BB.live_lvl : BB.lvl[k]] ?? 'small'}${isLive ? ` (still forming: ${BB.live_trades} of 40 trades)` : ''}`)
      }
      const marks = BB.marks.filter(m => m.g - BB.first >= k0 && m.g - BB.first < n)
      if (marks.length) {
        L.push('', `LARGE PRINTS (single prints of ${BB.lpt}+ contracts)`)
        for (const m of marks) L.push(`${clock(BB.t[m.g - BB.first], true)} ${m.side > 0 ? 'BUY' : 'SELL'} ${m.vol} at ${f2(m.px)}`)
      }
    }
    const entrySec = +fill.slice(6, 8), g = ROW_TICKS[inst]
    L.push('', `FOOTPRINT, the last ${Math.min(FP_BARS, m1.length)} one-minute bars (rows of ${f2(g * TICK)} points, highest first: bid volume x ask volume)`)
    for (let i = Math.max(0, m1.length - FP_BARS); i < m1.length; i++) {
      const b = m1[i], st = footprintStats(m1, i, entrySec)
      const rows = groupRows(vap[i], g)
      const poc = rows.reduce<[number, number, number] | null>((best, r) => (!best || r[1] + r[2] > best[1] + best[2] ? r : best), null)
      L.push(`${clock(b.t)}${b.partial ? ` (still forming: to ${cutoff})` : ''}: vol ${Math.round(b.v)}, delta ${sgn(b.d, 0)}, ${st.vps.toFixed(2)} contracts a second`
        + `${st.tier ? ` (${st.tier + 1}x the median of the 10 bars before)` : ''}${poc ? `, bar POC ${f2(poc[0])}` : ''}`)
      for (let k = rows.length - 1; k >= 0; k--) L.push(`  ${f2(rows[k][0])}: ${rows[k][1]} x ${rows[k][2]}`)
    }
  }

  // ---- what isn't there ----
  const unseen = [...(of ? ['your DOM and resting orders'] : []), 'news', `${inst === 'NQ' ? 'ES' : 'NQ'} at the same moment`, 'your prep notes']
  if (B.stop == null) unseen.push('a stop')
  else if (B.stop_src === 'assumed') unseen.push('a stop you recorded (it used an assumed one)')
  if (B.tp == null) unseen.push('a target')
  else if (B.tp_src === 'assumed') unseen.push('a target you recorded (it used an assumed one)')
  if (d.rules && d.rules.length && !d.entryCtx) unseen.push('your entry rules at this fill')
  if (of && !d.flow) unseen.push('an order-flow Score for this fill')
  L.push('', `NOT IN THE DATA (never guess these): ${unseen.join('; ')}; anything from the fill on; how the trade went; the trader's size, other trades, tags, notes and their own call.`)

  return { text: L.join('\n'), times, labels: [...labels], lo, hi, entryPrice: px, fill, cutoff, unseen, of }
}

/** Volume-at-price rows summed into rows of `g` ticks: [price, bid, ask], ascending. */
function groupRows(rows: VapRow[] | undefined, g: number): [number, number, number][] {
  const m = new Map<number, [number, number]>()
  for (const [tk, b, a] of rows ?? []) {
    const k = Math.floor(tk / g) * g, e = m.get(k)
    if (e) { e[0] += b; e[1] += a } else m.set(k, [b, a])
  }
  return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([k, [b, a]]) => [k * TICK, b, a])
}

/** The trader's framework: their own words, their stop and target settings, and whether they read order flow. */
export function traderBlock(x: { profileBlock: string; sp: ScoringProfile | null; usesOrderFlow: boolean; atrStopTarget: number; tp1RMultiple: number }): string {
  const owner = isEmptyScoringProfile(x.sp)
  const L = ['THE TRADER']
  L.push(x.profileBlock.trim() || 'They have not written a profile: judge on price action, structure, levels and their plan.')
  const st = x.sp?.stop, band = stopBandOf(x.sp, x.atrStopTarget)
  if (band) L.push(`Their stop rule: anywhere from ${bandWords(band)} is on their rule (they aim for about ${x.atrStopTarget} x).`)
  else if (st?.value != null) L.push(`Their stop setting: ${st.value} points. They have no rule for how far off it is too far: give the size, never call it tight or wide.`)
  else L.push('They have no stop setting: give a stop\'s size, never call it tight or wide.')
  if (owner) L.push(`Their target setting: TP1 at ${x.tp1RMultiple}R.`)
  else if (x.sp?.tp) L.push(`Their target setting: ${x.sp.tp}.`)
  const s = x.sp?.style
  const style = [s?.timeframe, s?.edge_style?.replace('_', ' '), s?.exit_style?.replace('_', ' ')].filter(Boolean)
  if (style.length) L.push(`Their style: ${style.join(', ')}.`)
  L.push(x.usesOrderFlow
    ? 'They trade order flow: the ORDER FLOW section is part of their read.'
    : 'They do not trade order flow. There is no order-flow data: never mention order flow, delta, bubbles, the footprint or the tape.')
  return L.join('\n')
}

export const COACH_REVIEW_SYSTEM = `You are TapeScore's Coach Review. A trader is reviewing one of their own futures trades in Replay Review. They have already made their own call on it. You give a second read of the decision at the moment of the fill.

You are given only what had printed before the fill. You do not know how the trade went. Never guess, imply or predict it.

Write 3 to 5 observations. Each one is one of:
- "for": something in the data that supports taking this trade here.
- "against": something in the data that argues against it.
- "look": something on their chart before the fill worth a closer look, said as what to look at. A short question is fine.
Give at least one "for" and one "against" when the data has them. Never invent one to balance.

Rules:
1. Every observation names something specific from the data: a time, a price, a level by its name, or one of the trader's rules by its name. Use only times and prices that appear in the data. Every time in the data is before the fill.
2. Judge in the trader's own framework (THE TRADER). Use their rules and settings. Never add a rule, a threshold or a method they don't have.
3. Always in scope: price action, structure (higher or lower highs and lows on 1m and 5m), location against the levels, VWAP and EMAs, and the stop and target against those.
4. Order flow only when the data has an ORDER FLOW section. Without one, never mention order flow, delta, bubbles, the footprint or the tape.
5. The stop: say where it sits against swings and levels, and its size in points and x ATR. Call it tight or wide only when the plan says it is outside their stop rule. Inside their rule it is on their rule: never call it tight, wide, or tighter or wider than their aim.
6. Never say or hint: whether the trade worked, would have worked, or got stopped; anything after the fill, including how they managed, scaled or exited it; tilt, revenge, chasing, FOMO or their state of mind; their position size; their plan or bias for the day; news, other markets, the DOM or resting orders; a day type (trend day, range day). Say what price had done so far instead.
7. Never call their read right or wrong, and don't grade the trade. Lay out what supports it and what argues against it.
8. Talk to the trader as "you". Plain words, few of them: one or two short sentences, under 30 words, per observation. No headings, no filler, no hedging words.

Return only JSON: {"observations":[{"kind":"for","text":"..."}]}`

/** The structured output it must return. */
export const COACH_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['for', 'against', 'look'] }, text: { type: 'string' } },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['observations'],
  additionalProperties: false,
} as const

/** The model's JSON (fenced or not), loosely checked. Null when there is none. */
export function parseCoachReview(text: string): { items: CoachReviewItem[] } | null {
  const raw = text.replace(/```(?:json)?/g, '').trim()
  let j: unknown
  try { j = JSON.parse(raw) } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { j = JSON.parse(m[0]) } catch { return null }
  }
  const o = j as { observations?: unknown }
  if (!o || !Array.isArray(o.observations)) return null
  const items = o.observations
    .filter((x): x is CoachReviewItem => !!x && typeof x === 'object' && KIND_ORDER.includes((x as CoachReviewItem).kind) && typeof (x as CoachReviewItem).text === 'string')
    .map(x => ({ kind: x.kind, text: x.text.trim() }))
  return { items }
}

const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/g
const NUM_RE = /\d[\d,]*(?:\.\d+)?/g

/** The clock times a text names, as labels ("8:40" → "08:40"). Times the trader's own words or rules name count as known. */
export function timeLabelsIn(text: string): string[] {
  return [...text.matchAll(TIME_RE)].map(m => `${m[1].padStart(2, '0')}:${m[2]}${m[3] ? `:${m[3]}` : ''}`)
}

/**
 * Why a line can't be shown, or null when it can: it names a time the data
 * doesn't have (all of the data is before the fill, so this catches anything
 * at or after it, and made-up times), or a price off the chart.
 */
export function checkLine(text: string, input: Pick<CoachReviewInput, 'labels' | 'lo' | 'hi' | 'entryPrice' | 'fill'>): string | null {
  const labels = new Set(input.labels), fillMin = input.fill.slice(0, 5)
  for (const m of text.matchAll(TIME_RE)) {
    const hm = `${m[1].padStart(2, '0')}:${m[2]}`, hms = m[3] ? `${hm}:${m[3]}` : null
    if (hms ? !(labels.has(hms) || (labels.has(hm) && (hm !== fillMin || hms <= input.fill))) : !labels.has(hm)) return `${hms ?? hm} is not in the data`
  }
  for (const m of text.matchAll(NUM_RE)) {
    const v = Number(m[0].replace(/,/g, ''))
    if (!Number.isFinite(v) || v < input.entryPrice * 0.7 || v > input.entryPrice * 1.3) continue
    if (v < input.lo - TICK || v > input.hi + TICK) return `${m[0]} is off the chart`
  }
  return null
}

/**
 * The saved review: the lines that pass checkLine (at most 5, For / Against /
 * Look at in that order). "Couldn't see" is the input's own list, not the
 * model's: it is what was never sent, so it can't name something the data
 * shows. Null when no line passes.
 */
export function finishCoachReview(
  parsed: { items: CoachReviewItem[] }, input: CoachReviewInput,
  meta: { model: string; at: string; key: TradeCoachReview['key'] },
): TradeCoachReview | null {
  const items = parsed.items
    .filter(i => i.text.length >= 8 && !checkLine(i.text, input))
    .map(i => ({ kind: i.kind, text: i.text.slice(0, 400) }))
    .slice(0, 5)
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  if (!items.length) return null
  return { v: COACH_REVIEW_VERSION, key: meta.key, model: meta.model, at: meta.at, fill: input.fill, cutoff: input.cutoff, items, unseen: input.unseen, of: input.of }
}

// ---- version key: what a saved review was made from ----

/** FNV-1a, 32-bit, as hex: a short fingerprint (not security). */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
const withoutAt = (o: object | null | undefined) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'at')) : null)
const num = (x: number | string | null | undefined) => (x == null || x === '' ? null : Number(x))

export interface CoachReviewKeyInputs {
  row: { symbol: string | null; entry_time: string | null; entry_price: number | string | null; direction: string | null; stop_price: number | string | null; tp1_price: number | string | null; entry_atr_1m: number | string | null }
  entryCtx: TradeEntryCtx | null
  flow: TradeFlowScore | null
  rules: readonly EntryRuleConfig[]
  sp: ScoringProfile | null
  profileText: string
  usesOrderFlow: boolean
}

/** Fingerprints of the fill and plan (and the reads at it), the entry rules, and the profile. */
export function coachReviewKey(x: CoachReviewKeyInputs): TradeCoachReview['key'] {
  const r = x.row
  return {
    trade: fnv(JSON.stringify([r.symbol, r.entry_time, num(r.entry_price), r.direction, num(r.stop_price), num(r.tp1_price), num(r.entry_atr_1m),
      withoutAt(x.entryCtx), x.usesOrderFlow ? withoutAt(x.flow) : null])),
    rules: fnv(JSON.stringify(x.rules.filter(rule => rule.on))),
    profile: fnv(JSON.stringify([x.profileText.trim(), x.sp?.stop ?? null, x.sp?.tp ?? null, x.sp?.style ?? null, x.usesOrderFlow, isEmptyScoringProfile(x.sp)])),
  }
}

/** Why a saved review is out of date, in plain words; null when it still stands. */
export function staleReason(saved: TradeCoachReview, key: TradeCoachReview['key']): string | null {
  if (saved.v !== COACH_REVIEW_VERSION) return 'Coach Review has changed since this was made.'
  if (saved.key?.trade !== key.trade) return 'Your stop, target or the read at your fill changed since this was made.'
  if (saved.key?.rules !== key.rules) return 'Your entry rules changed since this was made.'
  if (saved.key?.profile !== key.profile) return 'Your profile changed since this was made.'
  return null
}
