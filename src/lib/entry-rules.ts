/**
 * Entry rules — the trader's own entry checks, graded on every trade from the
 * tick tape (Settings → Trading Rules → Entry rules; founder, 2026-10-14).
 *
 * Pure and client-safe: the Settings page, the Recap table, the TapeScore
 * rollup and the coach all evaluate the same way from the same two inputs —
 *
 *   the trader's rules   scoring_profile_json.entry_rules (EntryRuleConfig[])
 *   the trade's snapshot trades.review_json.entry_ctx (TradeEntryCtx) — what
 *                        had printed BEFORE the fill: the last closed 1-minute
 *                        candles and the Tape Reader at the fill, read off the
 *                        tape by src/lib/orderflow/entry-context.ts
 *
 * so changing a number re-grades every trade at once without reading the tape
 * again. Nothing after the fill is ever stored or read.
 *
 * DEFINITIONS match the research that produced the trader's rule numbers
 * (NQ_backtest/delta_bars/entries_2026-09-30; parity checked against
 * o10_trades.pkl by scripts/test-entry-rules-parity.ts):
 *   - candles are regular 1-minute candles, counted by position (a minute with
 *     no trades is not a candle); the minute the fill is in is never one
 *   - against = closed against the trade (close vs its own open); a flat
 *     candle is not against
 *   - ATR = simple average true range of the 10 candles before the one judged
 *   - large candle = range ≥ k × ATR and body ≥ p% of range; its direction is
 *     its colour
 *   - delta spike = volume ≥ k × and |delta| ≥ k × the median of the 10
 *     candles before it; its direction is its delta's sign. A candle that is
 *     both takes the large candle's direction
 *   - Heiken Ashi colour = sign(HA close − HA open)
 *   - Tape Reader = ask share of everything traded in the 480 s before the
 *     fill, minus 50 (founder's choice, 2026-10-14 — the window the rule
 *     numbers were measured with, not the study's clock minutes)
 *
 * SCORING (founder, 2026-10-14): a trade scores the share of its COUNTED rules
 * it passed — a rule counts on trades from its start date on; unknown counts
 * neither way. Entry's "Entry rules" part pools trades (tapescore-axes.ts).
 */
import type { TradeEntryCtx, EntryCtxBar } from '@/lib/supabase/types'

// ── settings ─────────────────────────────────────────────────────────────────

export type EntryRuleType = 'candles_against' | 'last_candle' | 'large_against' | 'tape' | 'fade_spike' | 'ha_run'
export type TapeMode = 'band' | 'not_against' | 'pressure'

/** One rule as saved in scoring_profile_json.entry_rules. Only the fields its type reads are used. */
export interface EntryRuleConfig {
  id: string
  type: EntryRuleType
  /** The trader's own short name ("L1"); shown wherever the rule is. */
  name: string
  on: boolean
  /** YYYY-MM-DD (PT). The rule counts toward Entry on trades from this date on. */
  from: string
  /** candles_against / large_against / fade_spike / ha_run: how many candles (or minutes). */
  n?: number
  /** large_against / fade_spike: range ≥ atr × ATR. */
  atr?: number
  /** large_against / fade_spike: body ≥ body % of range. */
  body?: number
  /** fade_spike: volume ≥ vol × the 10-candle median. */
  vol?: number
  /** fade_spike: |delta| ≥ delta × the 10-candle median |delta|. */
  delta?: number
  /** tape: which test. */
  mode?: TapeMode
  /** tape: the band / against line, NQ and ES. */
  nq?: number
  es?: number
  /** tape: the pressure line, NQ and ES (the test in "pressure" mode; named in the other modes' reasons). */
  press_nq?: number
  press_es?: number
}

/** The most candles (or minutes) a rule can look back — the snapshot keeps this many closed candles. */
export const ENTRY_RULE_MAX_N = 10

export const RULE_TYPE_LABELS: Record<EntryRuleType, string> = {
  candles_against: 'Candles against',
  last_candle: 'Last candle my way',
  large_against: 'Large candle against',
  tape: 'Tape Reader at the fill',
  fade_spike: 'No fade after a large candle or delta spike',
  ha_run: 'Heiken Ashi already my colour',
}

