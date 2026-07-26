'use client'

import { mfeMaePoints, avgCaptureRatio, type TradeWithExcursion } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'
import { useMfeUnit, formatMfeMae, type MfeUnit } from '@/lib/mfe-unit'
import type { Trade } from '@/lib/supabase/types'

/**
 * Shared Avg-MFE/MAE display card. Mirrors the Dashboard's stat card pattern
 * (pts / $ / ×ATR toggle) but operates on the trades passed in — so it can be
 * dropped at the top of intraday or EOD recap views to surface per-day
 * excursion averages without duplicating the toggle state.
 *
 * Per-trade ATR normalization prefers the trade's own entry_atr_1m (back-
 * filled for 2025+ trades by scripts/backfill-entry-metrics.ts) — so a
 * trade taken when volatility was hot gets normalized against THAT moment's
 * ATR, not a stale day-end value. Older trades without entry_atr_1m fall
 * back to the optional `dayAtrRef` (typically market_context.atr_1m for
 * the day), and finally to null (skipped from the ×ATR average).
 *
 * Unit choice is shared globally via the useMfeUnit() hook (custom event +
 * localStorage), so flipping it here ALSO updates the per-trade Peak MFE/
 * Peak MAE display on the intraday detail rows.
 */

// Trade with the recently-added entry-time snapshot columns. The Supabase
// generated Trade type doesn't include them yet (regeneration pending), so
// widen locally — same pattern as in src/app/(app)/analytics/page.tsx.
type TradeWithEntryMetrics = Trade & {
  entry_atr_1m?: number | null
  entry_rvol?: number | null
}

interface Props {
  trades: Trade[]
  /** Day-level ATR fallback used when a trade has no entry_atr_1m of its own
   *  (pre-2025 trades, trades outside RTH). Optional — without it those
   *  trades are simply omitted from the ×ATR average. */
  dayAtrRef?: number | null
  /** Render style:
   *   - 'card'   (default) — standalone bg-gray-900 card with vertical layout
   *   - 'inline' — compact item meant to drop into an existing stats row
   *     (matches surrounding label / value pairs like "Trades / Day P&L /
   *     Wins-Losses"). No background, no border. */
  variant?: 'card' | 'inline'
  /** Custom outer class — overrides default card style when variant='card'. */
  className?: string
  label?: string
}

