'use client'

import { Download } from 'lucide-react'

interface Props {
  /** Optional date range to scope the export. Both inclusive (YYYY-MM-DD). */
  from?: string
  to?: string
}

export default function CsvExportButton({ from, to }: Props) {
  const params = (type?: 'days') => {
    const p = new URLSearchParams()
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    if (type) p.set('type', type)
    return p.toString() ? '?' + p.toString() : ''
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={`/api/export-csv${params()}`}
        download
        className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        title="Download every trade in the current window — fills, tags, MFE/MAE, scaling-aware capture, ATR/RVOL at entry, 5m structure alignment, and the day's EOD verdict/score."
      >
        <Download className="w-3 h-3" />
        Export Trades
      </a>
      <a
        href={`/api/export-csv${params('days')}`}
        download
        className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
        title="Download a per-day summary — EOD process verdict, P1-P5 statuses, execution composite + sub-metrics, and the AI headlines."
      >
        <Download className="w-3 h-3" />
        Export Day Summary
      </a>
    </div>
  )
}