/** One line per type for the "Add an entry rule" menu. */
export const RULE_TYPE_HINTS: Record<EntryRuleType, string> = {
  candles_against: 'Fail after N closed 1-minute candles in a row against you',
  last_candle: 'The last closed 1-minute candle closed your way',
  large_against: 'A big regular candle against you in the last N (range × ATR, body %)',
  tape: 'Inside a band, not against you, or not past the pressure line',
  fade_spike: 'Within the last N minutes',
  ha_run: 'Skip after N completed Heiken Ashi candles your colour',
}

export const RULE_TYPES: readonly EntryRuleType[] = ['candles_against', 'last_candle', 'large_against', 'tape', 'fade_spike', 'ha_run']

/** The numbers a new rule of each type starts with (the research's own values). */
export function newEntryRule(type: EntryRuleType, name: string, from: string, id: string): EntryRuleConfig {
  const base = { id, type, name, on: true, from }
  switch (type) {
    case 'candles_against': return { ...base, n: 3 }
    case 'last_candle': return { ...base }
    case 'large_against': return { ...base, n: 3, atr: 2, body: 70 }
    case 'tape': return { ...base, mode: 'band', nq: 2, es: 2, press_nq: 6, press_es: 6.4 }
    case 'fade_spike': return { ...base, n: 3, atr: 2, body: 70, vol: 2, delta: 2 }
    case 'ha_run': return { ...base, n: 2 }
  }
}

/** The founder's locked checklist (L1–L4, Oct 13 2026, counted from Oct 14) and
 *  frozen forward-test rules (F3/F5/F6, Sep 29 2026, counted from Sep 26). */
export const FOUNDER_ENTRY_RULES: EntryRuleConfig[] = [
  { ...newEntryRule('candles_against', 'L1', '2026-10-14', 'l1') },
  { ...newEntryRule('tape', 'L2', '2026-10-14', 'l2'), mode: 'band' },
  { ...newEntryRule('last_candle', 'L3', '2026-10-14', 'l3') },
  { ...newEntryRule('large_against', 'L4', '2026-10-14', 'l4') },
  { ...newEntryRule('fade_spike', 'F3', '2026-09-26', 'f3') },
  { ...newEntryRule('tape', 'F5', '2026-09-26', 'f5'), mode: 'not_against' },
  { ...newEntryRule('ha_run', 'F6', '2026-09-26', 'f6') },
]

const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt
}
const int = (v: unknown, dflt: number) => Math.round(num(v, dflt, 1, ENTRY_RULE_MAX_N))

/** Read rules from a saved profile, dropping anything malformed and clamping numbers. */
export function readEntryRules(raw: unknown): EntryRuleConfig[] {
  if (!Array.isArray(raw)) return []
  const out: EntryRuleConfig[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const type = o.type as EntryRuleType
    if (!RULE_TYPES.includes(type)) continue
    const from = typeof o.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.from) ? o.from : '1970-01-01'
    const d = newEntryRule(type, '', from, typeof o.id === 'string' && o.id ? o.id : `r${out.length + 1}`)
    const rule: EntryRuleConfig = {
      ...d,
      name: typeof o.name === 'string' ? o.name.slice(0, 24) : '',
      on: o.on !== false,
    }
    if (d.n != null) rule.n = int(o.n, d.n)
    if (d.atr != null) rule.atr = num(o.atr, d.atr, 0.1, 20)
    if (d.body != null) rule.body = num(o.body, d.body, 0, 100)
    if (d.vol != null) rule.vol = num(o.vol, d.vol, 0.1, 50)
    if (d.delta != null) rule.delta = num(o.delta, d.delta, 0.1, 50)
    if (type === 'tape') {
      rule.mode = o.mode === 'not_against' || o.mode === 'pressure' ? o.mode : 'band'
      rule.nq = num(o.nq, 2, 0, 50); rule.es = num(o.es, 2, 0, 50)
      rule.press_nq = num(o.press_nq, 6, 0, 50); rule.press_es = num(o.press_es, 6.4, 0, 50)
    }
    out.push(rule)
  }
  return out
}

/** What the rollup bakes in: the rules that are on, as they grade (names excluded). '' = none. */
export function entryRulesSig(rules: readonly EntryRuleConfig[] | null | undefined): string {
  const on = (rules ?? []).filter(r => r.on)
  if (!on.length) return ''
  const s = JSON.stringify(on.map(r => [r.type, r.from, r.n, r.atr, r.body, r.vol, r.delta, r.mode, r.nq, r.es, r.press_nq, r.press_es]))
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `er1-${on.length}-${h.toString(36)}`
}