export default function AvgMfeMaeCard({ trades, dayAtrRef, variant = 'card', className, label = 'Avg MFE / MAE' }: Props) {
  const [mfeUnit, setMfeUnit] = useMfeUnit()

  // Compute per-trade MFE/MAE in the active unit, then mean across trades
  // with data. Each unit has its own denominator (count of trades for which
  // we could compute THAT unit — e.g. ×ATR requires an ATR reference, $
  // requires a symbol multiplier). We don't want a missing ATR to drag the
  // pts average down.
  const stats = (() => {
    const mfeVals: number[] = []
    const maeVals: number[] = []
    for (const t of trades) {
      const xc = mfeMaePoints(t)
      if (!xc) continue
      if (mfeUnit === 'pts') {
        mfeVals.push(xc.mfe); maeVals.push(xc.mae)
      } else if (mfeUnit === 'dollars') {
        const mult = symbolToMultiplier(t.symbol ?? '')
        const qty = t.quantity ?? 1
        mfeVals.push(xc.mfe * qty * mult)
        maeVals.push(xc.mae * qty * mult)
      } else {
        // atr — prefer per-trade entry_atr_1m, fall back to day-level
        const tx = t as TradeWithEntryMetrics
        const atrRef = (tx.entry_atr_1m != null && tx.entry_atr_1m > 0)
          ? tx.entry_atr_1m
          : (dayAtrRef != null && dayAtrRef > 0 ? dayAtrRef : null)
        if (atrRef != null) {
          mfeVals.push(xc.mfe / atrRef)
          maeVals.push(xc.mae / atrRef)
        }
      }
    }
    const avg = (arr: number[]) => arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length
    return { mfe: avg(mfeVals), mae: avg(maeVals), n: mfeVals.length }
  })()

  // "Kept" = Profit Captured (avgCaptureRatio: sum(max(0,pnl)) / sum(mfeDollars),
  // per-trade floored) — a $-basis RATIO, so it's the same in every display unit;
  // only the heat/run magnitudes re-scale with the toggle. Reusing it (rather than
  // a raw average realized) keeps losers from dragging "kept" negative.
  const capture = avgCaptureRatio(trades as unknown as TradeWithExcursion[]).avg

  // Single-axis bar geometry (worst point → entry → exit → best point) in the
  // active unit: heat = the MAE span left of entry; run = the MFE span right of
  // entry (faint); kept = the solid part of the run actually banked (capture ×
  // run). Mirrors docs/tapescore-mfe-mae-bar.html. Null (no bar) until there's a
  // real range and a computable capture.
  const bar = (() => {
    const { mfe, mae } = stats
    if (mfe == null || mae == null || capture == null) return null
    const total = mfe + mae
    if (!(total > 0)) return null
    const cap = Math.max(0, Math.min(1, capture))
    const heatPct = (mae / total) * 100
    const runPct = (mfe / total) * 100
    const keptPct = runPct * cap
    return { heatPct, runPct, keptPct, entryPct: heatPct, exitPct: heatPct + keptPct, keptLabel: Math.round(cap * 100) }
  })()

  const display = (v: number | null): string => formatMfeMae(v, mfeUnit)

  const valueBlock = stats.mfe == null || stats.mae == null ? (
    <span className="text-gray-500">—</span>
  ) : (
    <>
      <span className="text-green-400">{display(stats.mfe)}</span>
      <span className="text-gray-600 mx-1">/</span>
      {/* MAE is a positive magnitude internally; render it signed-negative so it
          reads as an adverse excursion (below entry), consistent with the bar. */}
      <span className="text-red-400">{display(stats.mae == null ? null : -stats.mae)}</span>
    </>
  )

  // Inline variant — drops cleanly into an existing summary bar (matches the
  // label-over-value pattern of Trades / Day P&L / W-L). The unit dropdown
  // sits inline with the label so it doesn't add a vertical row, and the
  // "N of M trades with data" subline is omitted to save another row.
  if (variant === 'inline') {
    return (
      <div className={className}>
        <div className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5 whitespace-nowrap">
          {label}
          <select
            value={mfeUnit}
            onChange={e => setMfeUnit(e.target.value as MfeUnit)}
            className="bg-gray-800 border border-gray-700 text-gray-400 text-[9px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight normal-case tracking-normal"
            title="Display unit (shared with Dashboard)"
          >
            <option value="pts">pts</option>
            <option value="dollars">$</option>
            <option value="atr">×ATR</option>
          </select>
        </div>
        <div className="text-sm font-bold whitespace-nowrap">{valueBlock}</div>
      </div>
    )
  }

  // Card variant — standalone, used on pages that don't already have a
  // summary bar to drop into.
  return (
    <div className={className ?? 'bg-gray-900 border border-gray-800 rounded-xl p-4'}>
      <p className="text-xs text-gray-500 mb-1 whitespace-nowrap">{label}</p>
      <p className="font-bold text-base whitespace-nowrap">{valueBlock}</p>

      {/* One-axis excursion bar: worst point → entry → exit → best point. The
          solid green is what was kept (Profit Captured); the faint green to its
          right is the run that was given back. Heat/run aren't word-labeled —
          the value line + colors already carry them — leaving only the one stat
          not stated elsewhere: kept %. Card variant only (a bar doesn't belong
          in the compact inline row). */}
      {bar && (
        <div className="mt-2.5">
          <div className="relative h-[7px] rounded-[2px]" style={{ background: '#14171C' }}>
            <span className="absolute top-0 h-[7px] rounded-l-[2px]" style={{ left: 0, width: `${bar.heatPct}%`, background: 'rgba(224,104,95,0.45)' }} />
            <span className="absolute top-0 h-[7px] rounded-r-[2px]" style={{ left: `${bar.entryPct}%`, width: `${bar.runPct}%`, background: 'rgba(79,197,142,0.18)' }} />
            <span className="absolute top-0 h-[7px] bg-emerald-400" style={{ left: `${bar.entryPct}%`, width: `${bar.keptPct}%` }} />
            <span className="absolute bg-gray-200" style={{ left: `${bar.entryPct}%`, top: '-3px', height: '13px', width: '1.5px' }} />
            <span className="absolute bg-gray-200" style={{ left: `${bar.exitPct}%`, top: '-3px', height: '13px', width: '2px' }} />
          </div>
          <p className="mt-1.5 text-center text-[10.5px] text-gray-500">kept <b className="text-gray-200 font-semibold">{bar.keptLabel}%</b></p>
        </div>
      )}

      <div className="mt-1.5">
        <select
          value={mfeUnit}
          onChange={e => setMfeUnit(e.target.value as MfeUnit)}
          className="bg-gray-800 border border-gray-700 text-gray-400 text-[10px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight"
          title="Display unit (shared with Dashboard)"
        >
          <option value="pts">pts per trade</option>
          <option value="dollars">$ per trade</option>
          <option value="atr">× ATR per trade</option>
        </select>
      </div>
      <p className="text-[10px] text-gray-600 mt-1 whitespace-nowrap">
        {stats.n} of {trades.length} trade{trades.length === 1 ? '' : 's'} with data
      </p>
    </div>
  )
}
