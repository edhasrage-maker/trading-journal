import type { MetadataRoute } from 'next'

/**
 * sitemap.xml (Next.js App Router auto-serves this at /sitemap.xml).
 *
 * Only the public, crawlable pages — the landing, the login entry, and the two
 * legal pages. App routes are auth-gated and intentionally omitted (see
 * robots.ts). Must be excluded from the proxy matcher (src/proxy.ts) too, or the
 * auth redirect serves app HTML instead of XML.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://tapescore.app'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/login`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${SITE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/terms`, changeFrequency: 'yearly', priority: 0.3 },
  ]
}