/** One rule in plain words (for the coach and anywhere a rule is described away from Settings). */
export function describeRule(r: EntryRuleConfig): string {
  const g = (x: number | undefined, d: number) => fmtG(x ?? d)
  switch (r.type) {
    case 'candles_against': return `fail when the last ${r.n ?? 3} closed 1-minute candles all closed against the trade`
    case 'last_candle': return 'pass when the last closed 1-minute candle closed the trade\'s way or flat'
    case 'large_against': return `fail when one of the last ${r.n ?? 3} closed candles went against the trade with a range of at least ${g(r.atr, 2)}× ATR and a body of at least ${g(r.body, 70)}% of its range`
    case 'fade_spike': return `fail when the trade went against a large candle (range ${g(r.atr, 2)}× ATR, body ${g(r.body, 70)}%) or a delta spike (volume ${g(r.vol, 2)}× and delta ${g(r.delta, 2)}× the median of the 10 minutes before it) from the last ${r.n ?? 3} minutes`
    case 'ha_run': return `fail when the last ${r.n ?? 2} completed 1-minute Heiken Ashi candles were already the trade's colour`
    case 'tape': {
      const tr = 'the Tape Reader (ask share of the 480 s before the fill − 50)'
      if (r.mode === 'pressure') return `pass when ${tr} is not past the pressure line against the trade (${g(r.press_nq, 6)} NQ, ${g(r.press_es, 6.4)} ES)`
      if (r.mode === 'not_against') return `pass when ${tr} is not ${g(r.nq, 2)} (NQ) / ${g(r.es, 2)} (ES) or more against the trade`
      return `pass when ${tr} is inside ±${g(r.nq, 2)} (NQ) / ±${g(r.es, 2)} (ES)`
    }
  }
}

const bandText = (nq: number | undefined, es: number | undefined, dflt: number) => {
  const a = fmtG(nq ?? dflt), b = fmtG(es ?? dflt)
  return a === b ? a : `${a} (ES ${b})`
}

/** The rule in one line, built from its numbers — what the Recap shows instead of the short name
 *  (founder, 2026-10-15). Change a number and the line follows. */
export function ruleOneLiner(r: EntryRuleConfig): string {
  switch (r.type) {
    case 'candles_against': return `No ${r.n ?? 3} candles in a row against`
    case 'last_candle': return 'Last candle my way'
    case 'large_against': return `No big candle against (last ${r.n ?? 3})`
    case 'fade_spike': return `No fading a big candle or spike (${r.n ?? 3} min)`
    case 'ha_run': return `Heiken Ashi not already my colour (${r.n ?? 2}+)`
    case 'tape':
      if (r.mode === 'pressure') return 'Tape not past the pressure line'
      if (r.mode === 'not_against') return `Tape not ${bandText(r.nq, r.es, 2)}+ against`
      return `Tape inside ±${bandText(r.nq, r.es, 2)}`
  }
}

/** The mistake tag a failed rule puts on the trade — what went wrong, in a few words. */
export function ruleMistakeTag(r: EntryRuleConfig): string {
  switch (r.type) {
    case 'candles_against': return `${r.n ?? 3}+ candles in a row against`
    case 'last_candle': return 'Last candle against'
    case 'large_against': return 'Big candle against'
    case 'fade_spike': return 'Faded a big candle or spike'
    case 'ha_run': return 'Heiken Ashi already my colour'
    case 'tape':
      if (r.mode === 'pressure') return 'Tape past the pressure line'
      if (r.mode === 'not_against') return `Tape ${bandText(r.nq, r.es, 2)}+ against`
      return `Tape outside ±${bandText(r.nq, r.es, 2)}`
  }
}

/** The label a rule goes by: the trader's name, else its type. */
export const ruleLabel = (r: EntryRuleConfig) => r.name.trim() || RULE_TYPE_LABELS[r.type]

// ── evaluation ───────────────────────────────────────────────────────────────

export type RuleStatus = 'pass' | 'fail' | 'unknown'

export interface RuleResult {
  id: string
  /** The trader's short name ("L1") — hover text, and what the coach uses. */
  name: string
  /** The rule in one line, from its numbers ("No 3 candles in a row against") — what the Recap shows. */
  label: string
  status: RuleStatus
  reason: string
  /** The rule counts toward Entry on this trade (it is on, and the trade is on or after its start date). */
  counted: boolean
}

/** The trade a rule is judged for. */
export interface RuleTrade {
  direction: string | null
  symbol: string | null
  entry_time?: string | null
}

