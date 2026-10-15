/**
 * Runner rules — how the trader manages what is left after TP1, graded from
 * their own fills (Settings → Trading Rules → Runner rules; founder-approved
 * mockup docs/runner-rules-mockup.html, 2026-10-15).
 *
 * Pure and client-safe. Everything comes from the trade row itself — the exit
 * fills (exits_json), the logged TP1, the entry and the 1-minute ATR at entry —
 * so it needs no tick tape and works for every trader.
 *
 * THE FOUNDER'S CHOICE (2026-10-14): the TP2 study's mechanics
 * (docs/tp2-management-system.md) — take 60% off at TP1; the runner leaves
 * only at breakeven, a fixed 4×ATR target, or the 13:00 PT close; no trailing,
 * no closing on feel — measured against the TP1 price LOGGED on the trade.
 * The hold-or-not score failed its forward test and is deliberately not a rule.
 *
 * WHICH TRADES ARE JUDGED: a runner — a trade with a logged TP1 whose fills
 * took something at TP1 or better and left a piece on after that exit.
 *   - fills within 30 s of each other are one exit (a limit order filling in
 *     pieces); the first exit with a fill at TP1 or better is the scale-out;
 *     whatever is still on after it is the runner
 *   - all out at TP1, or nothing ever taken at TP1, or no TP1 logged → not a
 *     runner: no chip, no runner score (how those ended is Profit kept / Stop
 *     respected)
 *
 * SCORING mirrors the entry rules: a runner scores the share of its COUNTED
 * rules it passed (a rule counts from its start date); unknown counts neither
 * way. With any runner rule counting on a trade, that score IS the trade's
 * Exit "Runner rules" part; otherwise the generic part (TP1 filled + 5-minute
 * structure with you, src/lib/exit-score.ts) applies as before.
 */
import { symbolRoot } from '@/lib/futures-symbols'

export type RunnerRuleType = 'scale_out' | 'runner_exit' | 'be_after_tp1'

/** One rule as saved in scoring_profile_json.runner_rules. Only the fields its type reads are used. */
export interface RunnerRuleConfig {
  id: string
  type: RunnerRuleType
  /** The trader's own short name; shown wherever the rule is. */
  name: string
  on: boolean
  /** YYYY-MM-DD (PT). Counts toward Exit on trades from this date on. */
  from: string
  /** scale_out: the share of the position that must come off at TP1, %. */
  pct?: number
  /** runner_exit: breakeven = within this many ticks of entry. */
  be_ticks?: number
  /** runner_exit: the target, in ATRs from entry … */
  target_atr?: number
  /** … and how close to it still counts, in ATRs. */
  target_tol?: number
  /** runner_exit: the session close, "HH:MM" PT. */
  close?: string
}

export const RUNNER_TYPE_LABELS: Record<RunnerRuleType, string> = {
  scale_out: 'Scale out at TP1',
  runner_exit: 'Runner leaves by the plan',
  be_after_tp1: 'Stop to breakeven only after TP1',
}
export const RUNNER_TYPE_HINTS: Record<RunnerRuleType, string> = {
  scale_out: 'Take at least a set share off at your logged TP1',
  runner_exit: 'The rest leaves only at breakeven, a target in ATRs, or the close',
  be_after_tp1: "Not checkable from fills yet — shows as unknown",
}
export const RUNNER_TYPES: readonly RunnerRuleType[] = ['scale_out', 'runner_exit', 'be_after_tp1']

/** Fills this close together are one exit. */
export const EXIT_CLUSTER_MS = 30_000
/** An exit this soon after the close time counts as "out at the close". */
const CLOSE_WINDOW_MIN = 15

export function newRunnerRule(type: RunnerRuleType, name: string, from: string, id: string): RunnerRuleConfig {
  const base = { id, type, name, on: true, from }
  switch (type) {
    case 'scale_out': return { ...base, pct: 60 }
    case 'runner_exit': return { ...base, be_ticks: 2, target_atr: 4, target_tol: 0.25, close: '13:00' }
    case 'be_after_tp1': return { ...base }
  }
}

const num = (v: unknown, dflt: number, lo: number, hi: number): number => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt
}
const hhmm = (v: unknown, dflt: string) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : dflt)

