'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Crosshair, Image as ImageIcon, CandlestickChart } from 'lucide-react'
import { deleteBlob } from '@/lib/storage'
import EodNotesForm from './EodNotesForm'
import ChartScreenshotPanel from './ChartScreenshotPanel'
import CalibrationOverlay, { type CalibStep, type CalibDraft } from './CalibrationOverlay'
import TradeArrowOverlay from './TradeArrowOverlay'
import LiveChart from './LiveChart'
import TradeList from './TradeList'
import HoverPopup from './HoverPopup'
import ImportTradesButton, { type ImportResult } from './ImportTradesButton'
import SCFolderWatcher from './SCFolderWatcher'
import EodAnalysisCard from './EodAnalysisCard'
import DeleteDayDangerZone from './DeleteDayDangerZone'
import type {
  TradingDay,
  Trade,
  TradeTag,
  ChartCalibration,
  MarketContext,
  EodAiAnalysis,
} from '@/lib/supabase/types'

interface Props {
  date: string
  initialDay: TradingDay | null
  initialTrades: Trade[]
  initialMarketContext: MarketContext | null
  allTags: TradeTag[]
}

export default function EodClient({
  date,
  initialDay,
  initialTrades,
  initialMarketContext,
}: Props) {
  const [day, setDay] = useState<TradingDay | null>(initialDay)
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
  const [chartUrl, setChartUrl] = useState<string | null>(initialDay?.eod_chart_screenshot_url ?? null)
  const [uploadingChart, setUploadingChart] = useState(false)
  const [calibration, setCalibration] = useState<ChartCalibration | null>(initialDay?.chart_calibration_json ?? null)
  const [calibMode, setCalibMode] = useState<{ step: CalibStep; draft: CalibDraft } | null>(null)
  const [savingCalib, setSavingCalib] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [hoveredTradeId, setHoveredTradeId] = useState<string | null>(null)
  const [hoverCursor, setHoverCursor] = useState<{ clientX: number; clientY: number } | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [aiAnalysis, setAiAnalysis] = useState<EodAiAnalysis | null>(() => {
    const a = initialDay?.eod_ai_analysis_json
    return a && Object.keys(a).length > 0 ? (a as EodAiAnalysis) : null
  })
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  // Chart view mode: 'screenshot' = legacy ChartScreenshotPanel +
  // calibration + TradeArrowOverlay; 'live' = native lightweight-charts
  // rendering from imported OHLCV bars. Default to screenshot for backward
  // compat; user opts into Live by clicking the toggle. State is per-mount
  // (resets on navigation between days) — fine for now.
  const [chartView, setChartView] = useState<'screenshot' | 'live'>('screenshot')

  // Most-common trade symbol on this day — feeds LiveChart's bars query.
  // Days with no trades return null; LiveChart shows a "no symbol" message.
  const chartSymbol = useMemo<string | null>(() => {
    const counts = new Map<string, number>()
    for (const t of initialTrades) {
      if (t.symbol) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1)
    }
    let best: string | null = null
    let bestCount = 0
    for (const [sym, c] of counts) {
      if (c > bestCount) { best = sym; bestCount = c }
    }
    return best
  }, [initialTrades])

  const handleHoverEnter = (tradeId: string, e: React.MouseEvent) => {
    setHoveredTradeId(tradeId)
    setHoverCursor({ clientX: e.clientX, clientY: e.clientY })
  }
  const handleHoverLeave = () => {
    setHoveredTradeId(null)
    setHoverCursor(null)
  }
  const hoveredTrade = hoveredTradeId ? trades.find(t => t.id === hoveredTradeId) ?? null : null

  const refreshTrades = async () => {
    try {
      const res = await fetch(`/api/trades?date=${date}`)
      if (!res.ok) return
      const data = (await res.json()) as Trade[]
      setTrades(data)
    } catch {
      // best-effort refresh; toast already shown on import errors
    }
  }

  const toBase64 = async (
    source: File | string,
  ): Promise<{ data: string; mediaType: string } | null> => {
    try {
      const blob = source instanceof File ? source : await fetch(source).then(r => r.blob())
      return await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          const [header, data] = result.split(',')
          const mediaType = header.match(/:(.*?);/)?.[1] ?? 'image/png'
          resolve({ data, mediaType })
        }
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    } catch {
      return null
    }
  }

  const runAnalysis = async () => {
    setAnalyzing(true)
    try {
      let image: { data: string; mediaType: string } | null = null
      if (chartUrl && !chartUrl.startsWith('blob:')) {
        image = await toBase64(chartUrl)
      }

      const res = await fetch('/api/analyze-eod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trades,
          eodNotes: day?.eod_notes ?? '',
          prepNotes: day?.prep_notes_json,
          prepAnalysis: day?.ai_analysis_json,
          marketContext: initialMarketContext,
          imageBase64: image?.data ?? null,
          imageMediaType: image?.mediaType ?? null,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Analysis failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      const analysis = (await res.json()) as EodAiAnalysis
      setAiAnalysis(analysis)

      // Persist to DB
      const saveRes = await fetch(`/api/trading-days/${date}/eod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eod_ai_analysis_json: analysis }),
      })
      if (saveRes.ok) {
        const saveData = await saveRes.json()
        if (saveData.day) setDay(saveData.day as TradingDay)
      }
      showToast('Session analyzed', 'success')
    } catch (e) {
      showToast(`Analysis error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setAnalyzing(false)
    }
  }

  const handleImported = async (result: ImportResult) => {
    if (result.parseErrors.length > 0) {
      showToast(result.parseErrors[0], 'error')
    } else {
      const summary = `Imported ${result.inserted} trades` +
        (result.skippedDuplicates ? ` (${result.skippedDuplicates} duplicates skipped)` : '') +
        (result.skippedFiltered ? ` (${result.skippedFiltered} filtered out)` : '')
      showToast(summary, 'success')
    }
    if (result.droppedColumns) {
      const dropped = Object.entries(result.droppedColumns)
        .map(([scope, cols]) => `${scope}: ${cols.join(', ')}`)
        .join(' · ')
      showToast(
        `Some columns weren't written — ${dropped}. Run schema migration in Supabase to enable.`,
        'error',
      )
    }
    await refreshTrades()
    // Refresh the day to reflect last_sc_import_at
    try {
      const res = await fetch(`/api/trading-days/${date}`)
      if (res.ok) {
        const { day: refreshed } = await res.json()
        if (refreshed) setDay(refreshed as TradingDay)
      }
    } catch { /* ignore */ }
  }

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  const uploadChart = async (file: File) => {
    setUploadingChart(true)
    const previousUrl = chartUrl
    try {
      const ext = file.name.split('.').pop() || 'png'
      const formData = new FormData()
      formData.append('file', file)
      formData.append('bucket', 'screenshots')
      formData.append('path', `chart-eod/${date}-${Date.now()}.${ext}`)

      const upRes = await fetch('/api/screenshots', { method: 'POST', body: formData })
      const upData = await upRes.json()
      if (!upRes.ok || !upData.url) {
        showToast(`Upload failed: ${upData.error ?? 'unknown error'}`, 'error')
        return
      }

      const saveRes = await fetch(`/api/trading-days/${date}/eod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eod_chart_screenshot_url: upData.url }),
      })
      if (!saveRes.ok) {
        const err = await saveRes.json()
        showToast(`Save failed: ${err.error ?? 'unknown error'}`, 'error')
        return
      }
      const saveData = await saveRes.json()
      setChartUrl(upData.url)
      setDay(saveData.day)
      // Clean up the old blob now that the new one is saved
      if (previousUrl && previousUrl !== upData.url) {
        void deleteBlob(previousUrl)
      }
      showToast('EOD chart saved', 'success')
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setUploadingChart(false)
    }
  }

  const startCalibration = () => {
    setCalibMode({ step: 'high', draft: {} })
  }

  const cancelCalibration = () => {
    setCalibMode(null)
  }

  const resetCalibration = async () => {
    if (!confirm('Reset chart calibration? Trade arrows will disappear until you re-calibrate.')) return
    setSavingCalib(true)
    try {
      const res = await fetch(`/api/trading-days/${date}/calibration`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Reset failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      setCalibration(null)
      setDay(prev => (prev ? { ...prev, chart_calibration_json: null } : prev))
      showToast('Calibration reset', 'success')
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setSavingCalib(false)
    }
  }

  const STEP_ORDER: CalibStep[] = ['high', 'low', 'start', 'end']

  const handleAnchorPlaced = async (
    step: CalibStep,
    pos: { x_pct: number; y_pct: number },
    value: { price: number } | { time: string },
  ) => {
    if (!calibMode) return
    const newDraft: CalibDraft = { ...calibMode.draft }
    if (step === 'high' || step === 'low') {
      newDraft[step] = { ...pos, price: (value as { price: number }).price }
    } else {
      newDraft[step] = { ...pos, time: (value as { time: string }).time }
    }

    const nextIdx = STEP_ORDER.indexOf(step) + 1
    if (nextIdx < STEP_ORDER.length) {
      setCalibMode({ step: STEP_ORDER[nextIdx], draft: newDraft })
      return
    }

    // All 4 anchors placed — save
    if (!newDraft.high || !newDraft.low || !newDraft.start || !newDraft.end) {
      showToast('Calibration incomplete', 'error')
      return
    }
    setSavingCalib(true)
    try {
      const res = await fetch(`/api/trading-days/${date}/calibration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          high: newDraft.high,
          low: newDraft.low,
          start: newDraft.start,
          end: newDraft.end,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Calibration save failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      const data = await res.json()
      setCalibration(data.calibration)
      setDay(prev => (prev ? { ...prev, chart_calibration_json: data.calibration } : data.day))
      setCalibMode(null)
      showToast('Chart calibrated', 'success')
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setSavingCalib(false)
    }
  }

  const removeChart = async () => {
    setUploadingChart(true)
    const urlToDelete = chartUrl
    try {
      const res = await fetch(`/api/trading-days/${date}/eod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eod_chart_screenshot_url: null }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Remove failed: ${err.error ?? 'unknown error'}`, 'error')
        return
      }
      const data = await res.json()
      setChartUrl(null)
      setDay(data.day)
      if (urlToDelete) void deleteBlob(urlToDelete)
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setUploadingChart(false)
    }
  }

  const computedPnl = useMemo(() => {
    return trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  }, [trades])

  const winCount = trades.filter(t => (t.pnl ?? 0) > 0).length
  const lossCount = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0

  // --- Trade-selection state (shared by merge + bulk-delete actions) ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)
  const [deletingTradeId, setDeletingTradeId] = useState<string | null>(null)
  const [bulkDeletingTrades, setBulkDeletingTrades] = useState(false)

  // Trades sharing the same direction within ±60s are flagged as potential
  // duplicates (e.g., a manual intraday-tagged trade vs an SC-imported fill).
  // Pure visual hint — does not restrict selection.
  const nearDuplicateIds = useMemo(() => {
    const flagged = new Set<string>()
    const NEAR_WINDOW_MS = 60_000
    for (let i = 0; i < trades.length; i++) {
      const a = trades[i]
      if (!a.entry_time) continue
      const aMs = new Date(a.entry_time).getTime()
      for (let j = i + 1; j < trades.length; j++) {
        const b = trades[j]
        if (!b.entry_time || b.direction !== a.direction) continue
        if (Math.abs(new Date(b.entry_time).getTime() - aMs) <= NEAR_WINDOW_MS) {
          flagged.add(a.id)
          flagged.add(b.id)
        }
      }
    }
    return flagged
  }, [trades])

  const toggleTradeSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleMergeSelected = async () => {
    if (selectedIds.size !== 2) return
    const [idA, idB] = Array.from(selectedIds)
    const a = trades.find(t => t.id === idA)
    const b = trades.find(t => t.id === idB)
    if (!a || !b) return

    const fmtT = (t: Trade) =>
      `${t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'} ${t.direction?.toUpperCase() ?? '--'} @ ${t.entry_price ?? '--'} qty ${t.quantity ?? '--'}${t.sierra_trade_id ? ' [SC]' : ' [manual]'}`

    const proceed = confirm(
      `Merge these two trades into one?\n\n` +
        `  ${fmtT(a)}\n` +
        `  ${fmtT(b)}\n\n` +
        `The SC-imported trade keeps its fill data (time, price, qty, pnl). ` +
        `The manual trade's tags, notes, screenshot, and stop/TP levels are ` +
        `carried over. The other row is deleted.\n\n` +
        `This cannot be undone.`,
    )
    if (!proceed) return

    setMerging(true)
    try {
      const res = await fetch('/api/trades/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeIds: [idA, idB] }),
      })
      const data = await res.json()
      if (!res.ok) {
        showToast(`Merge failed: ${data.error ?? 'unknown error'}`, 'error')
        return
      }
      clearSelection()
      await refreshTrades()
      showToast('Trades merged', 'success')
    } catch (e) {
      showToast(`Merge failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setMerging(false)
    }
  }

  const handleDeleteTrade = async (id: string) => {
    const t = trades.find(tr => tr.id === id)
    if (!t) return
    const desc = `${t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'} ${t.direction?.toUpperCase() ?? '--'} @ ${t.entry_price ?? '--'}`
    if (!confirm(`Delete trade ${desc}?\n\nThis permanently removes the row${t.sierra_trade_id ? ' (will re-appear on next SC log re-import if the fill is still in the log)' : ''}. Cannot be undone.`)) return

    setDeletingTradeId(id)
    try {
      const res = await fetch(`/api/trades/${id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        showToast(`Delete failed: ${data.error ?? res.statusText}`, 'error')
        return
      }
      // Also clean up the screenshot blob if this trade has one
      if (t.screenshot_url) {
        await deleteBlob(t.screenshot_url).catch(() => { /* non-fatal */ })
      }
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await refreshTrades()
      showToast('Trade deleted', 'success')
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setDeletingTradeId(null)
    }
  }

  const handleBulkDeleteTrades = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    const selected = trades.filter(t => selectedIds.has(t.id))
    const proceed = confirm(
      `Delete ${ids.length} trade${ids.length === 1 ? '' : 's'}?\n\n` +
        selected.map(t => `  • ${t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'} ${t.direction?.toUpperCase() ?? '--'} @ ${t.entry_price ?? '--'}${t.sierra_trade_id ? ' [SC]' : ' [manual]'}`).join('\n') +
        `\n\nThis permanently removes the rows${selected.some(t => t.sierra_trade_id) ? ' (SC-imported ones will re-appear on next log re-import)' : ''}. Cannot be undone.`,
    )
    if (!proceed) return

    setBulkDeletingTrades(true)
    const succeeded: string[] = []
    const failed: string[] = []
    const blobsToCleanup: string[] = []
    for (const t of selected) {
      try {
        const res = await fetch(`/api/trades/${t.id}`, { method: 'DELETE' })
        if (res.ok) {
          succeeded.push(t.id)
          if (t.screenshot_url) blobsToCleanup.push(t.screenshot_url)
        } else {
          failed.push(t.id)
        }
      } catch {
        failed.push(t.id)
      }
    }
    // Best-effort blob cleanup for deleted trades' screenshots
    for (const url of blobsToCleanup) {
      void deleteBlob(url).catch(() => { /* non-fatal */ })
    }
    clearSelection()
    setBulkDeletingTrades(false)
    await refreshTrades()
    if (failed.length === 0) {
      showToast(`Deleted ${succeeded.length} trade${succeeded.length === 1 ? '' : 's'}`, 'success')
    } else if (succeeded.length === 0) {
      showToast(`All ${failed.length} deletes failed`, 'error')
    } else {
      showToast(`Deleted ${succeeded.length}, ${failed.length} failed`, 'error')
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">EOD Recap</h1>
          <div className="flex items-center gap-3 mt-1">
            <input
              type="date"
              value={date}
              onChange={e => {
                const next = e.target.value
                if (next && next !== date) router.push(`/eod/${next}`)
              }}
              className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-md px-2 py-1 font-mono focus:outline-none focus:border-blue-500"
              title="Switch to a different day's recap"
            />
            <span className="text-gray-400 text-sm">{format(new Date(date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')}</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <SCFolderWatcher
            onActivity={(msg, type) => showToast(msg, type)}
            onImported={refreshTrades}
          />
          <ImportTradesButton
            date={date}
            onImported={handleImported}
            onError={msg => showToast(msg, 'error')}
          />
          <div className="border-l border-gray-700 h-10" />
          <div className="flex items-center gap-6">
          <div>
            <div className="text-xs text-gray-500">Trades</div>
            <div className="font-mono text-white text-lg">{trades.length}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Win Rate</div>
            <div className="font-mono text-white text-lg">{winRate.toFixed(0)}%</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">W / L</div>
            <div className="font-mono text-lg">
              <span className="text-green-400">{winCount}</span>
              <span className="text-gray-600"> / </span>
              <span className="text-red-400">{lossCount}</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">PnL</div>
            <div className={`font-mono text-lg ${computedPnl > 0 ? 'text-green-400' : computedPnl < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              {computedPnl >= 0 ? '+' : ''}{computedPnl.toFixed(2)}
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* Chart area — toggle between legacy screenshot+calibration and the
          new live-bars rendering. Screenshot path will be removed in Phase 5
          of the chart migration once Live has proven itself across the
          intraday + dashboard surfaces too. */}
      <div className="flex justify-end -mb-2">
        <div className="inline-flex bg-gray-800 border border-gray-700 rounded-lg overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setChartView('screenshot')}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              chartView === 'screenshot' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" /> Screenshot
          </button>
          <button
            type="button"
            onClick={() => setChartView('live')}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              chartView === 'live' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <CandlestickChart className="w-3.5 h-3.5" /> Live chart
          </button>
        </div>
      </div>

      {chartView === 'live' ? (
        <LiveChart
          date={date}
          symbol={chartSymbol}
          trades={trades}
        />
      ) : (
      <ChartScreenshotPanel
        ref={imageContainerRef}
        chartUrl={chartUrl}
        uploading={uploadingChart}
        onFile={uploadChart}
        onRemove={removeChart}
        toolbar={
          chartUrl ? (
            <div className="flex items-center gap-3 text-xs">
              {calibration && !calibMode && (
                <span className="flex items-center gap-1.5 text-green-400">
                  ✓ Calibrated {format(new Date(calibration.calibrated_at), 'MMM d HH:mm')}
                  <button
                    onClick={resetCalibration}
                    disabled={savingCalib}
                    className="text-green-400/60 hover:text-red-400 transition-colors disabled:opacity-30"
                    title="Reset calibration"
                  >
                    ×
                  </button>
                </span>
              )}
              {calibMode ? null : (
                <button
                  onClick={startCalibration}
                  disabled={savingCalib}
                  className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                >
                  <Crosshair className="w-3 h-3" />
                  {calibration ? 'Recalibrate' : 'Calibrate chart'}
                </button>
              )}
            </div>
          ) : null
        }
      >
        {calibMode && (
          <CalibrationOverlay
            step={calibMode.step}
            draft={calibMode.draft}
            onAnchorPlaced={handleAnchorPlaced}
            onCancel={cancelCalibration}
          />
        )}
        {!calibMode && calibration && trades.length > 0 && (
          <TradeArrowOverlay
            trades={trades}
            calibration={calibration}
            hoveredTradeId={hoveredTradeId}
            onHoverEnter={handleHoverEnter}
            onHoverLeave={handleHoverLeave}
          />
        )}
      </ChartScreenshotPanel>
      )}
      {chartView === 'screenshot' && day?.last_sc_import_at && (
        <p className="text-xs text-gray-500 -mt-3 ml-1">
          Last import: {format(new Date(day.last_sc_import_at), 'MMM d, HH:mm')}
        </p>
      )}

      {selectedIds.size > 0 && (
        <div className="bg-blue-950/60 border border-blue-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-sm">
          <span className="text-blue-200">
            {selectedIds.size} trade{selectedIds.size === 1 ? '' : 's'} selected
            {selectedIds.size === 1 && <span className="text-blue-400/70"> — select one more to merge</span>}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={clearSelection}
              disabled={merging}
              className="text-xs text-blue-300 hover:text-white disabled:opacity-50"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={handleBulkDeleteTrades}
              disabled={bulkDeletingTrades || merging}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              {bulkDeletingTrades ? 'Deleting…' : `Delete selected`}
            </button>
            <button
              type="button"
              onClick={handleMergeSelected}
              disabled={selectedIds.size !== 2 || merging || bulkDeletingTrades}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              {merging ? 'Merging…' : 'Merge selected'}
            </button>
          </div>
        </div>
      )}

      <TradeList
        trades={trades}
        hoveredTradeId={hoveredTradeId}
        onHoverEnter={handleHoverEnter}
        onHoverLeave={handleHoverLeave}
        selectedIds={selectedIds}
        onToggleSelect={toggleTradeSelection}
        nearDuplicateIds={nearDuplicateIds}
        onDelete={handleDeleteTrade}
        deletingId={deletingTradeId}
      />

      {/* EOD Notes */}
      <EodNotesForm
        date={date}
        initialNotes={day?.eod_notes ?? ''}
        initialPnl={day?.eod_pnl ?? null}
        computedPnl={computedPnl}
        onSaved={(notes, pnl) => {
          setDay(prev => prev ? { ...prev, eod_notes: notes, eod_pnl: pnl } : prev)
          showToast('EOD recap saved', 'success')
        }}
        onError={msg => showToast(msg, 'error')}
      />

      {/* AI session analysis */}
      <EodAnalysisCard
        analysis={aiAnalysis}
        loading={analyzing}
        onAnalyze={runAnalysis}
        disabled={trades.length === 0 && !day?.eod_notes}
      />

      {/* Danger zone — delete entire day */}
      <DeleteDayDangerZone
        date={date}
        hasData={day != null}
        tradesCount={trades.length}
        onError={msg => showToast(msg, 'error')}
      />

      {/* Floating hover popup — body-level fixed positioning */}
      <HoverPopup trade={hoveredTrade} cursor={hoverCursor} />
    </div>
  )
}
