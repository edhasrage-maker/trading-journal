'use client'

import { useEffect, useMemo } from 'react'
import Link from 'next/link'
import { X, ExternalLink } from 'lucide-react'
import type { TradeWithContext } from '@/lib/analytics'
import { mfeMaePoints, captureRatio, maeHeatRatio } from '@/lib/analytics'

/**
 * Drilldown drawer surfaced from the Analytics tag tables. Click a tag
 * row → this modal opens with every trade carrying that tag, scoped to
 * the date range the parent Analytics page is filtering by.
 *
 * Why a drawer and not a separate /trades?tag=… route: keeps the user's
 * date range / preset selections in flight (no round-trip), and the
 * underlying trade array is already sitting in AnalyticsClient — no
 * extra fetch.
 *
 * Columns: Date · Side · Qty · Entry · R · PnL · MFE % · MAE % · Day Type.
 * Native trades' Date links to /eod/<date>; historical trades have no
 * detail page so the date renders as plain text.
 */

export type ModalCategory =
  | 'setups'
  | 'confluences'
  | 'order_flow'
  | 'trade_management'
  | 'day_types'

interface Props {
  open: { category: ModalCategory; label: string } | null
  trades: TradeWithContext[]
  onClose: () => void
}

/** A trade is "native" iff it carries a real trading_day_id. Historical
 *  (Tradezella-imported) trades have empty trading_day_id by convention
 *  set in analytics/page.tsx#histToContext. Native trades have a per-day
 *  EOD detail page; historical trades don't. */
function isNative(t: TradeWithContext): boolean {
  return !!t.trading_day_id
}

/** Filter trades to those carrying the (category, label) tag, matching
 *  the same logic the aggregation tables used to bucket them in the
 *  first place. Critically:
 *    - For tag categories (setups / confluences / order_flow / trade_management):
 *      check tags_json[category] for an exact label match.
 *    - For day_types: check t.day_types[] first (matches aggregateByDayType),
 *      fall back to legacy t.day_type, special-case "Untagged" for trades
 *      with neither.
 *  Trim spaces on both sides for safety since `aggregateByTag` does too. */
