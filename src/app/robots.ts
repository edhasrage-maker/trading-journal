import type { MetadataRoute } from 'next'

/**
 * robots.txt (Next.js App Router auto-serves this at /robots.txt).
 *
 * Only the public marketing/legal surface is crawlable; every authenticated app
 * route is disallowed. (Those routes already redirect a logged-out crawler to
 * `/`, but declaring them keeps crawl budget off them and the intent explicit.)
 *
 * NB: /robots.txt, /sitemap.xml and /manifest.webmanifest must ALSO be excluded
 * from the proxy matcher (src/proxy.ts) or the auth redirect returns app HTML
 * here instead of plain text.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://tapescore.app'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/login', '/privacy', '/terms'],
      disallow: [
        '/api/',
        '/dashboard',
        '/prep',
        '/eod',
        '/intraday',
        '/analytics',
        '/calendar',
        '/weekly',
        '/settings',
        '/import',
        '/welcome',
        '/share',
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
