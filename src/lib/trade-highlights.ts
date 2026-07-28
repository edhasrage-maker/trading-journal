import type { Trade, EodAiAnalysis } from '@/lib/supabase/types'

/** What LiveChart draws in a highlight chip, keyed by trade id. */
export type HighlightMap = Record<string, { pnl: string; score?: string; positive: boolean }>

/**
 * Build the on-chart highlight chips for a day.
 *
 * Two numbers and nothing else, on purpose: a highlighted chart is something
 * someone ELSE reads — a screenshot, a screen-share, a shared link — and a
 * caption that needs studying has stopped being a caption.
 *
 * Labels are DERIVED here rather than stored, so a corrected fill or a re-run
 * analysis moves the chip instead of leaving a stale number pinned to the chart.
 *
 * The score is the trade's own Execution Parameters figure, matched by the
 * analysis's 1-based `trade_number` into this same trades array. That mapping is
 * only valid while the array matches the one the analysis ran against, so the
 * whole score layer is dropped when the highest index overruns the list — the
 * chip then shows P&L alone. Showing the wrong trade's score on a chart built
 * for other people to read is the one outcome worth going out of the way to
 * prevent.
 */
export function buildHighlights(trades: Trade[], analysis: EodAiAnalysis | null): HighlightMap {
  const rows = analysis?.execution?.per_trade
  const scoreByTradeId = new Map<string, number>()
  if (rows?.length && Math.max(...rows.map(r => r.trade_number)) <= trades.length) {
    for (const r of rows) {
      const t = trades[r.trade_number - 1]
      if (t) scoreByTradeId.set(t.id, r.score)
    }
  }

  const out: HighlightMap = {}
  for (const t of trades) {
    if (!t.highlighted) continue
    const pnl = t.pnl ?? 0
    const score = scoreByTradeId.get(t.id)
    out[t.id] = {
      pnl: `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(0)}`,
      score: score == null ? undefined : `${Math.round(score * 100)}%`,
      positive: pnl >= 0,
    }
  }
  return out
}
