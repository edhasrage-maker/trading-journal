'use client'

import { useRef, useState } from 'react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { Upload, Loader2, AlertTriangle, CheckCircle, RefreshCw, Clock, Database } from 'lucide-react'
import type { ConditionThreshold } from '@/lib/supabase/types'

interface Props {
  initialThresholds: ConditionThreshold[]
  initialLookupCount: number
  initialRefreshedAt: string | null
}

export default function ConditionLookupSettings({
  initialThresholds,
  initialLookupCount,
  initialRefreshedAt,
}: Props) {
  const [thresholds, setThresholds] = useState<ConditionThreshold[]>(initialThresholds)
  const [lookupCount, setLookupCount] = useState(initialLookupCount)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(initialRefreshedAt)
  const [thresholdsFile, setThresholdsFile] = useState<File | null>(null)
  const [lookupFile, setLookupFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const thresholdsInputRef = useRef<HTMLInputElement>(null)
  const lookupInputRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 5000)
  }

  /** Auto-refresh: pull live trades + market_context, recompute thresholds
   *  + lookup server-side, write directly to the same tables the CSV upload
   *  writes to. No file selection needed. */
  const refresh = async () => {
    if (!confirm(
      `Regenerate condition_thresholds + condition_lookup from current trade history?\n\n` +
      `This wipes the existing ${thresholds.length} threshold rows and ${lookupCount} lookup rows ` +
      `and replaces them with values computed from live data.`
    )) return
    setRefreshing(true)
    try {
      const res = await fetch('/api/condition-lookup/refresh', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        showToast(`Refresh failed: ${data.error ?? 'unknown'}`, 'error')
        return
      }
      showToast(
        `Refreshed — ${data.thresholds_inserted} thresholds, ${data.lookup_inserted} lookup rows, ${data.trades_aggregated} trades`,
        'success',
      )
      setLookupCount(data.lookup_inserted)
      setRefreshedAt(data.refreshed_at)
      try {
        const tRes = await fetch('/api/condition-lookup/thresholds')
        if (tRes.ok) {
          const tData = (await tRes.json()) as { thresholds: ConditionThreshold[] }
          setThresholds(tData.thresholds)
        }
      } catch { /* ignore */ }
    } catch (e) {
      showToast(`Refresh failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const upload = async () => {
    if (!thresholdsFile || !lookupFile) {
      showToast('Both files are required', 'error')
      return
    }
    if (!confirm(
      `Replace the condition lookup with these files?\n\n` +
      `Thresholds: ${thresholdsFile.name}\n` +
      `Lookup: ${lookupFile.name}\n\n` +
      `This wipes the current ${thresholds.length} threshold rows and ${lookupCount} lookup rows.`
    )) return

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('thresholds', thresholdsFile)
      fd.append('lookup', lookupFile)
      const res = await fetch('/api/condition-lookup/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        showToast(`Upload failed: ${data.error ?? 'unknown'}`, 'error')
        return
      }
      showToast(
        `Replaced lookup — ${data.thresholds_inserted} thresholds, ${data.lookup_inserted} lookup rows`,
        'success',
      )
      // Refresh state from response
      setLookupCount(data.lookup_inserted)
      setRefreshedAt(data.refreshed_at)
      setThresholdsFile(null)
      setLookupFile(null)
      if (thresholdsInputRef.current) thresholdsInputRef.current.value = ''
      if (lookupInputRef.current) lookupInputRef.current.value = ''
      // Reload thresholds from server so the table reflects the new values
      try {
        const tRes = await fetch('/api/condition-lookup/thresholds')
        if (tRes.ok) {
          const tData = (await tRes.json()) as { thresholds: ConditionThreshold[] }
          setThresholds(tData.thresholds)
        }
      } catch { /* ignore */ }
    } catch (e) {
      showToast(`Upload failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setUploading(false)
    }
  }

  const ageDays = refreshedAt
    // eslint-disable-next-line react-hooks/purity
    ? Math.floor((Date.now() - new Date(refreshedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null
  const stale = ageDays != null && ageDays > 60

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${
          toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Condition Lookup</h1>
        <p className="text-gray-400 text-sm mt-1">
          Refresh the morning-prep condition filter from the latest CSVs generated by your trading-studies pipeline.
        </p>
      </div>

      {/* Vintage card */}
      <div className={`bg-gray-900 border rounded-xl p-5 ${stale ? 'border-yellow-800' : 'border-gray-800'}`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Database className="w-5 h-5 text-blue-400" />
            <div>
              <div className="text-sm font-semibold text-white">Current data vintage</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {refreshedAt ? (
                  <>
                    Last refreshed {format(new Date(refreshedAt), 'MMM d, yyyy HH:mm')} (
                    {ageDays === 0 ? 'today' : `${ageDays} day${ageDays === 1 ? '' : 's'} ago`})
                  </>
                ) : (
                  <span className="text-yellow-400">Never refreshed — upload CSVs below to enable the condition filter.</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 text-sm font-mono">
            <div>
              <div className="text-xs text-gray-500">Thresholds</div>
              <div className="text-white">{thresholds.length}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Lookup rows</div>
              <div className="text-white">{lookupCount}</div>
            </div>
          </div>
        </div>
        {stale && (
          <div className="mt-3 flex items-start gap-2 bg-yellow-950/40 border border-yellow-900 rounded-lg px-3 py-2 text-xs text-yellow-200">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-yellow-400" />
            <span>
              Data is more than 60 days old. Regenerate from the latest trade data
              and upload below to keep verdicts representative.
            </span>
          </div>
        )}
      </div>

      {/* Auto-refresh card — wipes and rebuilds both tables from live
          trade history. Preferred path over the CSV upload below now that
          the aggregation logic is in src/lib/condition-lookup-refresh.ts. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <RefreshCw className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-white">Refresh from current data</div>
              <div className="text-xs text-gray-500 mt-1 leading-relaxed">
                Regenerate thresholds + lookup directly from{' '}
                <span className="text-gray-300">trades</span>,{' '}
                <span className="text-gray-300">historical_trades</span>, and{' '}
                <span className="text-gray-300">market_context</span>. No CSV
                upload needed — once you have current data in the DB, this is
                a one-button rebuild. The CSV upload below is still available
                for offline/manual workflows.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>

      {/* Thresholds preview */}
      {thresholds.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="font-semibold text-white text-sm mb-3">Active thresholds</h2>
          <table className="w-full text-xs font-mono">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left font-normal py-2 pr-3">Metric</th>
                <th className="text-right font-normal py-2 pr-3">Tertile low</th>
                <th className="text-right font-normal py-2 pr-3">Median</th>
                <th className="text-right font-normal py-2 pr-3">Tertile high</th>
                <th className="text-left font-normal py-2 pl-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map(t => (
                <tr key={t.metric} className="border-b border-gray-800/50">
                  <td className="py-1.5 pr-3 text-gray-300">{t.metric}</td>
                  <td className="py-1.5 pr-3 text-right text-blue-300">{t.tertile_low.toFixed(3)}</td>
                  <td className="py-1.5 pr-3 text-right text-white">{t.median.toFixed(3)}</td>
                  <td className="py-1.5 pr-3 text-right text-amber-300">{t.tertile_high.toFixed(3)}</td>
                  {/* `formatDistanceToNowStrict` uses Date.now() under the hood,
                      so the server and client compute slightly different
                      strings ("7 seconds" vs "8 seconds") at hydration.
                      suppressHydrationWarning tells React the mismatch is
                      intentional — the client value is what we want shown,
                      and it converges within a render. */}
                  <td className="py-1.5 pl-3 text-gray-600" suppressHydrationWarning>
                    {formatDistanceToNowStrict(new Date(t.updated_at))} ago
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Upload form */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold text-white">Replace lookup from CSVs</h2>
        </div>
        <p className="text-xs text-gray-500">
          Upload both files. This will <strong className="text-red-300">truncate</strong> the existing condition_thresholds + condition_lookup tables and replace them.
        </p>

        <div className="grid md:grid-cols-2 gap-4">
          <FileSlot
            label="condition_thresholds.csv"
            hint="5 rows · columns: metric, median, tertile_low, tertile_high"
            file={thresholdsFile}
            inputRef={thresholdsInputRef}
            onPick={setThresholdsFile}
          />
          <FileSlot
            label="condition_lookup.csv"
            hint="~235 rows · 28 columns"
            file={lookupFile}
            inputRef={lookupInputRef}
            onPick={setLookupFile}
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            onClick={upload}
            disabled={uploading || !thresholdsFile || !lookupFile}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Replacing...' : 'Replace lookup'}
          </button>
        </div>
      </div>

      {/* Help */}
      <div className="bg-gray-900/50 border border-gray-800/50 rounded-xl p-5 text-xs text-gray-400 space-y-2">
        <div className="flex items-center gap-2 text-gray-300">
          <Clock className="w-3.5 h-3.5" />
          <span className="font-semibold">Refresh procedure</span>
        </div>
        <p>
          The lookup is generated by <code className="bg-gray-800 px-1 rounded">scripts/20_build_condition_lookup.py</code> in the
          trading-studies repo, which reads your trade history plus 1-minute market data and produces both CSVs.
          Re-run that script periodically (every 1-2 months of new trades, or after a notable regime change), then upload here.
        </p>
        <p>
          Each refresh recomputes bucket cutpoints, Wilson CIs on win rate, and bootstrap CIs on EV — so verdicts will shift slightly with new data.
        </p>
      </div>
    </div>
  )
}

function FileSlot({
  label,
  hint,
  file,
  inputRef,
  onPick,
}: {
  label: string
  hint: string
  file: File | null
  inputRef: React.RefObject<HTMLInputElement | null>
  onPick: (f: File | null) => void
}) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-300 mb-1">{label}</div>
      <div className="text-[10px] text-gray-600 mb-2">{hint}</div>
      <div
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer border-2 border-dashed rounded-lg p-4 transition-colors text-center ${
          file ? 'border-green-700 bg-green-950/20' : 'border-gray-700 hover:border-gray-500 bg-gray-950/30'
        }`}
      >
        {file ? (
          <div className="flex items-center justify-center gap-2 text-sm text-green-300">
            <CheckCircle className="w-4 h-4" />
            <span className="truncate" title={file.name}>{file.name}</span>
            <span className="text-xs text-gray-500">({(file.size / 1024).toFixed(1)} KB)</span>
          </div>
        ) : (
          <div className="text-xs text-gray-500">Click to choose a file</div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={e => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-export the page-level component so the route can import it
// ─────────────────────────────────────────────────────────────────────────────

// Used in dev to find this component
ConditionLookupSettings.displayName = 'ConditionLookupSettings'
