import { symbolToMultiplier } from '@/lib/futures-symbols'
import { plannedStopPrice, type StopSource } from '@/lib/planned-stop'
import { evaluateRules, type EntryRuleConfig } from '@/lib/entry-rules'
import { mergeMgmtTotals, mgmtView, type MgmtTotals } from '@/lib/trade-management'
import type { TradeEntryCtx } from '@/lib/supabase/types'

/**
 * The four numbers a trader reads on each day of the dashboard's Days table to
 * decide which day to open (founder, 2026-10-28):
 *
 *   Risk vs usual    the biggest planned dollar risk on one trade, against the
 *                    trader's usual risk per trade (the same yardstick Loss size
 *                    uses, src/lib/exit-rollup.ts)
 *   Playbook         the share of entry-rule checks the day's trades passed
 *                    (src/lib/entry-rules.ts), against the days before it
 *   Kept             the existing "kept" (src/lib/trade-management.ts), against
 *                    the days before it
 *   After your high  once the day's realized P&L reached a good day — the
 *                    average green day among the trading days before it — did
 *                    the trader keep trading and give some back?
 *
 * Each number only lights up when it is off the trader's OWN usual. A day
 * stores its facts (`dayGlanceFacts`, cached in stats_json); the usuals come
 * from earlier days, so they are worked out when the days are read in
 * sequence (`readDayGlance`), like Loss size.
 */

/** Earlier trading days the usuals are taken from. */
export const GLANCE_WINDOW_DAYS = 20
/** Risk lights up at this multiple of the usual risk per trade. */
export const RISK_OFF_MULTIPLE = 2
/** Playbook lights up this many points under its usual. */
export const CHECKS_OFF_POINTS = 10
/** Fewer rule checks than this in the window → no usual yet. */
export const CHECKS_MIN = 20
/** Kept lights up this many points under its usual. */
export const KEPT_OFF_POINTS = 15
/** Fewer trades that went your way than this in the window → no usual yet. */
export const KEPT_MIN_TRADES = 5
/** Fewer green days than this in the window → no "good day" to measure a high against. */
export const HIGH_MIN_GREEN_DAYS = 5

/** What a day stores. JSON-safe — cached in `stats_json`. */
export interface DayGlanceFacts {
  /** Biggest planned dollar risk on one trade. Null = no trade had a stop. */
  risk_max: number | null
  /** Entry-rule checks passed / checked (counted rules only, unknown left out). */
  checks_passed: number
  checks: number
  /** Failed checks per rule name — the day's most-missed rule. */
  misses: Record<string, number>
  /** The day's best realized P&L (cumulative, by exit time). 0 = never green. */
  peak: number
  /** Trades entered after that best point, and what they made. */
  after_peak_trades: number
  after_peak_pnl: number
}

/** The trade fields the facts read (superset-safe). */
export interface GlanceTrade extends StopSource {
  pnl: number | null
  entry_price: number | null
  quantity: number | null
  symbol: string | null
  direction: 'long' | 'short' | null
  entry_time?: string | null
  exit_time?: string | null
  entry_ctx?: TradeEntryCtx | null
}

/** One trade's planned dollar risk — the same formula as the rollup's risk sums. */
function plannedRisk(t: GlanceTrade): number | null {
  const stop = plannedStopPrice(t)
  if (t.entry_price == null || stop == null || t.quantity == null) return null
  const risk = Math.abs(t.entry_price - stop) * t.quantity * symbolToMultiplier(t.symbol ?? '')
  return risk > 0 ? risk : null
}

export function dayGlanceFacts(trades: readonly GlanceTrade[], entryRules?: readonly EntryRuleConfig[] | null): DayGlanceFacts {
  let riskMax: number | null = null
  let passed = 0, checks = 0
  const misses: Record<string, number> = {}
  for (const t of trades) {
    if (t.pnl != null) {
      const r = plannedRisk(t)
      if (r != null && (riskMax == null || r > riskMax)) riskMax = r
    }
    if (entryRules?.length) {
      const results = evaluateRules(entryRules, t.entry_ctx ?? null, { direction: t.direction, symbol: t.symbol, entry_time: t.entry_time ?? null })
      for (const r of results) {
        if (!r.counted || r.status === 'unknown') continue
        checks++
        if (r.status === 'pass') passed++
        else misses[r.name] = (misses[r.name] ?? 0) + 1
      }
    }
  }

  // The day's best realized point: P&L added up in the order the trades closed.
  const closed = trades
    .filter(t => t.pnl != null && t.exit_time)
    .sort((a, b) => (a.exit_time! < b.exit_time! ? -1 : a.exit_time! > b.exit_time! ? 1 : 0))
  let cum = 0, peak = 0
  let peakAt: string | null = null
  for (const t of closed) {
    cum += t.pnl as number
    if (cum > peak) { peak = cum; peakAt = t.exit_time! }
  }
  let afterN = 0, afterPnl = 0
  if (peakAt != null) {
    for (const t of trades) {
      if (t.entry_time && t.entry_time > peakAt) { afterN++; afterPnl += t.pnl ?? 0 }
    }
  }

  return {
    risk_max: riskMax,
    checks_passed: passed,
    checks,
    misses,
    peak,
    after_peak_trades: afterN,
    after_peak_pnl: afterPnl,
  }
}

