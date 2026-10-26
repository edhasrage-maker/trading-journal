'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

/**
 * A thin scoreboard-blue line across the top of the window while the next page
 * loads. No route has a loading state, so a click on a heavy page (dashboard,
 * recap) used to sit for half a second with nothing visible happening.
 *
 * Starts on a plain left-click of an in-app link to a different URL, races to
 * ~85% (fast at first, then crawling), and completes + fades when the URL
 * changes. Programmatic router.push navigations aren't caught — they're rare
 * and follow an explicit action that already shows its own feedback. A 10 s
 * safety stop covers a navigation that never lands.
 */
type Phase = 'idle' | 'start' | 'run' | 'done'

export default function NavProgress() {
  const pathname = usePathname()
  const search = useSearchParams()
  const [phase, setPhase] = useState<Phase>('idle')

  // Start: a click on an in-app link that goes somewhere else.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
      const to = new URL(a.href, window.location.href)
      if (to.origin !== window.location.origin) return
      if (to.pathname === window.location.pathname && to.search === window.location.search) return
      setPhase('start')
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  // Finish: the URL changed (the new page is in).
  const url = `${pathname}?${search}`
  const lastUrl = useRef(url)
  useEffect(() => {
    if (url === lastUrl.current) return
    lastUrl.current = url
    setPhase(p => (p === 'idle' ? p : 'done'))
  }, [url])

  // Phase timing: one frame at 0% so the width transition runs, a safety stop
  // while running, and a short fade before resetting.
  useEffect(() => {
    if (phase === 'start') {
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('run')))
      return () => cancelAnimationFrame(id)
    }
    if (phase === 'run') {
      const id = window.setTimeout(() => setPhase('done'), 10_000)
      return () => window.clearTimeout(id)
    }
    if (phase === 'done') {
      const id = window.setTimeout(() => setPhase('idle'), 450)
      return () => window.clearTimeout(id)
    }
  }, [phase])

  const width = phase === 'run' ? '85%' : phase === 'done' ? '100%' : '0%'
  const transition =
    phase === 'run' ? 'width 8s cubic-bezier(0.05, 0.8, 0.1, 1)'
    : phase === 'done' ? 'width 150ms ease-out, opacity 250ms ease 150ms'
    : 'none'

  return (
    <div aria-hidden className="fixed top-0 inset-x-0 h-0.5 z-[60] pointer-events-none">
      <div
        className="h-full bg-blue-500 motion-reduce:transition-none"
        style={{ width, transition, opacity: phase === 'idle' || phase === 'done' ? 0 : 1 }}
      />
    </div>
  )
}
