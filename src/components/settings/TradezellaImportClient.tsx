'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { FileSpreadsheet, Loader2, AlertCircle, CheckCircle2, HardDrive, Activity, Upload } from 'lucide-react'

interface TzCsv { name: string; sizeBytes: number; mtimeMs: number }
interface ScidFile { name: string; sizeBytes: number; mtimeMs?: number }

interface BackfillResultRow {
  date: string
  status: 'inserted' | 'updated' | 'skipped' | 'failed'
  reason?: string
  metrics?: {
    rvol: number | null
    adr: number | null
    ib_size: number | null
    ib_vs_10d_avg: number | null
    atr_1m: number | null
  }
}
interface CsvImportRow {
  trade_date: string
  status: 'inserted' | 'updated' | 'skipped' | 'failed'
  reason?: string
}
interface CsvImportResponse {
  ok: true
  totalRows: number
  inserted: number
  updated: number
  skipped: number
  failed: number
  results: CsvImportRow[]
  dryRun: boolean
}

interface BackfillResponse {
  ok: true
  scidFile: string
  scidWindow: { start: string; end: string }
  totalHistoricalDates: number
  inRange: number
  outOfRange: number
  processed: number
  inserted: number
  updated: number
  skipped: number
  failed: number
  results: BackfillResultRow[]
  dryRun: boolean
}

interface AutoMergeSummary {
  clustersMerged: number
  totalVictimsFolded: number
  mergeResults: Array<{
    category: string
    canonical: string
    victims: string[]
    tradesUpdated: number
    historicalUpdated: number
  }>
}

interface ImportResult {
  ok: true
  file: string
  parsedRows: number
  upserted: number
  newTags: number
  tagsByCategory: Record<string, number>
  totalHistorical: number
  errors: string[]
  autoMerge: AutoMergeSummary | null
}

interface Props {
  totalHistorical: number
  latestTradeDate: string | null
  latestImportedAt: string | null
}

