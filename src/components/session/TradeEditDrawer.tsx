'use client'

import { useEffect } from 'react'
import { X, ExternalLink } from 'lucide-react'
import { format } from 'date-fns'
import TradeForm from '@/components/intraday/TradeForm'
import type { Trade, TradeTag } from '@/lib/supabase/types'

/**
 * Edit-in-place drawer for the EOD recap (Session-merge Pt 13, step 2). Slides in
 * from the right and hosts a compact TradeForm — the SAME component the intraday
 * page uses, in its `compact` layout, so there is one save path and no forked
 * form. Saving PATCHes the trade and calls onSave; the recap re-renders the row
 * and re-scores in place. The deep-link to the full intraday log survives as the
 * secondary "Open full log" action.
 */
interface Props {
  trade: Trade
  date: string
  allTags: TradeTag[]
  /** Day's dominant symbol — the R-multiple preview's contract multiplier. */
  defaultSymbol?: string | null
  /** Called with the saved trade after a successful PATCH. */
  onSave: (trade: Trade) => void
  onClose: () => void
  /** Secondary action — open this trade's full log on the intraday page. */
  onOpenFullLog: (tradeId: string) => void
  /** Bubble up tags created inline from the drawer's TagSelector. */
  onTagCreated?: (tag: TradeTag) => void
}

export default function TradeEditDrawer({
  trade, date, allTags, defaultSymbol, onSave, onClose, onOpenFullLog, onTagCreated,
}: Props) {
  // Esc closes the drawer (matches the app's other overlays).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The screenshot zoom lightbox renders INSIDE this drawer and also closes
      // on Escape. While it's open the key belongs to it — otherwise one Esc
      // would collapse the zoom and the drawer together.
      if (document.querySelector('[aria-label="Trade screenshot zoom"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const timeLabel = trade.entry_time ? format(new Date(trade.entry_time), 'HH:mm:ss') : '--:--:--'

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop — click to dismiss. */}
      <div className="flex-1 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Right panel. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit trade at ${timeLabel}`}
        className="w-full max-w-lg h-full bg-gray-950 border-l border-gray-800 shadow-2xl flex flex-col"
      >
        <div className="flex items-start justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <div>
            <h3 className="font-semibold text-white text-sm">
              Edit trade · <span className="font-mono text-gray-300">{timeLabel}</span>
            </h3>
            <p className="text-[11px] text-gray-500 mt-0.5">Saves in place — no jump to another page.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 transition-colors -mt-0.5"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <TradeForm
            compact
            date={date}
            allTags={allTags}
            trade={trade}
            defaultSymbol={defaultSymbol}
            onTagCreated={onTagCreated}
            onSave={onSave}
            onCancel={onClose}
          />
        </div>

        {/* Full log — a real button pinned to the footer (it stays put while the
            drawer body scrolls), with the reason attached so it's obvious what
            lives over there and why you'd go. */}
        <div className="px-4 py-3 border-t border-gray-800 shrink-0 bg-gray-900/40 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => onOpenFullLog(trade.id)}
            className="inline-flex items-center gap-1.5 border border-amber-700/60 text-amber-300 hover:text-amber-200 hover:border-amber-500 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
            title="Open this trade's full log on the intraday page"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open full log
          </button>
          <span className="text-[11px] text-gray-500">replace the screenshot, re-read levels, direction</span>
        </div>
      </div>
    </div>
  )
}