const isEs = (symbol: string | null) => /^M?ES/i.test((symbol ?? '').trim())

/** YYYY-MM-DD of an ISO time on the PT clock. */
export function ptDateOfIso(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

const fmt1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1)
const fmtG = (x: number) => String(Math.round(x * 100) / 100)
const signed = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '') + fmt1(Math.abs(x))
const colour = (dir: number) => (dir > 0 ? 'green' : dir < 0 ? 'red' : 'flat')
const side = (s: number) => (s > 0 ? 'long' : 'short')
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** "08:39", "08:39 and 08:40", "08:39, 08:40 and 08:41"; a longer run becomes a span. */
function times(ts: string[]): string {
  if (ts.length <= 3) return ts.length <= 1 ? (ts[0] ?? '') : `${ts.slice(0, -1).join(', ')} and ${ts[ts.length - 1]}`
  return `${ts[0]} to ${ts[ts.length - 1]}`
}

const minuteOf = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }
/** Whole minutes from a candle's start to the fill's minute (both PT HH:MM). */
function minutesBefore(barT: string, fillHm: string): number {
  let d = minuteOf(fillHm) - minuteOf(barT)
  if (d < 0) d += 24 * 60
  return d
}

const dirOf = (b: EntryCtxBar) => Math.sign(b.c - b.o)
const isLarge = (b: EntryCtxBar, atrK: number, bodyPct: number): boolean | null => {
  if (b.atr == null || !(b.atr > 0)) return null
  const range = b.h - b.l
  return range >= atrK * b.atr && Math.abs(b.c - b.o) >= (bodyPct / 100) * range
}
const isSpike = (b: EntryCtxBar, volK: number, deltaK: number): boolean | null => {
  if (b.mv == null || b.md == null) return null
  return b.v >= volK * b.mv && Math.abs(b.d) >= deltaK * b.md
}