export default function TradezellaImportClient({ totalHistorical, latestTradeDate, latestImportedAt }: Props) {
  const router = useRouter()
  const [files, setFiles] = useState<TzCsv[]>([])
  const [dir, setDir] = useState<string>('')
  const [file, setFile] = useState<string>('')
  const [autoMerge, setAutoMerge] = useState(true)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ ok: true; data: ImportResult } | { ok: false; error: string } | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  // Backfill state — separate file dropdown over Sierra SCIDs + per-run options.
  const [scidFiles, setScidFiles] = useState<ScidFile[]>([])
  const [scidDir, setScidDir] = useState('')
  const [backfillScid, setBackfillScid] = useState('')
  const [backfillForce, setBackfillForce] = useState(false)
  const [backfillDryRun, setBackfillDryRun] = useState(true)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillResult, setBackfillResult] = useState<
    { ok: true; data: BackfillResponse } | { ok: false; error: string } | null
  >(null)

  // Cross-PC CSV import state — paste a filled docs/market-context-template.csv
  // produced by another Claude instance and write it to market_context.
  const [csvText, setCsvText] = useState('')
  const [csvDryRun, setCsvDryRun] = useState(true)
  const [csvForce, setCsvForce] = useState(false)
  const [csvRunning, setCsvRunning] = useState(false)
  const [csvResult, setCsvResult] = useState<
    { ok: true; data: CsvImportResponse } | { ok: false; error: string } | null
  >(null)

  // Scan the downloads dir on mount + after each import (so a newer export
  // shows up when the user re-runs).
  const scan = useCallback(async () => {
    try {
      const r = await fetch('/api/historical/import-tradezella')
      const d = await r.json()
      setFiles(d.files ?? [])
      setDir(d.dir ?? '')
      setScanError(d.error ?? null)
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Scan failed')
    }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot scan of the downloads dir on mount; same pattern as BarImportClient
  useEffect(() => { scan() }, [scan])

  // Scan Sierra SCID dir on mount for the backfill dropdown — reuses the same
  // listing endpoint as the BarImportClient SCID picker. Async setState inside
  // the .then() doesn't trip set-state-in-effect, so no disable needed here.
  useEffect(() => {
    fetch('/api/bars/import-scid')
      .then(r => r.json())
      .then(d => {
        setScidFiles(d.files ?? [])
        if (d.dir) setScidDir(d.dir)
      })
      .catch(() => { /* silent; UI shows empty list */ })
  }, [])

  const runBackfill = useCallback(async () => {
    if (!backfillScid) return
    setBackfillRunning(true)
    setBackfillResult(null)
    try {
      const r = await fetch('/api/historical/backfill-market-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scidFile: backfillScid, dryRun: backfillDryRun, force: backfillForce }),
      })
      const data = await r.json()
      if (!r.ok) {
        setBackfillResult({ ok: false, error: data.error ?? 'Unknown error' })
        return
      }
      setBackfillResult({ ok: true, data: data as BackfillResponse })
      if (!backfillDryRun) router.refresh()
    } catch (e) {
      setBackfillResult({ ok: false, error: e instanceof Error ? e.message : 'Network error' })
    } finally {
      setBackfillRunning(false)
    }
  }, [backfillScid, backfillDryRun, backfillForce, router])

  const canBackfill = !!backfillScid && !backfillRunning

  const runCsvImport = useCallback(async () => {
    if (!csvText.trim()) return
    setCsvRunning(true)
    setCsvResult(null)
    try {
      const r = await fetch('/api/historical/import-market-context-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, dryRun: csvDryRun, force: csvForce }),
      })
      const data = await r.json()
      if (!r.ok) {
        setCsvResult({ ok: false, error: data.error ?? 'Unknown error' })
        return
      }
      setCsvResult({ ok: true, data: data as CsvImportResponse })
      if (!csvDryRun) router.refresh()
    } catch (e) {
      setCsvResult({ ok: false, error: e instanceof Error ? e.message : 'Network error' })
    } finally {
      setCsvRunning(false)
    }
  }, [csvText, csvDryRun, csvForce, router])

  const canCsv = csvText.trim().length > 0 && !csvRunning

  const submit = useCallback(async () => {
    if (!file) return
    setImporting(true)
    setResult(null)
    try {
      const r = await fetch('/api/historical/import-tradezella', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, autoMerge }),
      })
      const data = await r.json()
      if (!r.ok) {
        setResult({ ok: false, error: data.error ?? 'Unknown error' })
        return
      }
      setResult({ ok: true, data: data as ImportResult })
      router.refresh()
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : 'Network error' })
    } finally {
      setImporting(false)
    }
  }, [file, autoMerge, router])

  const canSubmit = !!file && !importing

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <FileSpreadsheet className="w-6 h-6 text-blue-400" />
          Tradezella Re-import
        </h1>
        <p className="text-gray-400 text-sm mt-1">
          Re-import the latest Tradezella CSV export. The importer is idempotent on
          a per-trade dedup key — existing rows are updated, new ones inserted, and
          any unseen tag values are added to the library so they show up in the
          Analytics Tag Performance table.
        </p>
      </div>

      {/* Summary card */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard label="Historical rows" value={totalHistorical.toLocaleString()} />
        <SummaryCard label="Latest trade" value={latestTradeDate ?? '—'} />
        <SummaryCard
          label="Last import"
          value={latestImportedAt ? format(new Date(latestImportedAt), 'MMM d, HH:mm') : '—'}
        />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white text-sm">Import from CSV in Downloads</h2>
        </div>
        <p className="text-xs text-gray-500">
          Reads <span className="font-mono">trades_*.csv</span> exports from your downloads folder.
          {dir && <span className="block mt-1 font-mono text-gray-600">{dir}</span>}
        </p>

        {scanError && (
          <div className="text-xs text-yellow-300/80 bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-3">
            {scanError}
          </div>
        )}

        {!scanError && files.length === 0 ? (
          <div className="text-xs text-gray-500 bg-gray-950/40 border border-gray-800 rounded-lg p-3">
            No <span className="font-mono">trades_*.csv</span> files found in {dir || 'Downloads'}.
            Export from Tradezella first, then refresh.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-3">
                <label className="block text-xs text-gray-400 mb-1">Source CSV</label>
                <select
                  value={file}
                  onChange={e => { setFile(e.target.value); setResult(null) }}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select a file…</option>
                  {files.map(f => (
                    <option key={f.name} value={f.name}>
                      {f.name} ({(f.sizeBytes / 1024).toFixed(0)} KB · {format(new Date(f.mtimeMs), 'MMM d, HH:mm')})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSubmit}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                  {importing ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>

            <label className="flex items-start gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoMerge}
                onChange={e => setAutoMerge(e.target.checked)}
                className="accent-blue-600 mt-0.5"
              />
              <span>
                <span className="font-medium">Auto-merge duplicate tags first</span>
                <span className="block text-[10px] text-gray-500">
                  Folds library labels that collapse to the same key (e.g. <span className="font-mono">Break &amp; Retest</span> ↔
                  <span className="font-mono"> Break And Retest</span>) into the most-used label. Rewrites
                  both <span className="font-mono">trades</span> and <span className="font-mono">historical_trades</span>. Safe to leave on.
                </span>
              </span>
            </label>

            <div className="flex items-center justify-between">
              <p className="text-[10px] text-gray-500">
                Idempotent: re-importing the same CSV updates existing rows rather than duplicating them.
              </p>
              <button
                type="button"
                onClick={scan}
                disabled={importing}
                className="text-[10px] text-gray-400 hover:text-white disabled:opacity-40"
              >
                Refresh list
              </button>
            </div>

            {result?.ok && (
              <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-sm text-green-200 space-y-1">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    Imported <strong>{result.data.upserted.toLocaleString()}</strong> of {result.data.parsedRows.toLocaleString()} rows
                    from <span className="font-mono">{result.data.file}</span>
                    {result.data.newTags > 0 && <> · <strong>{result.data.newTags}</strong> new tag{result.data.newTags === 1 ? '' : 's'}</>}.
                    Total historical trades: <strong>{result.data.totalHistorical.toLocaleString()}</strong>.
                  </div>
                </div>
                {Object.keys(result.data.tagsByCategory).length > 0 && (
                  <p className="text-[11px] text-green-200/70 pl-6">
                    rows carrying each category: {Object.entries(result.data.tagsByCategory)
                      .map(([c, n]) => `${c}: ${n}`)
                      .join(' · ')}
                  </p>
                )}
                {result.data.autoMerge && result.data.autoMerge.clustersMerged > 0 && (
                  <div className="pl-6 text-[11px] text-green-200/80">
                    Pre-import auto-merge: folded <strong>{result.data.autoMerge.totalVictimsFolded}</strong> duplicate
                    label{result.data.autoMerge.totalVictimsFolded === 1 ? '' : 's'} across
                    <strong> {result.data.autoMerge.clustersMerged}</strong> cluster{result.data.autoMerge.clustersMerged === 1 ? '' : 's'}.
                    <ul className="list-disc pl-4 mt-0.5 space-y-0.5 text-green-200/70">
                      {result.data.autoMerge.mergeResults.map((m, i) => (
                        <li key={i}>
                          <span className="font-mono">{m.category}</span>: {m.victims.map(v => `"${v}"`).join(', ')}
                          {' '}→ <span className="font-mono">&quot;{m.canonical}&quot;</span>
                          {' '}({m.tradesUpdated + m.historicalUpdated} row{m.tradesUpdated + m.historicalUpdated === 1 ? '' : 's'} rewritten)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.data.autoMerge && result.data.autoMerge.clustersMerged === 0 && (
                  <p className="pl-6 text-[11px] text-green-200/60">
                    Pre-import auto-merge: no duplicate clusters found — library is clean.
                  </p>
                )}
                {result.data.errors.length > 0 && (
                  <ul className="text-[11px] text-yellow-200/80 pl-6 list-disc">
                    {result.data.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}
            {result && !result.ok && (
              <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>{result.error}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Backfill market_context for historical trade dates from SCID */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white text-sm">Backfill market context from SCID</h2>
        </div>
        <p className="text-xs text-gray-500">
          Computes <span className="font-mono">rvol</span>, <span className="font-mono">adr</span>,
          <span className="font-mono"> ib_size</span>, <span className="font-mono">ib_vs_10d_avg</span>, and
          <span className="font-mono"> atr_1m</span> for every Tradezella trade date by reading bars from the
          selected SCID file. Each date gets a <span className="font-mono">trading_days</span> row + a
          <span className="font-mono"> market_context</span> row so historical trades land in the analytics
          Condition Buckets instead of &quot;Unknown&quot;.
          <span className="block mt-1 text-gray-600">
            Run once per contract period — e.g. <span className="font-mono">NQM5.CME.scid</span> for Jun 2025,
            <span className="font-mono"> NQU5.CME.scid</span> for Jul–Sep 2025, etc. Idempotent.
          </span>
          {scidDir && <span className="block mt-1 font-mono text-gray-600">{scidDir}</span>}
        </p>

        {scidFiles.length === 0 ? (
          <div className="text-xs text-yellow-300/80 bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-3">
            No <span className="font-mono">.scid</span> files visible. Set <code className="text-yellow-200">SIERRA_DATA_DIR</code> in <code className="text-yellow-200">.env.local</code> if Sierra&apos;s data dir isn&apos;t the default.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-3">
                <label className="block text-xs text-gray-400 mb-1">Source .scid</label>
                <select
                  value={backfillScid}
                  onChange={e => { setBackfillScid(e.target.value); setBackfillResult(null) }}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
                >
                  <option value="">Select a SCID…</option>
                  {scidFiles
                    .filter(f => /^(MN?Q|N?Q)/i.test(f.name))
                    .map(f => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({(f.sizeBytes / 1e6).toFixed(0)} MB{f.mtimeMs ? ` · ${format(new Date(f.mtimeMs), 'MMM d')}` : ''})
                      </option>
                    ))}
                  <option disabled>──────────</option>
                  {scidFiles
                    .filter(f => !/^(MN?Q|N?Q)/i.test(f.name))
                    .map(f => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({(f.sizeBytes / 1e6).toFixed(0)} MB)
                      </option>
                    ))}
                </select>
                <p className="text-[10px] text-gray-500 mt-1">
                  NQ / MNQ contracts are listed first since your historical trades are all MNQ.
                </p>
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={runBackfill}
                  disabled={!canBackfill}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {backfillRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />}
                  {backfillRunning ? 'Computing…' : backfillDryRun ? 'Preview' : 'Run backfill'}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="inline-flex items-center gap-2 text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={backfillDryRun}
                  onChange={e => setBackfillDryRun(e.target.checked)}
                  className="accent-blue-600"
                />
                <span>Dry run (compute + preview, don&apos;t write)</span>
              </label>
              <label className="inline-flex items-center gap-2 text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={backfillForce}
                  onChange={e => setBackfillForce(e.target.checked)}
                  className="accent-blue-600"
                />
                <span>Force overwrite existing rows</span>
              </label>
            </div>

            {backfillResult?.ok && (
              <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-xs text-green-200 space-y-2">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    {backfillResult.data.dryRun && <span className="font-semibold text-yellow-200">[DRY RUN] </span>}
                    SCID <span className="font-mono">{backfillResult.data.scidFile}</span> covers
                    {' '}<span className="font-mono">{backfillResult.data.scidWindow.start}</span> →
                    {' '}<span className="font-mono">{backfillResult.data.scidWindow.end}</span>.
                    {' '}<strong>{backfillResult.data.inRange}</strong> of {backfillResult.data.totalHistoricalDates} historical
                    {' '}dates fall in range.
                    {' '}Inserted <strong>{backfillResult.data.inserted}</strong>, updated <strong>{backfillResult.data.updated}</strong>,
                    {' '}skipped <strong>{backfillResult.data.skipped}</strong>, failed <strong>{backfillResult.data.failed}</strong>.
                  </div>
                </div>
                {backfillResult.data.outOfRange > 0 && (
                  <p className="text-[11px] text-yellow-200/80 pl-6">
                    {backfillResult.data.outOfRange} dates fall outside this SCID&apos;s data window — re-run with the SCID for that contract period.
                  </p>
                )}
                {backfillResult.data.results.length > 0 && (
                  <details className="pl-6">
                    <summary className="cursor-pointer text-green-200/80 hover:text-green-200">
                      Per-date details ({backfillResult.data.results.length})
                    </summary>
                    <div className="mt-2 max-h-64 overflow-y-auto border border-gray-800 rounded">
                      <table className="w-full text-[10px] font-mono">
                        <thead className="text-gray-400 border-b border-gray-800 sticky top-0 bg-gray-900">
                          <tr>
                            <th className="text-left p-1.5">Date</th>
                            <th className="text-left p-1.5">Status</th>
                            <th className="text-right p-1.5">RVOL</th>
                            <th className="text-right p-1.5">ADR</th>
                            <th className="text-right p-1.5">IB size</th>
                            <th className="text-right p-1.5">IB/10d</th>
                            <th className="text-right p-1.5">ATR-1m</th>
                            <th className="text-left p-1.5">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {backfillResult.data.results.map(r => (
                            <tr key={r.date} className="border-b border-gray-800/50">
                              <td className="p-1.5 text-gray-300">{r.date}</td>
                              <td className={`p-1.5 ${
                                r.status === 'inserted' ? 'text-green-400'
                                : r.status === 'updated' ? 'text-blue-400'
                                : r.status === 'skipped' ? 'text-gray-500'
                                : 'text-red-400'
                              }`}>{r.status}</td>
                              <td className="p-1.5 text-right text-gray-300">{r.metrics?.rvol?.toFixed(2) ?? '—'}</td>
                              <td className="p-1.5 text-right text-gray-300">{r.metrics?.adr?.toFixed(1) ?? '—'}</td>
                              <td className="p-1.5 text-right text-gray-300">{r.metrics?.ib_size?.toFixed(1) ?? '—'}</td>
                              <td className="p-1.5 text-right text-gray-300">{r.metrics?.ib_vs_10d_avg?.toFixed(2) ?? '—'}</td>
                              <td className="p-1.5 text-right text-gray-300">{r.metrics?.atr_1m?.toFixed(2) ?? '—'}</td>
                              <td className="p-1.5 text-gray-500 truncate max-w-xs" title={r.reason ?? ''}>{r.reason ?? ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </div>
            )}
            {backfillResult && !backfillResult.ok && (
              <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>{backfillResult.error}</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Cross-PC CSV import — paste a filled template another Claude produced */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white text-sm">Import market context from CSV</h2>
        </div>
        <p className="text-xs text-gray-500">
          Paste a CSV produced by another Claude Code instance (e.g. one on a different PC
          that has SCIDs for older contracts). The format is documented in
          <span className="font-mono"> docs/MARKET_CONTEXT_HANDOFF.md</span> — hand that brief
          to the other Claude alongside <span className="font-mono">docs/market-context-template.csv</span>.
          Comment lines starting with <span className="font-mono">#</span> are ignored.
        </p>

        <textarea
          value={csvText}
          onChange={e => { setCsvText(e.target.value); setCsvResult(null) }}
          placeholder="trade_date,pdh,pdl,onh,onl,ibh,ibl,ib_size,rvol,adr,ib_vs_10d_avg,atr_1m&#10;2026-04-15,22150.25,21984.50,...,0.76,12.44"
          className="w-full h-40 bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-blue-500 resize-y"
          spellCheck={false}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-4">
            <label className="inline-flex items-center gap-2 text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={csvDryRun}
                onChange={e => setCsvDryRun(e.target.checked)}
                className="accent-blue-600"
              />
              <span>Dry run (validate only)</span>
            </label>
            <label className="inline-flex items-center gap-2 text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={csvForce}
                onChange={e => setCsvForce(e.target.checked)}
                className="accent-blue-600"
              />
              <span>Force overwrite</span>
            </label>
          </div>
          <button
            type="button"
            onClick={runCsvImport}
            disabled={!canCsv}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {csvRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {csvRunning ? 'Importing…' : csvDryRun ? 'Validate' : 'Import'}
          </button>
        </div>

        {csvResult?.ok && (
          <div className="bg-green-950/40 border border-green-800/60 rounded-lg p-3 text-xs text-green-200 space-y-2">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                {csvResult.data.dryRun && <span className="font-semibold text-yellow-200">[DRY RUN] </span>}
                Processed <strong>{csvResult.data.totalRows}</strong> row{csvResult.data.totalRows === 1 ? '' : 's'}.
                Inserted <strong>{csvResult.data.inserted}</strong>, updated <strong>{csvResult.data.updated}</strong>,
                skipped <strong>{csvResult.data.skipped}</strong>, failed <strong>{csvResult.data.failed}</strong>.
              </div>
            </div>
            {csvResult.data.results.some(r => r.status === 'failed') && (
              <details className="pl-6">
                <summary className="cursor-pointer text-yellow-200/80 hover:text-yellow-200">
                  Failed rows
                </summary>
                <ul className="mt-1 list-disc pl-4 text-yellow-200/80">
                  {csvResult.data.results.filter(r => r.status === 'failed').map((r, i) => (
                    <li key={i}><span className="font-mono">{r.trade_date}</span>: {r.reason}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {csvResult && !csvResult.ok && (
          <div className="bg-red-950/40 border border-red-800/60 rounded-lg p-3 text-sm text-red-200 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>{csvResult.error}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-lg font-bold text-white font-mono">{value}</p>
    </div>
  )
}