/** Read rules from a saved profile, dropping anything malformed and clamping numbers. */
export function readRunnerRules(raw: unknown): RunnerRuleConfig[] {
  if (!Array.isArray(raw)) return []
  const out: RunnerRuleConfig[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const type = o.type as RunnerRuleType
    if (!RUNNER_TYPES.includes(type)) continue
    const from = typeof o.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.from) ? o.from : '1970-01-01'
    const d = newRunnerRule(type, '', from, typeof o.id === 'string' && o.id ? o.id : `t${out.length + 1}`)
    const rule: RunnerRuleConfig = { ...d, name: typeof o.name === 'string' ? o.name.slice(0, 24) : '', on: o.on !== false }
    if (type === 'scale_out') rule.pct = num(o.pct, 60, 1, 100)
    if (type === 'runner_exit') {
      rule.be_ticks = Math.round(num(o.be_ticks, 2, 0, 40))
      rule.target_atr = num(o.target_atr, 4, 0.5, 20)
      rule.target_tol = num(o.target_tol, 0.25, 0, 5)
      rule.close = hhmm(o.close, '13:00')
    }
    out.push(rule)
  }
  return out
}

/** What the rollup bakes in: the runner rules that are on, as they grade (names excluded). '' = none. */
export function runnerRulesSig(rules: readonly RunnerRuleConfig[] | null | undefined): string {
  const on = (rules ?? []).filter(r => r.on)
  if (!on.length) return ''
  const s = JSON.stringify(on.map(r => [r.type, r.from, r.pct, r.be_ticks, r.target_atr, r.target_tol, r.close]))
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `rr1-${on.length}-${h.toString(36)}`
}

export const runnerRuleLabel = (r: RunnerRuleConfig) => r.name.trim() || RUNNER_TYPE_LABELS[r.type]

/** One rule in plain words (the coach). */
export function describeRunnerRule(r: RunnerRuleConfig): string {
  switch (r.type) {
    case 'scale_out': return `pass when at least ${r.pct ?? 60}% of the position comes off at the logged TP1 price or better`
    case 'runner_exit': return `pass when what is left after TP1 exits only at breakeven (within ${r.be_ticks ?? 2} ticks of entry), the target (${r.target_atr ?? 4}× ATR from entry, within ${r.target_tol ?? 0.25}× ATR), or the ${r.close ?? '13:00'} PT close; any other exit counts as closed by hand`
    case 'be_after_tp1': return 'the stop moves to breakeven only after TP1 fills — not checkable from fills yet, always unknown'
  }
}

// ── reading a trade ──────────────────────────────────────────────────────────

/** The trade fields the runner rules read. */
export interface RunnerTrade {
  direction: string | null
  symbol: string | null
  entry_time?: string | null
  entry_price?: number | null
  tp1_price?: number | null
  entry_atr_1m?: number | null
  exits_json?: unknown
}

const TICK: Record<string, number> = { NQ: 0.25, MNQ: 0.25, ES: 0.25, MES: 0.25, YM: 1, MYM: 1, RTY: 0.1, M2K: 0.1, CL: 0.01, MCL: 0.01, GC: 0.1, MGC: 0.1 }
export const tickSizeOf = (symbol: string | null | undefined) => TICK[symbolRoot((symbol ?? '').toUpperCase())] ?? 0.25

interface Leg { t: number; iso: string; px: number; q: number }

/** "08:29" PT of an ISO time. */
function ptHm(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' })
}
function ptDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }) : null
}
const minutesOf = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }
const fmtPx = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The runner, as the rules see it — or why the trade is not one. */
export type RunnerRead =
  | { runner: false; why: 'no_tp1' | 'no_fills' | 'never_at_tp1' | 'all_out_at_tp1' }
  | {
      runner: true
      sign: 1 | -1
      entry: number
      tp1: number
      atr: number | null
      tick: number
      qty: number
      /** The scale-out exit: its fills, and what it took. */
      tp1Legs: Leg[]
      tp1Qty: number
      /** Everything still on after it, by fill. */
      runnerLegs: Leg[]
      runnerQty: number
    }