/** Judge one rule on one trade. `ctx` null = the tape has not been read for this fill. */
export function evaluateRule(rule: EntryRuleConfig, ctx: TradeEntryCtx | null | undefined, trade: RuleTrade): RuleResult {
  const date = ptDateOfIso(trade.entry_time)
  const counted = rule.on && date != null && date >= rule.from
  const res = (status: RuleStatus, reason: string): RuleResult => ({ id: rule.id, name: ruleLabel(rule), label: ruleOneLiner(rule), status, reason, counted })
  const s = trade.direction === 'long' ? 1 : trade.direction === 'short' ? -1 : 0
  if (!s) return res('unknown', 'The trade has no direction.')
  if (!ctx) return res('unknown', 'No tick data for this trade.')
  const bars = ctx.bars ?? []
  const last = bars[bars.length - 1]
  const yours = colour(s), theirs = colour(-s)
  const fillHm = (ctx.read_at ?? '').slice(0, 5)

  switch (rule.type) {
    case 'candles_against': {
      const n = rule.n ?? 3
      let run = 0
      for (let i = bars.length - 1; i >= 0 && s * (bars[i].c - bars[i].o) < 0; i--) run++
      if (run >= n) {
        const ts = bars.slice(bars.length - run).map(b => b.t)
        return res('fail', run === n
          ? `${times(ts)} all closed ${theirs} before your ${side(s)}.`
          : `${times(ts)} all closed ${theirs} (${run} in a row) before your ${side(s)}.`)
      }
      if (run === bars.length) return res('unknown', 'Not enough candles before the fill to judge.')
      if (run === 0) {
        const d = dirOf(last)
        return res('pass', d === 0 ? `${last.t} closed flat; no run against you.` : `${last.t} closed ${yours}, your way; no run of ${theirs} candles before your ${side(s)}.`)
      }
      const ts = bars.slice(bars.length - run).map(b => b.t)
      return res('pass', run === 1
        ? `Only ${ts[0]} closed ${theirs} before your ${side(s)} (1 in a row).`
        : `${times(ts)} closed ${theirs} before your ${side(s)} (${run} in a row, fails at ${n}).`)
    }
    case 'last_candle': {
      if (!last) return res('unknown', 'Not enough candles before the fill to judge.')
      const d = dirOf(last)
      if (d === -s) return res('fail', `${last.t} closed ${theirs} before your ${side(s)}.`)
      return res('pass', d === 0 ? `${last.t} closed flat (counts as not against you).` : `${last.t} closed ${yours}, your way.`)
    }
    case 'large_against': {
      const n = rule.n ?? 3, k = rule.atr ?? 2, p = rule.body ?? 70
      if (bars.length < n) return res('unknown', 'Not enough candles before the fill to judge.')
      const win = bars.slice(bars.length - n)
      let missing = false, biggest = 0
      for (let i = win.length - 1; i >= 0; i--) {
        const b = win[i]
        const L = isLarge(b, k, p)
        if (L == null) { missing = true; continue }
        biggest = Math.max(biggest, (b.h - b.l) / (b.atr as number))
        if (L && dirOf(b) === -s) {
          const rng = (b.h - b.l) / (b.atr as number), body = (Math.abs(b.c - b.o) / (b.h - b.l)) * 100
          return res('fail', `${b.t} was a large ${theirs} candle: range ${fmt1(rng)}× ATR, body ${Math.round(body)}%.`)
        }
      }
      if (missing) return res('unknown', 'ATR could not be worked out for every candle checked.')
      const span = n === 1 ? win[0].t : `${win[0].t}–${win[win.length - 1].t}`
      return res('pass', `No large ${theirs} candle in ${span} (largest ${fmt1(biggest)}× ATR).`)
    }
    case 'tape': {
      if (ctx.tape == null || !Number.isFinite(ctx.tape)) return res('unknown', 'No Tape Reader reading at the fill.')
      const es = isEs(trade.symbol)
      const x = rule.mode === 'pressure' ? (es ? rule.press_es ?? 6.4 : rule.press_nq ?? 6) : (es ? rule.es ?? 2 : rule.nq ?? 2)
      const press = es ? rule.press_es ?? 6.4 : rule.press_nq ?? 6
      const you = s * ctx.tape                        // + = your way
      const head = `Tape Reader ${signed(ctx.tape)} over the 480 s before the fill`
      const pressNote = you <= -press ? `, past the pressure line (${fmtG(press)})` : ''
      if (rule.mode === 'not_against' || rule.mode === 'pressure') {
        const what = rule.mode === 'pressure' ? `the pressure line (${fmtG(x)})` : `${fmtG(x)}`
        return you > -x
          ? res('pass', `${head}: not ${what} or more against your ${side(s)}.`)
          : res('fail', `${head}: ${what} or more against your ${side(s)}.`)
      }
      if (Math.abs(ctx.tape) < x) return res('pass', `${head}, inside ±${fmtG(x)}.`)
      return res('fail', you > 0
        ? `${head}, outside ±${fmtG(x)} on your side.`
        : `${head}, outside ±${fmtG(x)} against your ${side(s)}${pressNote}.`)
    }
    case 'fade_spike': {
      const n = rule.n ?? 3, k = rule.atr ?? 2, p = rule.body ?? 70, vk = rule.vol ?? 2, dk = rule.delta ?? 2
      if (bars.length < n) return res('unknown', 'Not enough candles before the fill to judge.')
      const win = bars.slice(bars.length - n)
      let missing = false
      for (let i = win.length - 1; i >= 0; i--) {
        const b = win[i]
        const L = isLarge(b, k, p), S = isSpike(b, vk, dk)
        const ago = minutesBefore(b.t, fillHm)
        const agoTxt = ago <= 0 ? 'just before the fill' : `${plural(ago, 'minute')} before the fill`
        if (L) {
          if (dirOf(b) === -s) return res('fail', `You went ${side(s)} against ${b.t}, a large ${theirs} candle, ${agoTxt}.`)
          continue
        }
        if (S) {
          const ds = Math.sign(b.d)
          if (ds === -s) {
            const vx = b.mv ? b.v / b.mv : 0, dx = b.md ? Math.abs(b.d) / b.md : 0
            return res('fail', `You went ${side(s)} against a delta spike ${ds > 0 ? 'up' : 'down'} at ${b.t} (volume ${fmt1(vx)}×, delta ${fmt1(dx)}× the 10-minute median), ${agoTxt}.`)
          }
          continue
        }
        if (L == null || S == null) missing = true
      }
      if (missing) return res('unknown', 'The candle sizes could not be worked out for every minute checked.')
      return res('pass', `No large candle or delta spike against you in the ${n === 1 ? 'minute' : `${n} minutes`} before the fill.`)
    }
    case 'ha_run': {
      const n = rule.n ?? 2
      if (!last) return res('unknown', 'Not enough candles before the fill to judge.')
      let run = 0
      for (let i = bars.length - 1; i >= 0 && bars[i].ha === s; i--) run++
      if (run >= n) {
        const ts = bars.slice(bars.length - run).map(b => b.t)
        return res('fail', run <= 3
          ? `Heiken Ashi had been ${yours} on ${times(ts)} before your ${side(s)}.`
          : `Heiken Ashi had been ${yours} for ${run} candles (${times(ts)}) before your ${side(s)}.`)
      }
      if (run === bars.length) return res('unknown', 'Not enough candles before the fill to judge.')
      if (run === 0) return res('pass', `Heiken Ashi was ${last.ha === 0 ? 'flat' : colour(last.ha)} on ${last.t}, not yet your colour.`)
      return res('pass', `Heiken Ashi turned ${yours} on ${bars[bars.length - run].t} (${plural(run, 'candle')}), not yet ${n}.`)
    }
  }
}