/** What the table renders for a day: each number with its usual and whether it is off. */
export interface DayGlanceRead {
  /** Null = no trade had a planned stop. */
  risk: { max: number; usual: number | null; ratio: number | null; off: boolean } | null
  /** Null = no entry-rule checks on the day. */
  playbook: { passed: number; checks: number; pct: number; usual: number | null; off: boolean; mostMissed: string | null } | null
  /** Usual kept (0..1, dollars) going into the day; `off` compares the day's own kept. */
  kept: { pct: number | null; usual: number | null; off: boolean }
  /** Null = no trades with a result. */
  high: {
    peak: number
    /** The average green day before it; null = not enough green days yet. */
    bar: number | null
    /** The day reached a good day's worth of realized P&L. */
    reached: boolean
    afterTrades: number
    afterPnl: number
    off: boolean
  } | null
  /** How many of the four are off. */
  off: number
}

/** The part of a day `readDayGlance` reads. */
export interface GlanceDay {
  id: string
  date: string
  trade_count: number
  eod_pnl: number | null
  glance?: DayGlanceFacts | null
  mgmt?: MgmtTotals | null
  /** The trader's usual planned risk per trade going into the day (the Loss-size yardstick's mean). */
  risk_usual?: number | null
}

/** `days` with each day's read attached as `glance_read` (null = no facts to read). Order is preserved. */
export function withGlance<T extends GlanceDay>(days: readonly T[]): (T & { glance_read: DayGlanceRead | null })[] {
  const reads = readDayGlance(days)
  return days.map(d => ({ ...d, glance_read: reads.get(d.id) ?? null }))
}

/**
 * Read every day against the trading days before it. `days` may be in any
 * order; each day's usuals come from up to GLANCE_WINDOW_DAYS earlier days in
 * the same list. Days without stored facts (an old cache row) read as null.
 */
export function readDayGlance(days: readonly GlanceDay[]): Map<string, DayGlanceRead> {
  const traded = days
    .filter(d => d.trade_count > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const out = new Map<string, DayGlanceRead>()
  for (let i = 0; i < traded.length; i++) {
    const d = traded[i]
    const g = d.glance
    if (!g) continue
    const prior = traded.slice(Math.max(0, i - GLANCE_WINDOW_DAYS), i)

    // Risk vs usual.
    const usualRisk = d.risk_usual != null && d.risk_usual > 0 ? d.risk_usual : null
    const risk = g.risk_max == null ? null : {
      max: g.risk_max,
      usual: usualRisk,
      ratio: usualRisk != null ? g.risk_max / usualRisk : null,
      off: usualRisk != null && g.risk_max >= RISK_OFF_MULTIPLE * usualRisk,
    }

    // Playbook: rule checks pooled over the window.
    let pPassed = 0, pChecks = 0
    for (const p of prior) { pPassed += p.glance?.checks_passed ?? 0; pChecks += p.glance?.checks ?? 0 }
    const checksUsual = pChecks >= CHECKS_MIN ? pPassed / pChecks : null
    let mostMissed: string | null = null
    for (const [name, n] of Object.entries(g.misses)) {
      if (mostMissed == null || n > g.misses[mostMissed]) mostMissed = name
    }
    const playbook = g.checks === 0 ? null : {
      passed: g.checks_passed,
      checks: g.checks,
      pct: g.checks_passed / g.checks,
      usual: checksUsual,
      off: checksUsual != null && (g.checks_passed / g.checks) * 100 <= checksUsual * 100 - CHECKS_OFF_POINTS,
      mostMissed,
    }

    // Kept: the window's trade-management sums, pooled.
    const priorMgmt = mergeMgmtTotals(prior.map(p => p.mgmt))
    const keptUsual = priorMgmt.went.count >= KEPT_MIN_TRADES ? mgmtView(priorMgmt, 'dollars').went.keptPct : null
    const keptPct = d.mgmt && d.mgmt.went.count > 0 ? mgmtView(d.mgmt, 'dollars').went.keptPct : null
    const kept = {
      pct: keptPct,
      usual: keptUsual,
      off: keptPct != null && keptUsual != null && keptPct * 100 < keptUsual * 100 - KEPT_OFF_POINTS,
    }

    // After your high: a good day = the average green day in the window.
    const greens = prior.map(p => p.eod_pnl).filter((x): x is number => x != null && x > 0)
    const bar = greens.length >= HIGH_MIN_GREEN_DAYS ? greens.reduce((a, b) => a + b, 0) / greens.length : null
    const reached = bar != null && g.peak >= bar
    const high = {
      peak: g.peak,
      bar,
      reached,
      afterTrades: g.after_peak_trades,
      afterPnl: g.after_peak_pnl,
      off: reached && g.after_peak_trades > 0,
    }

    out.set(d.id, {
      risk, playbook, kept, high,
      off: [risk?.off, playbook?.off, kept.off, high.off].filter(Boolean).length,
    })
  }
  return out
}
