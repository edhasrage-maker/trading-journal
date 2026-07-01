'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Upload, PencilLine, BarChart2, Loader2, AlertTriangle } from 'lucide-react'

/**
 * First-run empty-state card with drag-and-drop import. Dropping (or picking) a
 * trade file uploads it straight to /api/import-trades-csv and, on success,
 * refreshes the dashboard — the server component re-renders past this empty
 * state into the populated dashboard. The full /import page (template,
 * instructions, Sierra details) is still one click away via "More options".
 */
export default function EmptyStateImport({ today }: { today: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      // Read Sierra's naive timestamps in the uploader's timezone, not the server's.
      fd.append('tz', Intl.DateTimeFormat().resolvedOptions().timeZone)
      const res = await fetch('/api/import-trades-csv', { method: 'POST', body: fd })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error || 'Import failed.'); return }
      if ((json.imported ?? 0) === 0) {
        setError('No new trades were imported (they may already be in your journal).')
        return
      }
      router.refresh() // account now has data → dashboard renders past the empty state
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function onPick(files: FileList | null) {
    const f = files?.[0]
    if (f) upload(f)
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); if (!busy) onPick(e.dataTransfer.files) }}
      className={`rounded-xl border p-10 text-center transition-colors ${
        dragOver ? 'border-blue-500 border-dashed bg-blue-950/30' : 'border-gray-800 bg-gray-900'
      }`}
    >
      <div className="mx-auto w-12 h-12 rounded-full bg-blue-600/20 flex items-center justify-center mb-4">
        <BarChart2 className="w-6 h-6 text-blue-400" />
      </div>
      <h2 className="text-xl font-semibold text-white">Welcome — let&apos;s get your trades in</h2>
      <p className="text-gray-400 text-sm mt-2 max-w-md mx-auto">
        Your journal is empty. Import a trade-history CSV to see your analytics,
        equity curve, and edge breakdowns from day one — or log a trade by hand to start.
      </p>

      <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {busy ? 'Importing…' : 'Import trades (CSV)'}
        </button>
        <Link
          href={`/intraday/${today}`}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-gray-700 bg-gray-800 text-gray-200 text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          <PencilLine className="w-4 h-4" /> Log a trade manually
        </Link>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={e => onPick(e.target.files)}
      />

      <p className="text-xs text-gray-500 mt-4">…or drag &amp; drop a CSV / Sierra Chart .txt anywhere on this card</p>

      {error && (
        <div className="mt-4 inline-flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      <p className="text-xs text-gray-600 mt-6">
        Exports from Sierra Chart, NinjaTrader, and Tradovate are supported.{' '}
        <Link href="/import" className="text-blue-400 hover:underline">More options →</Link>
      </p>
    </div>
  )
}
