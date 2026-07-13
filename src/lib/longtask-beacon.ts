'use client'

import { useEffect } from 'react'

/**
 * Lightweight long-task beacon.
 *
 * The founder observed two ~10-minute renderer hangs on /analytics (2026-07-12)
 * that did NOT reproduce under instrumentation. There is no way to see a real
 * user hitting that hang after the fact — so this observes the browser's
 * `longtask` entries (main-thread blocks ≥ 50ms) while the page is open and,
 * when the blocking is bad enough to notice, POSTs a small summary via
 * `navigator.sendBeacon`. The endpoint just logs it, so a production hang shows
 * up in the Vercel function logs instead of being invisible.
 *
 * Deliberately cheap and fail-open:
 *  - Feature-detected (`longtask` is unsupported in Safari/Firefox → no-op).
 *  - No per-task network chatter: it accumulates and flushes at most once, on
 *    page hide / unload (the standard beacon moment), plus an immediate flush
 *    for a single egregious task (> `IMMEDIATE_MS`) so a tab killed mid-hang
 *    still reports.
 *  - Never throws into render; everything is wrapped.
 */

// A single task this long is a user-visible jank spike worth reporting now,
// even if the tab is closed before the page-hide flush fires.
const IMMEDIATE_MS = 1000
// Below this total blocking time the page felt fine — don't beacon at all.
const MIN_TOTAL_BLOCKING_MS = 200

export interface LongTaskContext {
  /** Logical route label, e.g. "/analytics". */
  route: string
  /** Optional extra context (range preset, trade count, mode…) for triage. */
  meta?: Record<string, string | number | boolean | null | undefined>
}

export function useLongTaskBeacon({ route, meta }: LongTaskContext) {
  // Serialize meta into a stable dep so we don't re-subscribe on every render
  // when the caller passes an inline object.
  const metaKey = meta ? JSON.stringify(meta) : ''
  useEffect(() => {
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return
    // `longtask` support check — construct+observe inside try/catch because an
    // unsupported entryType throws on some engines.
    let observer: PerformanceObserver | null = null
    let count = 0
    let longest = 0
    let totalBlocking = 0 // sum of (duration − 50), the TBT convention
    let flushed = false

    const send = (reason: 'hidden' | 'spike') => {
      if (flushed || count === 0 || totalBlocking < MIN_TOTAL_BLOCKING_MS) return
      flushed = true
      try {
        const payload = JSON.stringify({
          route,
          reason,
          count,
          longestMs: Math.round(longest),
          totalBlockingMs: Math.round(totalBlocking),
          meta: meta ?? null,
          ua: navigator.userAgent,
          at: new Date().toISOString(),
        })
        // sendBeacon survives page unload; fall back to a keepalive fetch.
        if (navigator.sendBeacon) {
          navigator.sendBeacon('/api/telemetry/longtask', new Blob([payload], { type: 'application/json' }))
        } else {
          void fetch('/api/telemetry/longtask', { method: 'POST', body: payload, keepalive: true, headers: { 'Content-Type': 'application/json' } })
        }
      } catch { /* telemetry is best-effort — never disrupt the page */ }
    }

    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          count++
          if (entry.duration > longest) longest = entry.duration
          totalBlocking += Math.max(0, entry.duration - 50)
          if (entry.duration >= IMMEDIATE_MS) send('spike')
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch { return }

    const onHide = () => { if (document.visibilityState === 'hidden') send('hidden') }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', () => send('hidden'))

    return () => {
      try { observer?.disconnect() } catch { /* ignore */ }
      document.removeEventListener('visibilitychange', onHide)
      // Best-effort flush on route-away (component unmount) too.
      send('hidden')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaKey captures meta; route is stable
  }, [route, metaKey])
}
