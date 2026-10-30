import { symbolToMultiplier } from '@/lib/futures-symbols'
import { plannedStopPrice, type StopSource } from '@/lib/planned-stop'
import { evaluateRules, type EntryRuleConfig } from '@/lib/entry-rules'
import { mergeMgmtTotals, mgmtView, type MgmtTotals } from '@/lib/trade-management'
import type { TradeEntryCtx } from '@/lib/supabase/types'

/**
 * The four numbers a trader reads on each day of the dashboard's Days table to
 * decide which day to open (founder, 2026-10-28):
 *
 *   Risk vs usual    the day's average planned dollar risk per trade, against
 *                    the trader's usual risk per trade (the same yardstick Loss
 *                    size uses, src/lib/exit-rollup.ts) — an average against an
 *                    average, so a busy day isn't flagged just for having more
 *                    trades to take a maximum over (founder, 2026-10-29)
 *   Trades vs usual  the day's trade count against the median trading day
 *                    before it — replaced Entry Compliance as one of the four
 *                    (founder, 2026-10-29): every trader has the data, and it
 *                    isn't already inside the TapeScore
 *   Entry Compliance (optional column, not one of the four) the share of the day's trades that passed every counted
 *                    entry rule (src/lib/entry-rules.ts), against the days
 *                    before it — by trade, not by rule check (founder,
 *                    2026-10-29: 94 of 105 checks read 90% on a day only 7
 *                    of 15 trades were clean)
 *   MFE Profit Kept  the existing "kept" (src/lib/trade-management.ts), against
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
/** Risk lights up when the day's average risk per trade reaches this multiple of the usual. */
export const RISK_OFF_MULTIPLE = 1.5
/** Playbook lights up this many points under its usual. */
export const PLAYBOOK_OFF_POINTS = 10
/** Fewer checked trades than this in the window → no usual yet (the same floor as Kept). */
export const PLAYBOOK_MIN_TRADES = 5
/** Kept lights up this many points under its usual. */
export const KEPT_OFF_POINTS = 15
/** Fewer trades that went your way than this in the window → no usual yet. */
export const KEPT_MIN_TRADES = 5
/** Fewer green days than this in the window → no "good day" to measure a high against. */
export const HIGH_MIN_GREEN_DAYS = 5
/** Trades lights up at this multiple of the usual day's trade count. */
export const TRADES_OFF_MULTIPLE = 2
/** Fewer earlier trading days than this in the window → no usual trade count yet. */
export const TRADES_MIN_DAYS = 5

/** What a day stores. JSON-safe — cached in `stats_json`. */
export interface DayGlanceFacts {
  /** Biggest planned dollar risk on one trade. Null = no trade had a stop. */
  risk_max: number | null
  /** Trades that passed every counted entry rule / trades with at least one
   *  known counted rule (unknown results left out). */
  trades_passed: number
  trades_checked: number
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
  let passed = 0, checked = 0
  const misses: Record<string, number> = {}
  // In entry order, so `misses` lists rules in the order they first failed and
  // a tie for most missed goes to the earliest miss, whatever order the rows came in.
  const byEntry = [...trades].sort((a, b) => ((a.entry_time ?? '') < (b.entry_time ?? '') ? -1 : (a.entry_time ?? '') > (b.entry_time ?? '') ? 1 : 0))
  for (const t of byEntry) {
    if (t.pnl != null) {
      const r = plannedRisk(t)
      if (r != null && (riskMax == null || r > riskMax)) riskMax = r
    }
    if (entryRules?.length) {
      const results = evaluateRules(entryRules, t.entry_ctx ?? null, { direction: t.direction, symbol: t.symbol, entry_time: t.entry_time ?? null })
      let known = 0, clean = true
      for (const r of results) {
        if (!r.counted || r.status === 'unknown') continue
        known++
        if (r.status !== 'pass') { clean = false; misses[r.name] = (misses[r.name] ?? 0) + 1 }
      }
      if (known) { checked++; if (clean) passed++ }
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
    trades_passed: passed,
    trades_checked: checked,
    misses,
    peak,
    after_peak_trades: afterN,
    after_peak_pnl: afterPnl,
  }
}

/** What the table renders for a day: each number with its usual and whether it is off. */
export interface DayGlanceRead {
  /** Null = no trade had a planned stop. `ratio` = avg ÷ usual; `max` is the biggest single trade. */
  risk: { avg: number; max: number | null; usual: number | null; ratio: number | null; off: boolean } | null
  /** The day's trade count against the usual day (the median of the window). */
  trades: { count: number; usual: number | null; ratio: number | null; off: boolean }
  /** Null = no trade on the day had an entry rule checked. Shown as Entry
   *  Compliance (optional column); not one of the four, so not in `off`. */
  playbook: { passed: number; trades: number; pct: number; usual: number | null; off: boolean; mostMissed: string | null } | null
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
  /** How many of the four (risk, trades, kept, high) are off. */
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
  /** The day's summed planned dollar risk over its trades with a stop, and how many (the rollup's risk sums). */
  sum_risk_dollars?: number | null
  risk_sample?: number | null
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

    // Risk vs usual: the day's average risk per trade against the usual one.
    const usualRisk = d.risk_usual != null && d.risk_usual > 0 ? d.risk_usual : null
    const avgRisk = (d.risk_sample ?? 0) > 0 && (d.sum_risk_dollars ?? 0) > 0 ? d.sum_risk_dollars! / d.risk_sample! : null
    const risk = avgRisk == null ? null : {
      avg: avgRisk,
      max: g.risk_max,
      usual: usualRisk,
      ratio: usualRisk != null ? avgRisk / usualRisk : null,
      off: usualRisk != null && avgRisk >= RISK_OFF_MULTIPLE * usualRisk,
    }

    // Playbook: checked trades pooled over the window.
    let pPassed = 0, pTrades = 0
    for (const p of prior) { pPassed += p.glance?.trades_passed ?? 0; pTrades += p.glance?.trades_checked ?? 0 }
    const playbookUsual = pTrades >= PLAYBOOK_MIN_TRADES ? pPassed / pTrades : null
    let mostMissed: string | null = null
    for (const [name, n] of Object.entries(g.misses)) {
      if (mostMissed == null || n > g.misses[mostMissed]) mostMissed = name
    }
    const playbook = g.trades_checked === 0 ? null : {
      passed: g.trades_passed,
      trades: g.trades_checked,
      pct: g.trades_passed / g.trades_checked,
      usual: playbookUsual,
      off: playbookUsual != null && (g.trades_passed / g.trades_checked) * 100 <= playbookUsual * 100 - PLAYBOOK_OFF_POINTS,
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

    // Trades vs usual: the median trading day in the window, so one 15-trade
    // day doesn't drag the usual up for the next twenty.
    const counts = prior.map(p => p.trade_count).sort((a, b) => a - b)
    const tradesUsual = counts.length >= TRADES_MIN_DAYS
      ? (counts.length % 2 ? counts[(counts.length - 1) / 2] : (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2)
      : null
    const trades = {
      count: d.trade_count,
      usual: tradesUsual,
      ratio: tradesUsual != null && tradesUsual > 0 ? d.trade_count / tradesUsual : null,
      off: tradesUsual != null && tradesUsual > 0 && d.trade_count >= TRADES_OFF_MULTIPLE * tradesUsual,
    }

    out.set(d.id, {
      risk, trades, playbook, kept, high,
      off: [risk?.off, trades.off, kept.off, high.off].filter(Boolean).length,
    })
  }
  return out
}
