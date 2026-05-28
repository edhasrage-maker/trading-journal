'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Radio, Loader2 } from 'lucide-react'

/**
 * Background bar auto-importer (the "bars watcher").
 *
 * While any page hosting this component is open, it POSTs to
 * /api/bars/auto-import every few minutes (and once on mount). The server
 * re-derives each charted symbol's source .scid and re-imports the current day
 * — so today's bars stay fresh without ever opening Settings → Bar Data.
 *
 * Unlike the trade-log watcher this needs no File System Access permission:
 * the Next.js server reads the .scid directly (it runs on the same machine as
 * Sierra). The logged-in session cookie authenticates the request.
 *
 * Renders a compact live/updating status chip. When an import touches the
 * `activeDate` (the day currently being charted), it calls onRefresh so the
 * open chart can re-fetch and show the new bars.
 */

const POLL_MS = 180_000 // 3 minutes

interface AutoImportResult {
  date: string
  totalUpserted?: number
  results?: Array<{ symbol: string; scidFile: string; upserted?: number; error?: string }>
  note?: string
}

interface Props {
  /** The day currently being viewed; a refresh fires only when this day updates. */
  activeDate: string
  /** Called after a successful poll that imported bars for activeDate. */
  onRefresh?: () => void
}

export default function BarWatcher({ activeDate, onRefresh }: Props) {
  const [status, setStatus] = useState<'idle' | 'working' | 'ok' | 'error' | 'nomap'>('idle')
  const [lastInfo, setLastInfo] = useState<string>('Starting…')
  // Keep the latest activeDate/onRefresh available to the interval without
  // re-subscribing (which would reset the timer on every render).
  const activeDateRef = useRef(activeDate)
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => { activeDateRef.current = activeDate }, [activeDate])
  useEffect(() => { onRefreshRef.current = onRefresh }, [onRefresh])

  const poll = useCallback(async () => {
    setStatus('working')
    try {
      const res = await fetch('/api/bars/auto-import', { method: 'POST' })
      const data = (await res.json()) as AutoImportResult & { error?: string }
      if (!res.ok) {
        setStatus('error')
        setLastInfo(data.error ?? 'Import failed')
        return
      }
      if (data.note && (!data.results || data.results.length === 0)) {
        setStatus('nomap')
        setLastInfo(data.note)
        return
      }
      const total = data.totalUpserted ?? 0
      const syms = (data.results ?? []).filter(r => r.upserted).map(r => r.symbol)
      setStatus('ok')
      setLastInfo(
        total > 0
          ? `${total.toLocaleString()} bars · ${syms.join(', ')} · ${new Date().toLocaleTimeString()}`
          : `Up to date · ${new Date().toLocaleTimeString()}`,
      )
      // Refresh the open chart if today's poll covered the day being viewed.
      if (data.date === activeDateRef.current && total > 0) onRefreshRef.current?.()
    } catch (e) {
      setStatus('error')
      setLastInfo(e instanceof Error ? e.message : 'Network error')
    }
  }, [])

  useEffect(() => {
    // Kick the first poll on the next tick (not synchronously in the effect)
    // so the initial setState happens outside the effect's render phase.
    const kickoff = setTimeout(poll, 0)
    const id = setInterval(poll, POLL_MS)
    return () => { clearTimeout(kickoff); clearInterval(id) }
  }, [poll])

  const dot =
    status === 'working' ? 'text-blue-400'
      : status === 'ok' ? 'text-green-400'
        : status === 'error' ? 'text-red-400'
          : status === 'nomap' ? 'text-yellow-400'
            : 'text-gray-500'

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-gray-400 select-none"
      title={`Bar auto-import (every ${POLL_MS / 60000} min)\n${lastInfo}`}
    >
      {status === 'working'
        ? <Loader2 className={`w-3.5 h-3.5 animate-spin ${dot}`} />
        : <Radio className={`w-3.5 h-3.5 ${dot}`} />}
      <span className="hidden sm:inline">
        {status === 'nomap' ? 'Bars: import once' : status === 'error' ? 'Bars: error' : 'Bars: live'}
      </span>
    </div>
  )
}
