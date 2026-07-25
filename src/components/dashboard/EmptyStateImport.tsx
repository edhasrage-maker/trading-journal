'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Upload, PencilLine, BarChart2, Loader2, AlertTriangle } from 'lucide-react'
import SierraAccountPicker from '@/components/import/SierraAccountPicker'
import { isSierraLogText, sierraAccountsInLog, filterSierraLogByAccounts, type SierraAccount } from '@/lib/sc-accounts'

// Under Vercel's ~4.5 MB serverless request-body limit — over this the platform
// rejects the upload before our route runs, surfacing only a bare failure.
const MAX_UPLOAD_BYTES = 4_000_000

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
  // A multi-account Sierra log awaiting the account choice before upload.
  const [pending, setPending] = useState<{ name: string; text: string; accounts: SierraAccount[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function postFile(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${(file.size / 1e6).toFixed(1)} MB — over the ~4 MB upload limit. For a Sierra log, import a single account; otherwise export a shorter date range.`)
      return
    }
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
      // This card only renders on an empty account, so a successful import here
      // is always the tester's first — arm the post-import "first read" recap
      // card (write-once server-side) before refreshing into the dashboard.
      await fetch('/api/first-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'arm' }),
      }).catch(() => {})
      router.refresh() // account now has data → dashboard renders past the empty state
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function onPick(files: FileList | null) {
    const f = files?.[0]
    if (!f) return
    setError(null)
    // Peek at Sierra logs: a copy-trading export carries many accounts, and
    // uploading it whole is both too big and N× duplicated. Let the user pick an
    // account and filter to it in the browser before upload.
    try {
      const text = await f.text()
      if (isSierraLogText(text)) {
        const accounts = sierraAccountsInLog(text)
        if (accounts.length > 1) { setPending({ name: f.name, text, accounts }); return }
      }
    } catch { /* fall through to a plain upload */ }
    void postFile(f)
  }

  function confirmAccounts(selected: Set<string>) {
    if (!pending) return
    const filtered = filterSierraLogByAccounts(pending.text, selected)
    const base = pending.name.replace(/\.txt$/i, '')
    const file = new File([filtered], `${base}-filtered.txt`, { type: 'text/plain' })
    setPending(null)
    void postFile(file)
  }

  return (
    <div
      data-tour="dash-import"
      onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); if (!busy) onPick(e.dataTransfer.files) }}
      className={`rounded-xl border p-6 sm:p-10 text-center transition-colors ${
        dragOver ? 'border-blue-500 border-dashed bg-blue-950/30' : 'border-gray-800 bg-gray-900'
      }`}
    >
      <div className="mx-auto w-12 h-12 rounded-full bg-blue-600/20 flex items-center justify-center mb-4">
        <BarChart2 className="w-6 h-6 text-blue-400" />
      </div>
      <h2 className="text-xl font-semibold text-white">Welcome — let&apos;s get your trades in</h2>
      <p className="text-gray-400 text-sm mt-2 max-w-md mx-auto">
        Your journal is empty. Import your trades and you&apos;ll see how you&apos;re doing —
        your P&amp;L, win rate, and best and worst days — right from the first file. No trades to
        import yet? Log one by hand to get started.
      </p>

      {pending ? (
        <div className="mt-6">
          <SierraAccountPicker
            accounts={pending.accounts}
            busy={busy}
            onCancel={() => setPending(null)}
            onConfirm={confirmAccounts}
          />
        </div>
      ) : (
        <>
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

          <p className="text-xs text-gray-500 mt-4">…or drag &amp; drop a CSV / Sierra Chart .txt anywhere on this card</p>
        </>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="hidden"
        onChange={e => onPick(e.target.files)}
      />

      {error && (
        <div className="mt-4 inline-flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      <p className="text-xs text-gray-600 mt-6">
        Exports from Sierra Chart, NinjaTrader, Tradezella, and Tradovate are supported.{' '}
        <Link href="/import" className="text-blue-400 hover:underline">More options →</Link>
      </p>
      <p className="text-xs text-gray-500 mt-2">
        New here? <Link href="/welcome" className="text-blue-400 hover:underline">Read the quick start →</Link>
      </p>
    </div>
  )
}
