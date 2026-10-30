'use client'

import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import { weekStartFor } from '@/lib/week-dates'
import { cn } from '@/lib/utils'

export type SessionScope = 'day' | 'week' | 'month' | 'replay'

/**
 * Session's range switch — `<day> · Week · Month` (mockup: SessionOnePage),
 * plus Replay Review for the people on its beta list.
 *
 * The day segment names the day it opens rather than saying "Today", so the
 * date is always on screen. On the day page itself it IS the date picker: a
 * real date input laid over the label, so a click (or Enter) opens the native
 * calendar and keyboard users still reach it.
 */
export default function SessionTabs({
  day,
  active,
  deepDive = false,
  dot = false,
  onPickDay,
}: {
  /** The session date the day segment shows and links to. */
  day: string
  active: SessionScope
  /** Show Replay Review (decided on the server — see deep-dive-access.ts). */
  deepDive?: boolean
  /** Quiet marker on the day segment: today's session is waiting to be finished. */
  dot?: boolean
  /** On the day page: switch day. Makes the day segment a date picker. */
  onPickDay?: (date: string) => void
}) {
  const segment = (on: boolean) =>
    cn(
      'relative inline-flex items-center px-2.5 py-1.5 whitespace-nowrap transition-colors border-l border-gray-700 first:border-l-0',
      on ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800/50',
    )
  const dayLabel = (
    <>
      <span className="font-mono">{format(parseISO(day), 'EEE, MMM d')}</span>
      {dot && (
        <span
          aria-label="session awaiting completion"
          className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 ml-1.5"
        />
      )}
    </>
  )
  const links: Array<{ scope: SessionScope; href: string; label: string }> = [
    { scope: 'week', href: `/review/week/${weekStartFor(day)}`, label: 'Week' },
    // The month scope pages through CLOSED books too. `/review/month` (bare)
    // still redirects to the Dashboard, which owns the running windows.
    { scope: 'month', href: `/review/month/${day.slice(0, 7)}`, label: 'Month' },
    // One trade at a time, exactly as it looked at the fill.
    ...(deepDive ? [{ scope: 'replay' as const, href: '/review/replay', label: 'Replay Review' }] : []),
  ]

  return (
    <nav aria-label="Range" className="inline-flex flex-wrap border border-gray-700 rounded-md overflow-hidden text-xs">
      {onPickDay && active === 'day' ? (
        <span className={segment(true)} aria-current="page">
          {dayLabel}
          <input
            type="date"
            value={day}
            onChange={e => { const next = e.target.value; if (next && next !== day) onPickDay(next) }}
            onClick={e => { try { e.currentTarget.showPicker?.() } catch { /* not allowed here — the input still edits */ } }}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            title="Switch to a different day"
            aria-label="Session date"
          />
        </span>
      ) : (
        <Link href={`/session/${day}`} className={segment(active === 'day')} aria-current={active === 'day' ? 'page' : undefined}>
          {dayLabel}
        </Link>
      )}
      {links.map(l => (
        <Link key={l.scope} href={l.href} className={segment(active === l.scope)} aria-current={active === l.scope ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  )
}
