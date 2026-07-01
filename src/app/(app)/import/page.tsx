'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { Upload, ArrowLeft, CheckCircle2, AlertTriangle, Loader2, Download } from 'lucide-react'

interface ImportResult {
  imported: number
  parsed: number
  days: number
  total: number
  skipped: number
  warnings: string[]
}

// Canonical column set the generic CSV parser understands. Used for the
// downloadable manual-entry template. Two example rows (a winning long + a
// losing short) show the expected shape; users replace them with their trades.
const TEMPLATE_HEADERS =
  'Date,Symbol,Side,Quantity,EntryPrice,ExitPrice,EntryTime,ExitTime,PnL,Stop,MAE,MFE'
const TEMPLATE_ROWS = [
  '2026-06-29,MNQU6,long,3,29716.00,29723.75,2026-06-29 08:04:00,2026-06-29 08:10:00,45.00,29700.00,,',
  '2026-06-29,MNQU6,short,2,29840.00,29854.00,2026-06-29 09:00:00,2026-06-29 09:00:39,-56.00,29860.00,,',
]

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
      // Read Sierra's naive timestamps in the uploader's timezone, not the server's.
      fd.append('tz', Intl.DateTimeFormat().resolvedOptions().timeZone)
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

  function downloadTemplate() {
    const csv = [TEMPLATE_HEADERS, ...TEMPLATE_ROWS].join('\n') + '\n'
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'trade-import-template.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      <h1 className="text-2xl font-bold text-white">Import trades</h1>
      <p className="text-gray-400 text-sm mt-1">
        Upload a trade-history export — a CSV from another journal (NinjaTrader, Tradovate, Tradezella),
        or a Sierra Chart trade-activity log (<code className="text-gray-300">.txt</code>). We&apos;ll match your
        entries, exits, P&amp;L, and — when the export includes them — MAE/MFE.
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
          {busy ? 'Importing…' : 'Drop a CSV or Sierra Chart .txt here, or click to choose a file'}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          .csv from NinjaTrader / Tradovate / Tradezella · .txt from Sierra Chart · or a filled-in template
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
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

      {/* Manual entry: download a template CSV, fill it in, drop it back above. */}
      <div className="mt-8 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-white">Prefer to enter trades by hand?</h2>
            <p className="text-xs text-gray-400 mt-1">
              Download the template, fill in one row per trade, and drop the saved CSV back in above.
            </p>
          </div>
          <button
            type="button"
            onClick={downloadTemplate}
            className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-200 text-sm font-medium hover:bg-gray-700 transition-colors"
          >
            <Download className="w-4 h-4" /> Download template
          </button>
        </div>

        <div className="mt-4 border-t border-gray-800 pt-4">
          <p className="text-xs font-medium text-gray-300">Columns</p>
          <ul className="mt-2 text-xs text-gray-400 space-y-1">
            <li><span className="text-gray-300 font-mono">Date</span> — trade day, <span className="font-mono">YYYY-MM-DD</span> (optional if EntryTime/ExitTime are filled)</li>
            <li><span className="text-gray-300 font-mono">Symbol</span> — e.g. <span className="font-mono">MNQU6</span> or <span className="font-mono">MNQ</span></li>
            <li><span className="text-gray-300 font-mono">Side</span> — <span className="font-mono">long</span> or <span className="font-mono">short</span> (buy/sell also accepted)</li>
            <li><span className="text-gray-300 font-mono">Quantity</span> — number of contracts</li>
            <li><span className="text-gray-300 font-mono">EntryPrice / ExitPrice</span> — average fill prices</li>
            <li><span className="text-gray-300 font-mono">EntryTime / ExitTime</span> — <span className="font-mono">YYYY-MM-DD HH:MM:SS</span> (optional)</li>
            <li><span className="text-gray-300 font-mono">PnL</span> — net $ for the trade (optional if entry &amp; exit prices are given)</li>
            <li><span className="text-gray-300 font-mono">Stop</span> — stop price (optional)</li>
            <li><span className="text-gray-300 font-mono">MAE / MFE</span> — worst / best excursion in <em>price points</em> (optional; powers heat &amp; capture stats)</li>
          </ul>
          <p className="mt-3 text-xs text-gray-500">
            Minimum per row: a <span className="font-mono">Date</span> (or Entry/Exit time) plus either both prices or a P&amp;L.
            Extra columns are ignored, so you can leave optional ones blank.
          </p>
        </div>
      </div>

      <p className="text-xs text-gray-600 mt-6">
        Beta note: the importer recognizes Sierra Chart trade-activity logs and common
        NinjaTrader / Tradovate / Tradezella CSV layouts. If your export isn&apos;t recognized,
        it&apos;ll tell you — send a sample and we&apos;ll add support.
      </p>
    </div>
  )
}
