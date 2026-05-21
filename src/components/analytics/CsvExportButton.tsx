'use client'

import { Download } from 'lucide-react'

interface Props {
  /** Optional date range to scope the export. Both inclusive (YYYY-MM-DD). */
  from?: string
  to?: string
}

export default function CsvExportButton({ from, to }: Props) {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const href = `/api/export-csv${params.toString() ? '?' + params.toString() : ''}`

  return (
    <a
      href={href}
      download
      className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
      title="Download all trades in the current window as CSV"
    >
      <Download className="w-3 h-3" />
      Export CSV
    </a>
  )
}