function tradeHasTag(t: TradeWithContext, category: ModalCategory, label: string): boolean {
  if (category === 'day_types') {
    const types = t.day_types.length > 0 ? t.day_types : (t.day_type ? [t.day_type] : [])
    if (label === 'Untagged') return types.length === 0
    return types.some(raw => raw.trim() === label)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tags = (t.tags_json as any) ?? {}
  const arr = tags[category]
  if (!Array.isArray(arr)) return false
  return (arr as string[]).some(raw => raw.trim() === label)
}

export default function TradeListModal({ open, trades, onClose }: Props) {
  // Close on Escape — standard modal affordance. Listener is attached only
  // while open so an idle Analytics page doesn't have a useless handler.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filtered = useMemo(() => {
    if (!open) return []
    return trades.filter(t => tradeHasTag(t, open.category, open.label))
  }, [trades, open])

  // Sort newest-first so the most recent example of the setup is at top —
  // matches how the user thinks about reviewing ("show me the most recent
  // Break and Retest trades").
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }, [filtered])

  if (!open) return null

  // Summary stats for the modal header.
  const totalPnl = sorted.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const wins = sorted.filter(t => (t.pnl ?? 0) > 0).length
  const losses = sorted.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = wins + losses > 0 ? wins / (wins + losses) : null
  const nativeCount = sorted.filter(isNative).length

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-end">
      {/* Backdrop — click anywhere outside the drawer to close. */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative z-10 w-full max-w-3xl bg-gray-950 border-l border-gray-800 shadow-2xl flex flex-col">
        <div className="flex items-start justify-between p-5 border-b border-gray-800 shrink-0">
          <div>
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">
              {categoryLabel(open.category)}
            </p>
            <h2 className="text-lg font-bold text-white mt-1">{open.label}</h2>
            <div className="flex items-center gap-4 mt-2 text-xs font-mono">
              <span className="text-gray-400">
                {sorted.length} trade{sorted.length === 1 ? '' : 's'}
                {nativeCount < sorted.length && (
                  <span className="text-gray-600"> ({nativeCount} native, {sorted.length - nativeCount} historical)</span>
                )}
              </span>
              <span className={totalPnl > 0 ? 'text-green-400' : totalPnl < 0 ? 'text-red-400' : 'text-gray-500'}>
                {totalPnl >= 0 ? '+' : '-'}${Math.abs(Math.round(totalPnl)).toLocaleString()}
              </span>
              {winRate != null && (
                <span className="text-gray-400">{(winRate * 100).toFixed(0)}% win</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 transition-colors p-1"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <p className="text-center text-sm text-gray-600 italic py-10 px-5">
              No trades carry this tag in the current date range.
            </p>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead className="text-gray-500 border-b border-gray-800 sticky top-0 bg-gray-950">
                <tr>
                  <th className="text-left font-normal py-2 px-3">Date</th>
                  <th className="text-left font-normal py-2 pr-3">Side</th>
                  <th className="text-right font-normal py-2 pr-3">Qty</th>
                  <th className="text-right font-normal py-2 pr-3">Entry</th>
                  <th className="text-right font-normal py-2 pr-3">R</th>
                  <th className="text-right font-normal py-2 pr-3">PnL</th>
                  <th className="text-right font-normal py-2 pr-3">MFE %</th>
                  <th className="text-right font-normal py-2 pr-3">MAE %</th>
                  <th className="text-left font-normal py-2 pr-3">Day Type</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(t => <TradeRow key={t.id} t={t} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function categoryLabel(c: ModalCategory): string {
  switch (c) {
    case 'setups': return 'Setup'
    case 'confluences': return 'Confluence'
    case 'order_flow': return 'Order Flow'
    case 'trade_management': return 'Trade Management'
    case 'day_types': return 'Day Type'
  }
}

function TradeRow({ t }: { t: TradeWithContext }) {
  const native = isNative(t)
  const pnl = t.pnl ?? 0
  // R-multiple — pnl / |entry - stop| * qty, falls back to null when
  // the pieces aren't present. Matches what `computeStats` uses for avg_r.
  let r: number | null = null
  if (t.pnl != null && t.entry_price != null && t.stop_price != null && t.quantity) {
    const risk = Math.abs(t.entry_price - t.stop_price) * t.quantity
    if (risk > 0) r = t.pnl / risk
  }
  const cap = captureRatio(t)
  const heat = maeHeatRatio(t)
  // Show MFE/MAE points alongside for context — pure-ratio is a bit
  // abstract on a per-trade view; raw points + ratio together is the
  // shape the user already reads on the intraday log.
  const xc = mfeMaePoints(t)
  const dayTypeDisplay = (t.day_types && t.day_types.length > 0)
    ? t.day_types.join(', ')
    : (t.day_type ?? '')

  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-900/60 transition-colors">
      <td className="py-1.5 px-3 whitespace-nowrap">
        {native && t.date ? (
          <Link
            href={`/eod/${t.date}`}
            className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
          >
            {t.date}
            <ExternalLink className="w-2.5 h-2.5" />
          </Link>
        ) : (
          <span className="text-gray-400">{t.date || '—'}</span>
        )}
      </td>
      <td className={`py-1.5 pr-3 ${t.direction === 'short' ? 'text-red-400' : 'text-green-400'}`}>
        {t.direction ?? '—'}
      </td>
      <td className="py-1.5 pr-3 text-right text-gray-400">{t.quantity ?? '—'}</td>
      <td className="py-1.5 pr-3 text-right text-gray-300">
        {t.entry_price != null ? t.entry_price.toLocaleString() : '—'}
      </td>
      <td
        className={`py-1.5 pr-3 text-right ${
          r == null ? 'text-gray-700'
          : r > 0 ? 'text-green-400'
          : r < 0 ? 'text-red-400'
          : 'text-gray-500'
        }`}
        title={r == null ? 'No R — missing stop or quantity' : ''}
      >
        {r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}
      </td>
      <td className={`py-1.5 pr-3 text-right ${pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-500'}`}>
        {pnl >= 0 ? '+' : '-'}${Math.abs(Math.round(pnl)).toLocaleString()}
      </td>
      <td
        className={`py-1.5 pr-3 text-right whitespace-nowrap ${
          cap == null ? 'text-gray-700'
          : cap < 0 ? 'text-red-400 font-bold'
          : 'text-gray-400'
        }`}
        title={xc ? `MFE = ${xc.mfe.toFixed(2)} pts` : 'No MFE data'}
      >
        {cap == null ? '—' : `${(cap * 100).toFixed(0)}%`}
      </td>
      <td
        className={`py-1.5 pr-3 text-right whitespace-nowrap ${
          heat == null ? 'text-gray-700'
          : heat > 1.0 ? 'text-red-400 font-bold'
          : 'text-gray-400'
        }`}
        title={xc ? `MAE = ${xc.mae.toFixed(2)} pts` : 'No MAE data'}
      >
        {heat == null ? '—' : `${Math.round(heat * 100)}%`}
      </td>
      <td className="py-1.5 pr-3 text-gray-500 truncate max-w-[160px]" title={dayTypeDisplay}>
        {dayTypeDisplay || '—'}
      </td>
    </tr>
  )
}
