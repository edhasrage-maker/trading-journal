'use client'

import { usePathname } from 'next/navigation'
import SessionTabs, { type SessionScope } from '@/components/session/SessionTabs'

/**
 * The Session header on the Week, Month and Replay Review pages — the same
 * `<day> · Week · Month` switch the day page carries (Session merge), so the
 * three ranges read as one destination. Week and Month keep their /review URLs.
 *
 * The views stay deliberately different: merging the navigation was the point,
 * NOT collapsing three densities into one scrolling page.
 */
export default function ReviewNav({
  /** PT session date the day segment falls back to. */
  todayDate,
  /** True when today's session is still awaiting completion — the day segment
   *  gets a quiet marker while it points at today. */
  pending = false,
  /** Show the Replay Review tab (decided on the server — see deep-dive-access.ts). */
  deepDive = false,
}: {
  todayDate: string
  pending?: boolean
  deepDive?: boolean
}) {
  const pathname = usePathname()

  // From a week, the day segment opens its Monday — that week's first session
  // rather than an unrelated one. Elsewhere (a month, Replay) there is no
  // single day in view, so it opens today.
  const week = /^\/review\/week\/(\d{4}-\d{2}-\d{2})/.exec(pathname)?.[1]
  const day = week ?? todayDate
  const active: SessionScope = pathname.startsWith('/review/week')
    ? 'week'
    : pathname.startsWith('/review/month')
      ? 'month'
      : 'replay'

  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 mb-6">
      <div className="text-[22px] font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Session</div>
      <SessionTabs day={day} active={active} deepDive={deepDive} dot={pending && day === todayDate} />
    </div>
  )
}