export function readRunner(t: RunnerTrade): RunnerRead {
  const s = t.direction === 'long' ? 1 : t.direction === 'short' ? -1 : 0
  const entry = t.entry_price == null ? NaN : Number(t.entry_price)
  const tp1 = t.tp1_price == null ? NaN : Number(t.tp1_price)
  if (!s || !Number.isFinite(entry) || !Number.isFinite(tp1) || (tp1 - entry) * s <= 0) return { runner: false, why: 'no_tp1' }
  const raw = Array.isArray(t.exits_json) ? (t.exits_json as { time?: unknown; price?: unknown; qty?: unknown }[]) : []
  const legs: Leg[] = []
  for (const l of raw) {
    const iso = typeof l?.time === 'string' ? l.time : ''
    const tm = Date.parse(iso), px = Number(l?.price), q = Number(l?.qty)
    if (Number.isFinite(tm) && Number.isFinite(px) && q > 0) legs.push({ t: tm, iso, px, q })
  }
  if (!legs.length) return { runner: false, why: 'no_fills' }
  legs.sort((a, b) => a.t - b.t)
  const groups: Leg[][] = []
  for (const l of legs) {
    const g = groups[groups.length - 1]
    if (g && l.t - g[g.length - 1].t <= EXIT_CLUSTER_MS) g.push(l)
    else groups.push([l])
  }
  const reached = (l: Leg) => (l.px - tp1) * s >= -1e-9
  const gi = groups.findIndex(g => g.some(reached))
  if (gi < 0) return { runner: false, why: 'never_at_tp1' }
  const runnerLegs = groups.slice(gi + 1).flat()
  if (!runnerLegs.length) return { runner: false, why: 'all_out_at_tp1' }
  const qty = legs.reduce((a, l) => a + l.q, 0)
  const tp1Legs = groups[gi]
  const atr = t.entry_atr_1m != null && Number(t.entry_atr_1m) > 0 ? Number(t.entry_atr_1m) : null
  return {
    runner: true, sign: s as 1 | -1, entry, tp1, atr, tick: tickSizeOf(t.symbol), qty,
    tp1Legs, tp1Qty: tp1Legs.reduce((a, l) => a + l.q, 0),
    runnerLegs, runnerQty: runnerLegs.reduce((a, l) => a + l.q, 0),
  }
}

// ── evaluation ───────────────────────────────────────────────────────────────

export type RunnerStatus = 'pass' | 'fail' | 'unknown'
export interface RunnerResult {
  id: string
  name: string
  status: RunnerStatus
  reason: string
  /** Counts toward Exit on this trade (on, and the trade is on or after its start date). */
  counted: boolean
}

/** Every rule that is on, judged on one trade. Null = not a runner (no chip, no runner score). */
export function evaluateRunnerRules(rules: readonly RunnerRuleConfig[], t: RunnerTrade): RunnerResult[] | null {
  const on = rules.filter(r => r.on)
  if (!on.length) return null
  const rd = readRunner(t)
  if (!rd.runner) return null
  const date = ptDateOf(t.entry_time)
  return on.map(r => {
    const counted = date != null && date >= r.from
    const res = (status: RunnerStatus, reason: string): RunnerResult => ({ id: r.id, name: runnerRuleLabel(r), status, reason, counted })
    switch (r.type) {
      case 'scale_out': {
        const share = rd.tp1Qty / rd.qty
        const pct = r.pct ?? 60
        const pxs = [...new Set(rd.tp1Legs.map(l => l.px))].map(fmtPx)
        const where = `${pxs.length > 1 ? `${pxs.slice(0, -1).join(', ')} and ${pxs[pxs.length - 1]}` : pxs[0]} (${ptHm(rd.tp1Legs[0].iso)})`
        const at = rd.tp1Legs.every(l => Math.abs(l.px - rd.tp1) < 1e-9) ? `at TP1 ${fmtPx(rd.tp1)}` : `at TP1 ${fmtPx(rd.tp1)} or better`
        const txt = `${rd.tp1Qty} of ${plural(rd.qty, 'contract')} (${Math.round(share * 100)}%) came off at ${where}, ${at}`
        return share >= pct / 100 - 1e-9 ? res('pass', `${txt}.`) : res('fail', `${txt}: under your ${pct}%.`)
      }
      case 'runner_exit': {
        const beTicks = r.be_ticks ?? 2, k = r.target_atr ?? 4, tol = r.target_tol ?? 0.25, close = r.close ?? '13:00'
        const closeMin = minutesOf(close)
        let unknown = false
        let bad: { leg: Leg; why: string } | null = null
        const kinds: string[] = []
        for (const l of rd.runnerLegs) {
          const pts = (l.px - rd.entry) * rd.sign
          const ticks = Math.round(Math.abs(pts) / rd.tick)
          const m = minutesOf(ptHm(l.iso))
          if (ticks <= beTicks) { kinds.push('breakeven'); continue }
          if (m >= closeMin && m < closeMin + CLOSE_WINDOW_MIN) { kinds.push(`the ${close} close`); continue }
          if (rd.atr == null) { unknown = true; continue }
          const x = pts / rd.atr
          if (x >= k - tol - 1e-9) { kinds.push(`the ${k}× ATR target`); continue }
          if (!bad) bad = { leg: l, why: Math.abs(pts) <= 3 * beTicks * rd.tick + 1e-9 ? `${ticks} ticks ${pts >= 0 ? 'past' : 'short of'} entry: outside your breakeven window (${beTicks} ticks)` : `${x.toFixed(2)}× ATR from entry: not breakeven, the ${k}× ATR target or ${close}` }
        }
        const last = rd.runnerLegs[rd.runnerLegs.length - 1]
        const lead = (l: Leg) => `The last ${rd.runnerQty === 1 ? 'contract' : `${rd.runnerQty} contracts`} left at ${fmtPx(l.px)} (${ptHm(l.iso)})`
        if (bad) return res('fail', `${rd.runnerLegs.length === 1 || rd.runnerLegs.every(l => l.px === bad!.leg.px) ? lead(bad.leg) : `Part of the runner left at ${fmtPx(bad.leg.px)} (${ptHm(bad.leg.iso)})`}, ${bad.why}, so closed by hand.`)
        if (unknown) return res('unknown', 'No ATR at entry, so the target can\'t be checked.')
        const what = [...new Set(kinds)]
        if (what.length === 1) {
          const atrTxt = what[0].includes('ATR') && rd.atr != null ? `, ${(((last.px - rd.entry) * rd.sign) / rd.atr).toFixed(2)}× ATR from entry` : ''
          return res('pass', `${lead(last)}${atrTxt}: ${what[0]}.`)
        }
        return res('pass', `The runner left at ${what.join(' and ')}.`)
      }
      case 'be_after_tp1':
        return res('unknown', 'Your fills don\'t show when the stop moved.')
    }
  })
}

