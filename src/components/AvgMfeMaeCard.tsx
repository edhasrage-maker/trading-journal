'use client'

import { useEffect, useState } from 'react'
import { mfeMaePoints } from '@/lib/analytics'
import { symbolToMultiplier } from '@/lib/futures-symbols'
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
 * Unit choice is shared with the Dashboard via the same localStorage key
 * so flipping it in one place updates the other on next mount.
 */

type MfeUnit = 'pts' | 'dollars' | 'atr'
const UNIT_KEY = 'dashboard-stat-mfe-unit-v1'

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
  const [mfeUnit, setMfeUnit] = useState<MfeUnit>('atr')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(UNIT_KEY) as MfeUnit | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage hydration shim
      if (raw === 'pts' || raw === 'dollars' || raw === 'atr') setMfeUnit(raw)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(UNIT_KEY, mfeUnit) } catch { /* ignore */ }
  }, [mfeUnit, hydrated])

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

  const display = (v: number | null): string => {
    if (v == null) return '—'
    if (mfeUnit === 'dollars') {
      const abs = Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })
      return (v >= 0 ? '+$' : '-$') + abs
    }
    if (mfeUnit === 'atr') return (v >= 0 ? '+' : '') + v.toFixed(2) + '×'
    return (v >= 0 ? '+' : '') + v.toFixed(1)
  }

  const valueBlock = stats.mfe == null || stats.mae == null ? (
    <span className="text-gray-500">—</span>
  ) : (
    <>
      <span className="text-green-400">{display(stats.mfe)}</span>
      <span className="text-gray-600 mx-1">/</span>
      <span className="text-red-400">{display(stats.mae)}</span>
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
        <div className="text-lg font-bold whitespace-nowrap">{valueBlock}</div>
      </div>
    )
  }

  // Card variant — standalone, used on pages that don't already have a
  // summary bar to drop into.
  return (
    <div className={className ?? 'bg-gray-900 border border-gray-800 rounded-xl p-4'}>
      <p className="text-xs text-gray-500 mb-1 whitespace-nowrap">{label}</p>
      <p className="font-bold text-base whitespace-nowrap">{valueBlock}</p>
      <div className="mt-1">
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
