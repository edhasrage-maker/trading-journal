// TapeScore service worker — conservative caching so installing the PWA never
// serves stale app code (the #1 way a naive SW breaks a Next.js app).
//
// Strategy:
//   - Immutable, content-hashed assets (/_next/static, /icons, /brand) →
//     cache-first (safe: the filename changes when the content does).
//   - Everything else (HTML navigations, RSC payloads) → network-first, with a
//     cached fallback only when offline. Never serve stale HTML from cache.
//   - /api/* → pass straight through (never cached).
const CACHE = 'tapescore-v1'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return // never cache API

  const immutable =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/brand/')

  if (immutable) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        const res = await fetch(req)
        const cache = await caches.open(CACHE)
        cache.put(req, res.clone())
        return res
      })(),
    )
    return
  }

  // Network-first for HTML/navigations; fall back to cache only when offline.
  event.respondWith(
    (async () => {
      try {
        return await fetch(req)
      } catch {
        const cached = await caches.match(req)
        if (cached) return cached
        throw new Error('offline and not cached')
      }
    })(),
  )
})
