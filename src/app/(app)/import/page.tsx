'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { Upload, ArrowLeft, CheckCircle2, AlertTriangle, Loader2, Download } from 'lucide-react'
import { getHandle, setHandle } from '@/lib/file-handle-store'
import FirstReadCards from '@/components/dashboard/FirstReadCards'
import SierraAccountPicker from '@/components/import/SierraAccountPicker'
import { isSierraLogText, sierraAccountsInLog, filterSierraLogByAccounts, type SierraAccount } from '@/lib/sc-accounts'

// Key for the last-imported file handle in the IndexedDB handle store — passed
// back as showOpenFilePicker({ startIn }) so re-imports reopen at the same folder.
const LAST_IMPORT_HANDLE = 'import:last-file'

// Under Vercel's ~4.5 MB serverless request-body limit — a larger upload is
// rejected by the platform before our route runs (a bare, confusing failure).
const MAX_UPLOAD_BYTES = 4_000_000

// Minimal typing for the File System Access API (not in the TS DOM lib on all
// targets). Only the bits we use.
type ShowOpenFilePicker = (opts?: {
  startIn?: FileSystemHandle | string
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle[]>

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
  const [remembersFolder, setRemembersFolder] = useState(false)
  // True after a successful import that populated a previously-empty journal —
  // gates the post-import "first read" recap teaser (item 22).
  const [firstImport, setFirstImport] = useState(false)
  // A multi-account Sierra log awaiting the account choice before upload.
  const [pending, setPending] = useState<{ name: string; text: string; accounts: SierraAccount[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The File System Access API is Chromium-only; only then can we reopen the
  // picker at the last-used folder. Detect client-side so the hint is honest.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot client-only capability detect
    setRemembersFolder(typeof window !== 'undefined' && 'showOpenFilePicker' in window)
  }, [])

  // Open the file picker. On Chromium, start it in the folder of the last file
  // you imported (persisted handle) so re-uploading new logs lands you right
  // back there. Elsewhere, fall back to the classic hidden <input> (the browser
  // often reopens at the last folder on its own).
  async function pickFile() {
    const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker
    if (picker) {
      try {
        const last = await getHandle(LAST_IMPORT_HANDLE)
        const [handle] = await picker({
          startIn: last ?? 'downloads',
          multiple: false,
          types: [{ description: 'Trade log (CSV or Sierra .txt)', accept: { 'text/csv': ['.csv'], 'text/plain': ['.txt'] } }],
        })
        if (!handle) return
        void setHandle(LAST_IMPORT_HANDLE, handle) // remember this folder for next time
        void peekAndUpload(await handle.getFile())
        return
      } catch (e) {
        // AbortError = the user closed the picker; anything else → fall through.
        if ((e as DOMException)?.name === 'AbortError') return
      }
    }
    inputRef.current?.click()
  }

  // Peek at Sierra logs before upload: a copy-trading export carries many
  // accounts (too big to upload, and N× duplicated), so intercept and let the
  // trader pick which account to import. Everything else uploads directly.
  async function peekAndUpload(file: File) {
    setError(null)
    try {
      const text = await file.text()
      if (isSierraLogText(text)) {
        const accounts = sierraAccountsInLog(text)
        if (accounts.length > 1) { setPending({ name: file.name, text, accounts }); return }
      }
    } catch { /* fall through to a plain upload */ }
    void upload(file)
  }

  function confirmAccounts(selected: Set<string>) {
    if (!pending) return
    const filtered = filterSierraLogByAccounts(pending.text, selected)
    const base = pending.name.replace(/\.txt$/i, '')
    const file = new File([filtered], `${base}-filtered.txt`, { type: 'text/plain' })
    setPending(null)
    void upload(file)
  }

  async function upload(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${(file.size / 1e6).toFixed(1)} MB — over the ~4 MB upload limit. For a Sierra log, import a single account; otherwise export a shorter date range.`)
      return
    }
    setBusy(true); setError(null); setResult(null); setWarnings([]); setFirstImport(false)
    try {
      // Was the journal empty BEFORE this import? Decides whether this is the
      // tester's first import (→ arm the "first read" recap). Checked before the
      // upload so newly-inserted trades don't make every import look like a first.
      let wasEmpty = false
      try {
        const nav = await fetch('/api/nav-anchor').then(r => r.json())
        wasEmpty = nav?.lastTradeDate == null
      } catch { /* best-effort: treat as not-first so we never mis-arm */ }

      const fd = new FormData()
      fd.append('file', file)
      // Read Sierra's naive timestamps in the uploader's timezone, not the server's.
      fd.append('tz', Intl.DateTimeFormat().resolvedOptions().timeZone)
      const res = await fetch('/api/import-trades-csv', { method: 'POST', body: fd })
      const json = await res.json()
      if (Array.isArray(json.warnings)) setWarnings(json.warnings)
      if (!res.ok) { setError(json.error || 'Import failed.'); return }
      setResult(json as ImportResult)
      // First import that actually landed trades → arm the recap card (write-once
      // server-side) and reveal the inline teaser.
      if (wasEmpty && (json.imported ?? 0) > 0) {
        await fetch('/api/first-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'arm' }),
        }).catch(() => {})
        setFirstImport(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function onPick(files: FileList | null) {
    const file = files?.[0]
    if (file) void peekAndUpload(file)
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
    <div>
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
        onClick={() => void pickFile()}
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
        {remembersFolder && (
          <p className="text-[11px] text-gray-600 mt-2">Reopens at the folder you last imported from.</p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="hidden"
          onChange={e => onPick(e.target.files)}
        />
      </div>

      {pending && (
        <div className="mt-4">
          <SierraAccountPicker
            accounts={pending.accounts}
            busy={busy}
            onCancel={() => setPending(null)}
            onConfirm={confirmAccounts}
          />
        </div>
      )}

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

      {/* Post-import retroactive recap (item 22): on the tester's first import,
          tease the best/worst-day read right here so the product pays off before
          they even leave the import screen. */}
      {firstImport && (
        <div className="mt-6">
          <FirstReadCards variant="import" />
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
