'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Crosshair } from 'lucide-react'
import { deleteBlob } from '@/lib/storage'
import EodNotesForm from './EodNotesForm'
import ChartScreenshotPanel from './ChartScreenshotPanel'
import CalibrationOverlay, { type CalibStep, type CalibDraft } from './CalibrationOverlay'
import TradeArrowOverlay from './TradeArrowOverlay'
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

      {/* Chart screenshot + calibration overlay (arrows in next checkpoint) */}
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
      {day?.last_sc_import_at && (
        <p className="text-xs text-gray-500 -mt-3 ml-1">
          Last import: {format(new Date(day.last_sc_import_at), 'MMM d, HH:mm')}
        </p>
      )}

      <TradeList
        trades={trades}
        hoveredTradeId={hoveredTradeId}
        onHoverEnter={handleHoverEnter}
        onHoverLeave={handleHoverLeave}
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
