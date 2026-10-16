'use client'

import PageErrorFallback from '@/components/PageErrorFallback'
import './globals.css'

/**
 * Last-resort boundary: an error in the root layout itself. Replaces Next's
 * bare "This page couldn't load" with the same one automatic reload as every
 * other page (src/lib/recover-once.ts). Must render its own <html>/<body>.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0b0d12', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' }}>
        <PageErrorFallback error={error} reset={reset} />
      </body>
    </html>
  )
}
