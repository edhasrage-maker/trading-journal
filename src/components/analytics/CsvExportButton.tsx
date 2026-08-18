'use client'

import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { saveFileFromUrl } from '@/lib/save-file'

interface Props {
  /** Optional date range to scope the export. Both inclusive (YYYY-MM-DD). */
  from?: string
  to?: string
}

/**
 * The two CSV exports.
 *
 * These were plain `<a download>` links, which is a desktop-only assumption —
 * on a phone the tap did nothing visible. They now fetch the file and hand it
 * to the platform (share sheet on mobile, ordinary download elsewhere); see
 * lib/save-file.
 */
export default function CsvExportButton({ from, to }: Props) {
  const [busy, setBusy] = useState<'trades' | 'days' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const params = (type?: 'days') => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (type) p.set('type', type)
    return p.toString() ? '?' + p.toString() : ''
  }

  const run = async (kind: 'trades' | 'days') => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      const url = `/api/export-csv${params(kind === 'days' ? 'days' : undefined)}`
      const stamp = to ?? new Date().toISOString().slice(0, 10)
      await saveFileFromUrl(url, kind === 'days' ? `day-summary-${stamp}.csv` : `trades-${stamp}.csv`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  const btn = 'flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed'

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run('trades')}
          disabled={busy !== null}
          className={btn}
          title="Download every trade in the current window — fills, tags, MFE/MAE, scaling-aware capture, ATR/RVOL at entry, 5m structure alignment, and the day's EOD verdict/score."
        >
          {busy === 'trades' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          {busy === 'trades' ? 'Preparing…' : 'Export Trades'}
        </button>
        <button
          type="button"
          onClick={() => void run('days')}
          disabled={busy !== null}
          className={btn}
          title="Download a per-day summary — EOD process verdict, P1-P5 statuses, execution composite + sub-metrics, and the AI headlines."
        >
          {busy === 'days' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          {busy === 'days' ? 'Preparing…' : 'Export Day Summary'}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-300 max-w-[260px] text-right">{error}</p>}
    </div>
  )
}
