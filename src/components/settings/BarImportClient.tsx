'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Upload, Loader2, CandlestickChart, AlertCircle, CheckCircle2, HardDrive } from 'lucide-react'
import type { BarImport, BarGranularity } from '@/lib/supabase/types'

interface ScidFile { name: string; sizeBytes: number; mtimeMs?: number }
interface ScidImportResponse { upserted: number; tickCount: number; symbol: string; date: string; scidFile: string }

interface ImportResponse {
  upserted: number
  symbol: string
  granularity: BarGranularity
  dateRangeStart: string | null
  dateRangeEnd: string | null
  parseErrors?: string[]
}

interface Props {
  initialImports: BarImport[]
}

const GRANULARITIES: BarGranularity[] = ['1m', '5m', '15m', '1h', '1d']

export default function BarImportClient({ initialImports }: Props) {
  const router = useRouter()
  const [imports, setImports] = useState<BarImport[]>(initialImports)
  const [symbol, setSymbol] = useState('')
  const [granularity, setGranularity] = useState<BarGranularity>('1m')
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<{ ok: true; data: ImportResponse } | { ok: false; error: string; parseErrors?: string[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // --- Sierra SCID direct-import state ---
  const [scidFiles, setScidFiles] = useState<ScidFile[]>([])
  const [scidDir, setScidDir] = useState<string>('')
  const [scidFile, setScidFile] = useState('')
  const [scidStoreAs, setScidStoreAs] = useState('')
  const [scidDate, setScidDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [scidImporting, setScidImporting] = useState(false)
  const [scidResult, setScidResult] = useState<{ ok: true; data: ScidImportResponse } | { ok: false; error: string; hint?: string } | null>(null)

  // Load available .scid files on mount.
  useEffect(() => {
    fetch('/api/bars/import-scid')
      .then(r => r.json())
      .then(d => {
        setScidFiles(d.files ?? [])
        if (d.dir) setScidDir(d.dir)
      })
      .catch(() => { /* surface nothing; section just shows empty */ })
  }, [])

  // When a SCID file is picked, prefill store-as with its symbol root.
  const onPickScid = (name: string) => {
    setScidFile(name)
    setScidResult(null)
    if (!scidStoreAs) setScidStoreAs(name.replace(/\.scid$/i, ''))
  }

  const submitScid = useCallback(async () => {
    if (!scidFile || !scidStoreAs.trim() || !scidDate) return
    setScidImporting(true)
    setScidResult(null)
    try {
      const res = await fetch('/api/bars/import-scid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scidFile, storeAs: scidStoreAs.trim(), date: scidDate }),
      })
      const data = await res.json()
      if (!res.ok) {
        setScidResult({ ok: false, error: data.error ?? 'Unknown error', hint: data.hint })
        return
      }
      setScidResult({ ok: true, data: data as ScidImportResponse })
      const histRes = await fetch('/api/bars/import')
      if (histRes.ok) setImports(await histRes.json())
      router.refresh()
    } catch (e) {
      setScidResult({ ok: false, error: e instanceof Error ? e.message : 'Network error' })
    } finally {
      setScidImporting(false)
    }
  }, [scidFile, scidStoreAs, scidDate, router])

  const scidCanSubmit = !!scidFile && scidStoreAs.trim().length > 0 && !!scidDate && !scidImporting

  const handleFile = (f: File) => {
    setFile(f)
    setResult(null)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }
  const onDragLeave = () => setDragging(false)

  const submit = useCallback(async () => {
    if (!file || !symbol.trim()) return
    setUploading(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('symbol', symbol.trim())
      fd.append('granularity', granularity)
      const res = await fetch('/api/bars/import', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        setResult({ ok: false, error: data.error ?? 'Unknown error', parseErrors: data.parseErrors })
        return
      }
      setResult({ ok: true, data: data as ImportResponse })
      setFile(null)
      if (inputRef.current) inputRef.current.value = ''
      // Refresh import history
      const histRes = await fetch('/api/bars/import')
      if (histRes.ok) setImports(await histRes.json())
      router.refresh()
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'Network error' })
    } finally {
      setUploading(false)
    }
  }, [file, symbol, granularity, router])

  const canSubmit = !!file && symbol.trim().length > 0 && !uploading

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <CandlestickChart className="w-6 h-6 text-blue-400" />
          Bar Data
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          Import OHLCV bars per symbol. Once imported, native charts on EOD / Intraday / Dashboard pages
          can render directly from these bars instead of relying on screenshots + calibration.
        </p>
      </div>

      {/* Sierra SCID direct import — preferred: reads the file Sierra auto-saves */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white text-sm">Import from Sierra Chart (.scid)</h2>
        </div>
        <p className="text-xs text-gray-500">
          Reads the intraday file Sierra continuously auto-saves — no manual export. Aggregates tick
          data into 1-minute bars on the server.
          {scidDir && <span className="block mt-1 font-mono text-gray-600">{scidDir}</span>}
        </p>

        {scidFiles.length === 0 ? (
          <div className="text-xs text-yellow-300/80 bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-3">
            No .scid files found. Confirm Sierra&apos;s data directory — set <code className="text-yellow-200">SIERRA_DATA_DIR</code> in
            <code className="text-yellow-200"> .env.local</code> if it isn&apos;t <code className="text-yellow-200">D:\SierraCharts\Data</code>, then restart the dev server.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-400 mb-1">Source .scid file</label>
                <select
                  value={scidFile}
                  onChange={e => onPickScid(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select a file…</option>
                  {scidFiles.map(f => (
                    <option key={f.name} value={f.name}>
                      {f.name} ({(f.sizeBytes / 1e6).toFixed(0)} MB{f.mtimeMs ? ` · updated ${format(new Date(f.mtimeMs), 'MMM d')}` : ''})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Day</label>
                <input
                  type="date"
                  value={scidDate}
                  onChange={e => { setScidDate(e.target.value); setScidResult(null) }}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs text-gray-400 mb-1">Store bars under symbol</label>
                <input
                  type="text"
                  value={scidStoreAs}
                  onChange={e => setScidStoreAs(e.target.value)}
                  placeholder="MNQM6.CME"
                  spellCheck={false}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <p className="text-[10px] text-gray-500 mt-1">
                  Must match the symbol on the trades you want to chart. E.g., read <span className="font-mono">NQM6.CME.scid</span> but
                  store as <span className="font-mono">MNQM6.CME</span> — NQ &amp; MNQ share identical prices.
                </p>
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={submitScid}
                  disabled={!scidCanSubmit}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {scidImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />}
                  {scidImporting ? 'Reading…' : 'Import day'}
                </button>
              </div>
            </div>

            {scidResult?.ok && (
              <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-sm text-green-200 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  Imported <strong>{scidResult.data.upserted.toLocaleString()}</strong> 1m bars
                  for <span className="font-mono">{scidResult.data.symbol}</span> on {scidResult.data.date}
                  {' '}from <span className="font-mono">{scidResult.data.scidFile}</span>
                  {' '}(aggregated {scidResult.data.tickCount.toLocaleString()} ticks).
                </div>
              </div>
            )}
            {scidResult && !scidResult.ok && (
              <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">{scidResult.error}</p>
                  {scidResult.hint && <p className="text-xs text-red-200/70 mt-1">{scidResult.hint}</p>}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Manual CSV upload — fallback for non-Sierra platforms */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h2 className="font-semibold text-white text-sm">Import bars from CSV</h2>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Symbol</label>
            <input
              type="text"
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              placeholder="MNQM6.CME"
              spellCheck={false}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-gray-500 mt-1">Match the symbol on your trades (e.g., what Sierra writes).</p>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Granularity</label>
            <select
              value={granularity}
              onChange={e => setGranularity(e.target.value as BarGranularity)}
              className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {GRANULARITIES.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-500 mt-1">1m is canonical; coarser granularities aggregate on the fly.</p>
          </div>
        </div>

        {/* File drop / pick */}
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-2 cursor-pointer transition-colors ${
            dragging ? 'border-blue-500 bg-blue-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-900/50'
          }`}
        >
          <Upload className="w-6 h-6 text-gray-500" />
          {file ? (
            <>
              <p className="text-sm text-white font-mono">{file.name}</p>
              <p className="text-[10px] text-gray-500">{(file.size / 1024).toFixed(1)} KB · click or drop another file to replace</p>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-300">Drop CSV here or click to select</p>
              <p className="text-[10px] text-gray-500">Required columns: timestamp, open, high, low, close (volume optional)</p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-[10px] text-gray-500">
            Header row required. Tolerant of <code className="text-gray-400">Date Time</code>, <code className="text-gray-400">ts</code>,
            split <code className="text-gray-400">Date</code>+<code className="text-gray-400">Time</code>,
            and short aliases (<code className="text-gray-400">o/h/l/c/v</code>).
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Importing…' : 'Import'}
          </button>
        </div>

        {/* Result */}
        {result?.ok && (
          <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-sm text-green-200 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              Imported <strong>{result.data.upserted.toLocaleString()}</strong> {result.data.granularity} bars
              for <span className="font-mono">{result.data.symbol}</span>
              {result.data.dateRangeStart && result.data.dateRangeEnd && (
                <> — {result.data.dateRangeStart} → {result.data.dateRangeEnd}</>
              )}.
              {result.data.parseErrors && result.data.parseErrors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-yellow-300">
                    {result.data.parseErrors.length} row{result.data.parseErrors.length === 1 ? '' : 's'} skipped (click to view)
                  </summary>
                  <ul className="mt-1 text-[10px] text-yellow-200/80 list-disc pl-4 space-y-0.5">
                    {result.data.parseErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}
        {result && !result.ok && (
          <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{result.error}</p>
              {result.parseErrors && result.parseErrors.length > 0 && (
                <ul className="mt-2 text-[10px] text-red-200/80 list-disc pl-4 space-y-0.5">
                  {result.parseErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Import history */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <h2 className="font-semibold text-white text-sm">Recent imports</h2>
        {imports.length === 0 ? (
          <p className="text-gray-500 text-sm">No imports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left font-normal py-2 pr-3">When</th>
                  <th className="text-left font-normal py-2 pr-3">Symbol</th>
                  <th className="text-left font-normal py-2 pr-3">Granularity</th>
                  <th className="text-left font-normal py-2 pr-3">Range</th>
                  <th className="text-right font-normal py-2 pr-3">Bars</th>
                  <th className="text-left font-normal py-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {imports.map(imp => (
                  <tr key={imp.id} className="border-b border-gray-800/60 text-gray-300">
                    <td className="py-2 pr-3 font-mono text-gray-400">
                      {format(new Date(imp.imported_at), 'MMM d, HH:mm')}
                    </td>
                    <td className="py-2 pr-3 font-mono">{imp.symbol}</td>
                    <td className="py-2 pr-3">{imp.granularity}</td>
                    <td className="py-2 pr-3 font-mono text-gray-400">
                      {imp.date_range_start} → {imp.date_range_end}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{imp.rows_inserted?.toLocaleString() ?? '—'}</td>
                    <td className="py-2 font-mono text-gray-500 truncate max-w-xs">{imp.source_filename ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
