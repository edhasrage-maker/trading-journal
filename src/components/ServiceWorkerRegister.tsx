'use client'

import { useEffect } from 'react'

/**
 * Registers the PWA service worker (public/sw.js). Production-only — in dev a
 * SW fights Turbopack hot-reload and caches stale chunks. Renders nothing.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {})
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])
  return null
}
