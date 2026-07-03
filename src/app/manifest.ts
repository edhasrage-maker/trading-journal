import type { MetadataRoute } from 'next'

/**
 * PWA web app manifest (Next.js App Router auto-serves this at
 * /manifest.webmanifest and links it). Makes TapeScore installable to a phone
 * home screen as a standalone app. Icons live in public/icons (generated from
 * the brand mark). theme_color drives the mobile status-bar tint.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TapeScore',
    short_name: 'TapeScore',
    description: 'Game film for traders — an AI trading journal that reviews your game and captures more edge.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0d10',
    theme_color: '#1B1D21',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
