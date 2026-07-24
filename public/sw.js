// TapeScore service worker — conservative caching so installing the PWA never
// serves stale app code (the #1 way a naive SW breaks a Next.js app).
//
// Strategy:
//   - Content-hashed assets (/_next/static) → cache-first. Safe: the filename
//     changes when the content does, so a cached copy is never stale.
//   - STABLE-named static assets (/brand, /icons) → stale-while-revalidate.
//     These keep the SAME filename across a rebrand (tapescore-favicon.svg,
//     apple-touch-icon.png…), so cache-first would pin the OLD logo forever
//     (the exact bug that left mobile on the pre-film-frame mark). SWR serves
//     the cached copy fast but refreshes in the background, so a changed asset
//     shows up on the next load instead of being frozen.
//   - Everything else (HTML navigations, RSC payloads) → network-first, with a
//     cached fallback only when offline. Never serve stale HTML from cache.
//   - /api/* → pass straight through (never cached).
//
// Bump CACHE on any change to this file / caching strategy so `activate` purges
// every prior cache (this is what evicts already-pinned stale brand assets).
const CACHE = 'tapescore-v2'

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

  // Content-hashed → cache-first (filename changes with content).
  if (url.pathname.startsWith('/_next/static/')) {
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

  // Stable-named static (may change under the same filename) → stale-while-
  // revalidate: fast from cache, but always refresh in the background so a
  // rebrand/icon change lands on the next load and is never pinned.
  if (url.pathname.startsWith('/brand/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(req)
        const fetching = fetch(req).then((res) => {
          cache.put(req, res.clone())
          return res
        })
        if (cached) {
          event.waitUntil(fetching.catch(() => {})) // refresh in background
          return cached
        }
        return fetching
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
