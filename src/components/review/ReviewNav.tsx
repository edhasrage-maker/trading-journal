'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
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

  const scopes = [
    { href: '/review/overview', label: 'Overview', match: '/review/overview' },
    { href: `/review/today/${todayDate}`, label: 'Today', match: '/review/today' },
    { href: `/review/week/${weekStart}`, label: 'Week', match: '/review/week' },
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
            {label === 'Today' && pending && (
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
