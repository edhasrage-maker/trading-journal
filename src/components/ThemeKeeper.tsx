'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { THEME_KEY } from './ThemeToggle'

/**
 * Keeps `data-theme` on <html> in sync with the saved choice across route
 * changes.
 *
 * The blocking script in the document head already applies the theme before
 * first paint, which covers hard loads. It does NOT re-run on client-side
 * navigation — and it shouldn't need to, because `data-theme` lives on <html>
 * and that element survives a soft navigation.
 *
 * "Shouldn't need to" is doing a lot of work there. React reconciles <html>
 * when the root layout re-renders, and an attribute set imperatively by a
 * script isn't part of any component's props, so it is not guaranteed to
 * survive. The symptom is a light-mode user getting dropped back to carbon by
 * the simple act of changing pages — a setting that won't stay set, which is
 * about as basic a broken promise as an app can make.
 *
 * So rather than reason about exactly which navigations preserve the attribute,
 * this re-asserts the saved value on every pathname change. Reading
 * localStorage and setting one attribute is far too cheap to be worth being
 * clever about, and it's correct no matter which layer dropped it.
 *
 * localStorage is the source of truth here, not the current DOM attribute:
 * recovering FROM a wiped attribute is the entire point, so trusting the
 * attribute would just re-affirm the wrong state.
 */
export default function ThemeKeeper() {
  const pathname = usePathname()

  useEffect(() => {
    let saved: string | null = null
    try { saved = localStorage.getItem(THEME_KEY) } catch { /* private mode / blocked */ }
    const root = document.documentElement
    if (saved === 'light') {
      if (root.getAttribute('data-theme') !== 'light') root.setAttribute('data-theme', 'light')
    } else if (saved === 'dark') {
      // Only an EXPLICIT dark choice clears it. A null value means the user has
      // never chosen, and dark is already the default ground — clearing on null
      // would fight any future server-rendered default.
      if (root.hasAttribute('data-theme')) root.removeAttribute('data-theme')
    }
  }, [pathname])

  return null
}
