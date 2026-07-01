'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { Upload, ArrowLeft, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'

interface ImportResult {
  imported: number
  parsed: number
  days: number
  total: number
  skipped: number
  warnings: string[]
}

export default function ImportPage() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function upload(file: File) {
    setBusy(true); setError(null); setResult(null); setWarnings([])
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/import-trades-csv', { method: 'POST', body: fd })
      const json = await res.json()
      if (Array.isArray(json.warnings)) setWarnings(json.warnings)
      if (!res.ok) setError(json.error || 'Import failed.')
      else setResult(json as ImportResult)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function onPick(files: FileList | null) {
    const file = files?.[0]
    if (file) upload(file)
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      <h1 className="text-2xl font-bold text-white">Import trades</h1>
      <p className="text-gray-400 text-sm mt-1">
        Upload a trade-history CSV exported from NinjaTrader, Tradovate, or another platform.
        We&apos;ll match your entries, exits, P&amp;L, and — when the export includes them — MAE/MFE.
      </p>

      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); onPick(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        className={`mt-6 cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragOver ? 'border-blue-500 bg-blue-950/30' : 'border-gray-700 bg-gray-900 hover:border-gray-600'
        }`}
      >
        <Upload className="w-8 h-8 text-gray-500 mx-auto" />
        <p className="text-sm text-gray-300 mt-3 font-medium">
          {busy ? 'Importing…' : 'Drop a CSV here, or click to choose a file'}
        </p>
        <p className="text-xs text-gray-500 mt-1">.csv exports from NinjaTrader, Tradovate, etc.</p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={e => onPick(e.target.files)}
        />
      </div>

      {busy && (
        <div className="mt-4 flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Parsing and importing…
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-800 bg-red-950/30 p-4">
          <div className="flex items-center gap-2 text-red-400 font-medium text-sm">
            <AlertTriangle className="w-4 h-4" /> {error}
          </div>
          {warnings.length > 0 && (
            <ul className="mt-2 text-xs text-red-300/80 list-disc list-inside space-y-1">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-lg border border-green-800 bg-green-950/30 p-4">
          <div className="flex items-center gap-2 text-green-400 font-medium text-sm">
            <CheckCircle2 className="w-4 h-4" />
            Imported {result.imported} trade{result.imported === 1 ? '' : 's'} across{' '}
            {result.days} day{result.days === 1 ? '' : 's'}.
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {result.parsed} parsed · {result.skipped} skipped of {result.total} rows.
          </p>
          {warnings.length > 0 && (
            <ul className="mt-2 text-xs text-amber-300/80 list-disc list-inside space-y-1">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <Link href="/dashboard" className="inline-block mt-3 text-sm text-blue-400 hover:text-blue-300">
            View your dashboard →
          </Link>
        </div>
      )}

      <p className="text-xs text-gray-600 mt-8">
        Beta note: the importer recognizes common NinjaTrader/Tradovate column layouts. If your
        export isn&apos;t recognized, it&apos;ll tell you — send a sample and we&apos;ll add support.
      </p>
    </div>
  )
}