/** A runner's score, 0..1: the share of its counted rules it passed, unknown left out. Null = nothing counted. */
export function runnerRulesScore(results: readonly RunnerResult[] | null): number | null {
  if (!results) return null
  let pass = 0, known = 0
  for (const r of results) {
    if (!r.counted || r.status === 'unknown') continue
    known++
    if (r.status === 'pass') pass++
  }
  return known ? pass / known : null
}

/**
 * The trade's Exit "Runner rules" part under the trader's runner rules:
 *   { own: false }                   no runner rule counts on this trade → the generic part applies
 *   { own: true, score: null }       the trader's rules count, but the trade is not a runner / nothing known
 *   { own: true, score: 0..1 }       the runner's score
 */
export function tradeRunnerPart(t: RunnerTrade, rules: readonly RunnerRuleConfig[] | null | undefined): { own: false } | { own: true; score: number | null } {
  const on = (rules ?? []).filter(r => r.on)
  const date = ptDateOf(t.entry_time)
  if (!on.length || date == null || !on.some(r => date >= r.from)) return { own: false }
  return { own: true, score: runnerRulesScore(evaluateRunnerRules(on, t)) }
}

// ── the tally (Settings) ─────────────────────────────────────────────────────

export interface RunnerTallyTrade extends RunnerTrade { pnl: number | null }
export interface RunnerTallyGroup { n: number; wins: number; losses: number; winRate: number | null; pf: number | null }

function group(pnls: number[]): RunnerTallyGroup {
  let won = 0, lost = 0, wins = 0, losses = 0
  for (const p of pnls) { if (p > 0) { won += p; wins++ } else if (p < 0) { lost -= p; losses++ } }
  const n = pnls.length
  return { n, wins, losses, winRate: n ? wins / n : null, pf: lost > 0 ? won / lost : won > 0 ? null : n ? 0 : null }
}

/** Runners since the rule's start date: how they did when it passed vs failed. */
export function runnerRuleTally(rule: RunnerRuleConfig, trades: readonly RunnerTallyTrade[]): { from: string; pass: RunnerTallyGroup; fail: RunnerTallyGroup; unknown: number } {
  const pass: number[] = [], fail: number[] = []
  let unknown = 0
  for (const t of trades) {
    if (t.pnl == null || !Number.isFinite(t.pnl)) continue
    const d = ptDateOf(t.entry_time)
    if (!d || d < rule.from) continue
    const res = evaluateRunnerRules([{ ...rule, on: true }], t)
    if (!res) continue                                // not a runner
    if (res[0].status === 'pass') pass.push(t.pnl)
    else if (res[0].status === 'fail') fail.push(t.pnl)
    else unknown++
  }
  return { from: rule.from, pass: group(pass), fail: group(fail), unknown }
}
