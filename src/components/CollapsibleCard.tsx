'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * A section card that is ALWAYS open on desktop (md+) and a tap-to-expand
 * accordion on mobile. Lets a dense multi-section page (Prep, EOD) collapse into
 * scannable headers on a phone without changing the desktop layout at all.
 *
 * - Desktop: renders exactly like the old `bg-gray-900 … rounded-xl p-5` card —
 *   no chevron, title not clickable, content always shown (md:block wins).
 * - Mobile: the header is a toggle; content is hidden until expanded.
 *
 * `headerRight` holds any controls that lived in the section header (e.g. the
 * Chart screenshot/live toggle) — they stay in the header row in both modes.
 */
export default function CollapsibleCard({
  title,
  defaultOpen = false,
  desktopCollapsible = false,
  headerRight,
  children,
}: {
  title: string
  /** Mobile-only initial state (unless desktopCollapsible — then it's the
   *  initial state on desktop too). */
  defaultOpen?: boolean
  /** Opt-in: make the card a real accordion on DESKTOP too (chevron + toggle),
   *  instead of the default always-open-on-desktop behavior. Used to declutter
   *  a long page by starting secondary sections collapsed. */
  desktopCollapsible?: boolean
  headerRight?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className={`flex items-center gap-2 flex-1 min-w-0 text-left ${desktopCollapsible ? '' : 'md:pointer-events-none md:cursor-default'}`}
        >
          <ChevronDown
            className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${desktopCollapsible ? '' : 'md:hidden'} ${open ? '' : '-rotate-90'}`}
          />
          <h2 className="font-semibold text-white truncate">{title}</h2>
        </button>
        {headerRight}
      </div>
      <div className={`${open ? 'block' : 'hidden'} ${desktopCollapsible ? '' : 'md:block'} mt-4`}>{children}</div>
    </div>
  )
}
