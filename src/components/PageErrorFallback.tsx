'use client'

import { useEffect, useState } from 'react'
import { reloadOnce, isStaleBuildError } from '@/lib/recover-once'

/**
 * What a page shows when it fails to render. First it reloads once on its own
 * (src/lib/recover-once.ts) — a stale tab after a deploy is the common cause and
 * a reload fixes it. Only if the page fails again within a minute does the
 * trader see this, with the actual error so it can be tracked down.
 */
export default function PageErrorFallback({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const [reloading, setReloading] = useState(true)
  useEffect(() => {
    console.error('[page error]', error)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reload decision reads sessionStorage, so it can only be made after mount
    if (!reloadOnce()) setReloading(false)
  }, [error])

  if (reloading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center text-sm text-gray-500">
        Loading the latest version…
      </div>
    )
  }
  return (
    <div className="min-h-[40vh] flex flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-base font-semibold text-gray-200">This page couldn&apos;t load</p>
      <p className="text-sm text-gray-500 max-w-md">
        {isStaleBuildError(error)
          ? 'TapeScore was updated while this page was open. Reload to get the new version.'
          : 'Something went wrong while loading it. Reloading usually fixes it.'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-sm font-medium rounded-md px-3 py-1.5 bg-blue-600 text-white hover:bg-blue-500"
        >
          Reload
        </button>
        {reset && (
          <button
            type="button"
            onClick={() => reset()}
            className="text-sm rounded-md px-3 py-1.5 border border-gray-700 text-gray-300 hover:border-gray-500"
          >
            Try again
          </button>
        )}
      </div>
      <p className="text-[11px] text-gray-600 max-w-md break-words">
        {error?.message || 'Unknown error'}{error?.digest ? ` · ref ${error.digest}` : ''}
      </p>
    </div>
  )
}
