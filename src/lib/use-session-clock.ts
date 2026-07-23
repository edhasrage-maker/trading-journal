'use client'

import { useEffect, useState } from 'react'
import { rthCloseMs, isTodayPt } from './rth'

/**
 * Client-only session clock for the time-aware seam (Session-merge Pt 13 step 3).
 *
 * Every flag is false until after mount, so SSR and the first client render agree
 * (no hydration mismatch) and the seam UI simply doesn't appear during the flash
 * before hydration. Once mounted the flags reflect the real PT clock, and a
 * timer re-checks exactly when the RTH close passes so a page left open live
 * flips to closed on its own.
 */
export function useSessionClock(date: string): {
  mounted: boolean
  /** `date` is the current PT calendar date. */
  isToday: boolean
  /** The RTH close for `date` is still in the future. */
  beforeClose: boolean
} {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate client-only clock read on mount; SSR renders "closed" so there's no hydration mismatch
    setNow(Date.now())
    const close = rthCloseMs(date)
    if (!Number.isFinite(close) || close <= Date.now()) return
    // Fire just after the close so live → closed flips without a manual refresh.
    const id = setTimeout(() => setNow(Date.now()), close - Date.now() + 1000)
    return () => clearTimeout(id)
  }, [date])

  const mounted = now != null
  return {
    mounted,
    isToday: mounted && isTodayPt(date),
    beforeClose: mounted && now! < rthCloseMs(date),
  }
}
