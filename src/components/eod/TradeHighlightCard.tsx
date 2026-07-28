'use client'

import { X } from 'lucide-react'
import type { Trade } from '@/lib/supabase/types'

export interface PerTradeScore {
  /** 0..1 — passes / (passes + fails), N/A criteria excluded. */
  score: number
  passes: number
  fails: number
  na: number
}

/**
 * "Highlight" — one trade's P&L and its own execution score, on demand from the
 * row's right-click menu.
 *
 * The score is the per-trade Execution Parameters figure the EOD analysis
 * computes across the 9-criterion checklist. It is NOT the day's TapeScore:
 * TapeScore is a day-level construct (Risk/Entry/Exit thirds) and can't be
 * attributed to a single trade, so showing it here would be a different number
 * wearing the same name.
 *
 * `score` is null for any day analyzed before the per-trade figure started
 * being persisted (2026-07-27), and for trades excluded from execution scoring
 * as process breaches. Those two cases say different things and are worded
 * differently — "not scored yet" is a gap in our data, "excluded" is a finding
 * about the trade. Neither is ever rendered as a zero.
 */
export default function TradeHighlightCard({
  trade,
  score,
  onClose,
}: {
  trade: Trade
  score: PerTradeScore | null
  onClose: () => void
}) {
  const pnl = trade.pnl ?? null
  const pnlTone = pnl == null ? 'text-gray-300' : pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-300'
  const pnlText = pnl == null
    ? '—'
    : `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}`

  const pct = score ? Math.round(score.score * 100) : null
  const scoreTone = pct == null
    ? 'text-gray-400'
    : pct >= 80 ? 'text-green-400' : pct >= 60 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-500">Trade highlight</div>
            <div className="text-sm text-gray-300 mt-0.5">
              {trade.direction ? trade.direction.toUpperCase() : '—'}
              {trade.quantity ? ` · ${trade.quantity}` : ''}
              {trade.symbol ? ` · ${trade.symbol}` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">P&amp;L</div>
            <div className={`text-3xl font-bold tabular-nums ${pnlTone}`} style={{ fontFamily: 'var(--font-display)' }}>
              {pnlText}
            </div>
          </div>

          <div className="border-t border-gray-800 pt-3">
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Execution score</div>
            {pct == null ? (
              <p className="text-xs text-gray-500 leading-normal">
                Not scored yet — re-run <span className="text-gray-300">Analyze Session</span> to score this
                trade. (Days analyzed before the per-trade score shipped only stored the session average.)
              </p>
            ) : (
              <>
                <div className={`text-3xl font-bold tabular-nums ${scoreTone}`} style={{ fontFamily: 'var(--font-display)' }}>
                  {pct}%
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {score!.passes} of {score!.passes + score!.fails} criteria met
                  {score!.na > 0 ? ` · ${score!.na} not applicable` : ''}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