/** Every rule that is on, judged on one trade, in the trader's order. */
export function evaluateRules(rules: readonly EntryRuleConfig[], ctx: TradeEntryCtx | null | undefined, trade: RuleTrade): RuleResult[] {
  return rules.filter(r => r.on).map(r => evaluateRule(r, ctx, trade))
}

/** A trade's Entry-rules score, 0..1: the share of its counted rules it passed, unknown left out. Null = nothing counted. */
export function tradeRulesScore(results: readonly RuleResult[]): number | null {
  let pass = 0, known = 0
  for (const r of results) {
    if (!r.counted || r.status === 'unknown') continue
    known++
    if (r.status === 'pass') pass++
  }
  return known ? pass / known : null
}

/** The chip on the Recap row: passed of checked, over every rule that is on. */
export function rulesChip(results: readonly RuleResult[]): { passed: number; checked: number; unknown: number; tone: 'ok' | 'bad' | 'mid' | 'none' } {
  let passed = 0, checked = 0, unknown = 0
  for (const r of results) {
    if (r.status === 'unknown') { unknown++; continue }
    checked++
    if (r.status === 'pass') passed++
  }
  const tone = !checked ? 'none' : passed === checked ? 'ok' : passed / checked < 0.5 ? 'bad' : 'mid'
  return { passed, checked, unknown, tone }
}

// ── the tally (Settings) ─────────────────────────────────────────────────────

export interface TallyTrade extends RuleTrade { pnl: number | null; ctx: TradeEntryCtx | null | undefined }

export interface TallyGroup { n: number; winRate: number | null; pf: number | null; wins: number; losses: number }
export interface RuleTally { from: string; pass: TallyGroup; fail: TallyGroup; unknown: number }

function group(pnls: number[]): TallyGroup {
  const n = pnls.length
  let won = 0, lost = 0, wins = 0, losses = 0
  for (const p of pnls) { if (p > 0) { won += p; wins++ } else if (p < 0) { lost -= p; losses++ } }
  return { n, wins, losses, winRate: n ? wins / n : null, pf: lost > 0 ? won / lost : won > 0 ? null : n ? 0 : null }
}

/** How trades since the rule's start date did when it passed vs failed. Trades without a P&L are left out. */
export function ruleTally(rule: EntryRuleConfig, trades: readonly TallyTrade[]): RuleTally {
  const pass: number[] = [], fail: number[] = []
  let unknown = 0
  for (const t of trades) {
    if (t.pnl == null || !Number.isFinite(t.pnl)) continue
    const d = ptDateOfIso(t.entry_time)
    if (!d || d < rule.from) continue
    const r = evaluateRule({ ...rule, on: true }, t.ctx, t)
    if (r.status === 'pass') pass.push(t.pnl)
    else if (r.status === 'fail') fail.push(t.pnl)
    else unknown++
  }
  return { from: rule.from, pass: group(pass), fail: group(fail), unknown }
}

/** "2 trades · 50% · PF 1.4" / "1 trade · 100% · —" / "1 · 0% · PF 0" (without the word) / "0". */
export function tallyGroupText(g: TallyGroup, withWord = true): string {
  if (!g.n) return '0'
  const wr = `${Math.round((g.winRate ?? 0) * 100)}%`
  const pf = g.pf == null ? '—' : g.pf === 0 ? 'PF 0' : `PF ${(Math.round(g.pf * 10) / 10).toFixed(1)}`
  return `${withWord ? plural(g.n, 'trade') : g.n} · ${wr} · ${pf}`
}

/** "Oct 14" from YYYY-MM-DD. */
export function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
