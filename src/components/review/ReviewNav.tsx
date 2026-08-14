'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { weekStartFor } from '@/lib/week-dates'
import { cn } from '@/lib/utils'

/**
 * Review's time-scope sub-nav — Today · Week · Month · All time.
 *
 * EOD, the weekly recap and the monthly dashboard used to be three separate
 * destinations. They are one activity looked at through different windows, so
 * they became one destination with a scope switch
 * (docs/REVIEW_EOD_MERGE_SPEC.md). Users no longer have to learn TapeScore's
 * internal "EOD vs Review" distinction, and the loop the product promises —
 * Prep → Trade → Review — is finally legible in the nav itself.
 *
 * The views stay deliberately different: merging the navigation and the data
 * model was the point, NOT collapsing three densities into one scrolling page.
 */
export default function ReviewNav({
  /** PT session date the Today tab points at. */
  todayDate,
  /** Monday of the week the Week tab points at. */
  weekStart,
  /** True when today's session is still awaiting completion — Today gets a
   *  quiet marker so the trader can see there's something to finish. */
  pending = false,
}: {
  todayDate: string
  weekStart: string
  pending?: boolean
}) {
  const pathname = usePathname()

  // The day you are actually LOOKING AT, read off the URL.
  //
  // The scope props are resolved server-side from the database — the most
  // recent session — which is the right answer when you arrive at Review cold.
  // It is the wrong answer the moment you page back to an older day: every
  // scope tab kept pointing at the newest session, so reviewing the 3rd and
  // clicking any tab threw you back to the 14th. The URL knows which day you
  // are on; trust it, and fall back to the props only when it carries no date
  // (the month view, which is not about a particular day).
  const viewed = (() => {
    const day = /^\/review\/today\/(\d{4}-\d{2}-\d{2})/.exec(pathname)?.[1]
    if (day) return { day, week: weekStartFor(day) }
    const week = /^\/review\/week\/(\d{4}-\d{2}-\d{2})/.exec(pathname)?.[1]
    // From a week you have no single day — open its Monday, which is that
    // week's first session rather than an unrelated one.
    if (week) return { day: week, week }
    return null
  })()
  const dayHref = viewed?.day ?? todayDate
  const weekHref = viewed?.week ?? weekStart

  // "Today" is only honest when it IS today. Pointing at another day, the tab
  // names that day instead — the date stays visible rather than the nav
  // silently holding one you can't see.
  const onToday = dayHref === todayDate
  const dayLabel = onToday ? 'Today' : format(parseISO(dayHref), 'EEE MMM d')

  const scopes = [
    { href: `/review/today/${dayHref}`, label: dayLabel, match: '/review/today' },
    { href: `/review/week/${weekHref}`, label: 'Week', match: '/review/week' },
    // The month scope pages through CLOSED books too. `/review/month` (bare)
    // still redirects to the Dashboard, which owns the running windows.
    { href: `/review/month/${dayHref.slice(0, 7)}`, label: 'Month', match: '/review/month/' },
  ]

  return (
    <nav className="flex items-center gap-1 flex-wrap border-b border-gray-800 mb-6">
      {scopes.map(({ href, label, match }) => {
        const active = pathname.startsWith(match)
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'px-3 py-2 text-[13px] border-b-2 -mb-px transition-colors whitespace-nowrap',
              active
                ? 'text-gray-100 border-blue-500'
                : 'text-gray-400 border-transparent hover:text-gray-100',
            )}
          >
            {label}
            {/* The dot means TODAY's session is unfinished, so it only belongs
                on the day tab while that tab still points at today. */}
            {match === '/review/today' && onToday && pending && (
              <span
                aria-label="session awaiting completion"
                className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 ml-1.5 align-middle"
              />
            )}
          </Link>
        )
      })}
    </nav>
  )
}
