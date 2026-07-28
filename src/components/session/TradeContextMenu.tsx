'use client'

import { useEffect, useRef } from 'react'
import { ExternalLink, Highlighter } from 'lucide-react'

export interface TradeContextMenuState {
  tradeId: string
  x: number
  y: number
}

/** Declared at module scope, not inside the menu: a component created during
 *  render is remounted on every keystroke of parent state. */
function MenuItem({ icon: Icon, label, hint, onClick }: {
  icon: typeof ExternalLink
  label: string
  hint: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-gray-800 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
    >
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-400" />
      <span className="min-w-0">
        <span className="block text-[13px] text-gray-100 leading-tight">{label}</span>
        <span className="block text-[11px] text-gray-500 leading-tight mt-0.5">{hint}</span>
      </span>
    </button>
  )
}

/**
 * Right-click menu for a trade row.
 *
 * Left-click on a row already does the common thing (edit / open the log), so
 * this exists for the second and third things a trader wants from a trade
 * without losing their place in the table.
 *
 * Positioned at the cursor and flipped back inside the viewport when the click
 * lands near an edge — a menu that opens half off-screen at the bottom of a
 * long trade list is the normal case, not the edge case.
 */
export default function TradeContextMenu({
  state,
  onClose,
  onOpenIntraday,
  onHighlight,
}: {
  state: TradeContextMenuState | null
  onClose: () => void
  onOpenIntraday?: (tradeId: string) => void
  onHighlight?: (tradeId: string) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  // Dismiss on anything that isn't a click inside the menu: outside click,
  // Escape, scroll, or another right-click elsewhere.
  useEffect(() => {
    if (!state) return
    const close = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', close)
    document.addEventListener('contextmenu', close)
    window.addEventListener('scroll', onClose, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('contextmenu', close)
      window.removeEventListener('scroll', onClose, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [state, onClose])

  if (!state) return null

  // Keep the menu on screen. Sized generously rather than measured — the menu
  // has two fixed items, so a constant is honest and avoids a layout pass.
  const W = 208, H = 84
  const left = Math.min(state.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8)
  const top = Math.min(state.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - H - 8)

  const run = (fn?: (id: string) => void) => fn ? () => { fn(state.tradeId); onClose() } : undefined

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top }}
      className="fixed z-50 w-52 py-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl"
      onContextMenu={e => e.preventDefault()}
    >
      <MenuItem icon={ExternalLink} label="Intraday Review" hint="Open this trade's full log" onClick={run(onOpenIntraday)} />
      <MenuItem icon={Highlighter} label="Highlight" hint="P&L and this trade's score" onClick={run(onHighlight)} />
    </div>
  )
}
