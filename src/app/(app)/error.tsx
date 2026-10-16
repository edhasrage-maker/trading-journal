'use client'

import PageErrorFallback from '@/components/PageErrorFallback'

/** Error boundary for every signed-in page — see src/lib/recover-once.ts. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <PageErrorFallback error={error} reset={reset} />
}
