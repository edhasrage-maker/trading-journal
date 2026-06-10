'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'
import { Crosshair, Image as ImageIcon, CandlestickChart, HelpCircle, X } from 'lucide-react'
import { deleteBlob } from '@/lib/storage'
import EodNotesForm from './EodNotesForm'
import ChartScreenshotPanel from './ChartScreenshotPanel'
import CalibrationOverlay, { type CalibStep, type CalibDraft } from './CalibrationOverlay'
import TradeArrowOverlay from './TradeArrowOverlay'
import LiveChart from '@/components/charts/LiveChart'
import BarWatcher from '@/components/charts/BarWatcher'
import TradeList from './TradeList'
import ImportTradesButton, { type ImportResult } from './ImportTradesButton'
import SCFolderWatcher from './SCFolderWatcher'
import EodAnalysisCard from './EodAnalysisCard'
import DeleteDayDangerZone from './DeleteDayDangerZone'
import RecordingCommentary from './RecordingCommentary'
import AvgMfeMaeCard from '@/components/AvgMfeMaeCard'
import { avgCaptureRatio, avgMaeHeatRatio, type BarLike } from '@/lib/analytics'
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
  /** Map of trade.id → per-trade live ATR-10 (Wilder) at entry_time, in price points. Computed server-side from 1-min bars. Missing entries fall back to no chip. */
  liveAtrByTradeId?: Record<string, number>
  /** Map of trade.id → post-exit continuation @30m. Computed server-side from bars; powers the trade list's Post-Exit column. */
  postExitByTradeId?: Record<string, import('@/lib/atr').PostExitData>
}

// Stable content hash for a trade's summary-relevant fields, so a cached AI
// summary is reused until the tags/notes/fills actually change. djb2.
function hashTrade(t: Trade): string {
  const basis = JSON.stringify({
    d: t.direction, e: t.entry_price, p: t.pnl, q: t.quantity,
    x: t.exits_json, tg: t.tags_json, n: t.notes,
  })
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
const summaryCacheKey = (id: string) => `trade-summary-${id}`

export default function EodClient({
  date,
  initialDay,
  initialTrades,
  initialMarketContext,
  liveAtrByTradeId,
  postExitByTradeId,
}: Props) {
  const [day, setDay] = useState<TradingDay | null>(initialDay)
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
  // 1m bars for the day, fetched once on mount. Threaded into TradeList so
  // per-row MFE Realized % uses the scaling-aware capture calc (walks
  // exits_json + per-leg peaks). Falls back to simple peak × full-qty when
  // bars unavailable or no symbol on any trade.
  const [bars, setBars] = useState<BarLike[] | null>(null)
  useEffect(() => {
    const symbol = trades.find(t => t.symbol)?.symbol
    if (!symbol) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear bars when no symbol
      setBars(null)
      return
    }
    let cancelled = false
    fetch(`/api/bars?symbol=${encodeURIComponent(symbol)}&date=${date}`)
      .then(res => res.ok ? res.json() : null)
      .then((data: { bars?: BarLike[] } | null) => {
        if (cancelled) return
        setBars(data?.bars ?? null)
      })
      .catch(() => { if (!cancelled) setBars(null) })
    return () => { cancelled = true }
  }, [trades, date])
  const [chartUrl, setChartUrl] = useState<string | null>(initialDay?.eod_chart_screenshot_url ?? null)
  const [uploadingChart, setUploadingChart] = useState(false)
  const [calibration, setCalibration] = useState<ChartCalibration | null>(initialDay?.chart_calibration_json ?? null)
  const [calibMode, setCalibMode] = useState<{ step: CalibStep; draft: CalibDraft } | null>(null)
  const [savingCalib, setSavingCalib] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  // Hovered-row tracking. The chart picks this up via `hoverTradeId` and
  // drops its crosshair + marker popup on that trade — that's the single
  // hover-feedback surface (the old cursor-following HoverPopup duplicated it
  // and was removed). TradeList also uses it for row-highlight styling.
  const [hoveredTradeId, setHoveredTradeId] = useState<string | null>(null)
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
  const [chartView, setChartView] = useState<'screenshot' | 'live'>('live')
  // Bumped by the background bar watcher when it imports bars for this day, so
  // the Live chart re-fetches and shows the freshly-imported bars.
  const [barsVersion, setBarsVersion] = useState(0)

  // AI 1-2 line per-trade narratives shown in the trade list's Overview column.
  // Cached in localStorage by content hash so we only call Claude when a trade's
  // tags/notes/fills change.
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summariesLoading, setSummariesLoading] = useState(false)

  // Help-popup state for the header MFE/MAE definitions. Same pattern as the
  // dashboard RecentDaysList — click to toggle, click outside to dismiss.
  const [mfeInfoOpen, setMfeInfoOpen] = useState(false)
  const [maeInfoOpen, setMaeInfoOpen] = useState(false)
  const mfeInfoRef = useRef<HTMLDivElement>(null)
  const maeInfoRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!mfeInfoOpen && !maeInfoOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (mfeInfoOpen && mfeInfoRef.current && !mfeInfoRef.current.contains(t)) setMfeInfoOpen(false)
      if (maeInfoOpen && maeInfoRef.current && !maeInfoRef.current.contains(t)) setMaeInfoOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMfeInfoOpen(false); setMaeInfoOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [mfeInfoOpen, maeInfoOpen])

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

  // Generate (or reuse cached) AI Overview summaries whenever trades change.
  // Pulls hits from localStorage by content hash; batches the misses into one
  // /api/trades/summary call. Silent on failure (e.g. ANTHROPIC_API_KEY unset).
  useEffect(() => {
    if (trades.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing summaries when day has no trades
      setSummaries({})
      return
    }
    const cached: Record<string, string> = {}
    const missing: Trade[] = []
    for (const t of trades) {
      const h = hashTrade(t)
      try {
        const raw = localStorage.getItem(summaryCacheKey(t.id))
        if (raw) {
          const c = JSON.parse(raw) as { h: string; s: string }
          if (c.h === h && c.s) { cached[t.id] = c.s; continue }
        }
      } catch { /* ignore */ }
      missing.push(t)
    }
    setSummaries(cached)
    if (missing.length === 0) return

    let cancelled = false
    setSummariesLoading(true)
    fetch('/api/trades/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trades: missing.map(t => ({
          id: t.id, direction: t.direction, entry_price: t.entry_price, pnl: t.pnl,
          quantity: t.quantity, exits_json: t.exits_json, tags_json: t.tags_json, notes: t.notes,
        })),
      }),
    })
      .then(r => r.json())
      .then((d: { summaries?: Record<string, string> }) => {
        if (cancelled) return
        const got = d.summaries ?? {}
        setSummaries(prev => ({ ...prev, ...got }))
        for (const t of missing) {
          if (got[t.id]) {
            try { localStorage.setItem(summaryCacheKey(t.id), JSON.stringify({ h: hashTrade(t), s: got[t.id] })) } catch { /* ignore */ }
          }
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setSummariesLoading(false) })
    return () => { cancelled = true }
  }, [trades])

  // The mouse-event arg is still accepted by TradeList (it passed e for the
  // cursor coords) but we no longer use it now that the popup-on-cursor was
  // removed. Left the signature compatible to avoid touching TradeList.
  const handleHoverEnter = (tradeId: string, _e: React.MouseEvent) => {
    void _e
    setHoveredTradeId(tradeId)
  }
  const handleHoverLeave = () => {
    setHoveredTradeId(null)
  }

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

  // Day-level execution quality: avg MFE capture and avg MAE loss across all
  // trades that have the data (entry/stop/direction/high/low present).
  const captureStats = useMemo(() => avgCaptureRatio(trades), [trades])
  const heatStats = useMemo(() => avgMaeHeatRatio(trades), [trades])

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
        <div className="flex items-center gap-3 text-sm">
          <SCFolderWatcher
            onActivity={(msg, type) => showToast(msg, type)}
            onImported={refreshTrades}
          />
          <BarWatcher
            activeDate={date}
            onRefresh={() => setBarsVersion(v => v + 1)}
          />
          <ImportTradesButton
            date={date}
            onImported={handleImported}
            onError={msg => showToast(msg, 'error')}
          />
          <div className="border-l border-gray-700 h-10" />
          {/* Stats strip: tightened font + gap so the row fits on one line.
              All labels carry `whitespace-nowrap` so "W/L" and "MAE Heat %"
              never wrap onto two lines when the viewport narrows. */}
          <div className="flex items-center gap-4">
          <div>
            <div className="text-[11px] text-gray-500 whitespace-nowrap">Trades</div>
            <div className="font-mono text-white text-base">{trades.length}</div>
          </div>
          <div>
            <div className="text-[11px] text-gray-500 whitespace-nowrap">Win Rate</div>
            <div className="font-mono text-white text-base">{winRate.toFixed(0)}%</div>
          </div>
          <div>
            <div className="text-[11px] text-gray-500 whitespace-nowrap">W / L</div>
            <div className="font-mono text-base whitespace-nowrap">
              <span className="text-green-400">{winCount}</span>
              <span className="text-gray-600">/</span>
              <span className="text-red-400">{lossCount}</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-gray-500 whitespace-nowrap">PnL</div>
            <div className={`font-mono text-base whitespace-nowrap ${computedPnl > 0 ? 'text-green-400' : computedPnl < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              {`${computedPnl >= 0 ? '+' : '−'}$${Math.abs(computedPnl).toFixed(2)}`}
            </div>
          </div>
          {/* Avg MFE/MAE — inline variant, drops between PnL and MFE Realized %.
              Uses pts/$/×ATR toggle synced with the Dashboard card via localStorage. */}
          <AvgMfeMaeCard trades={trades} variant="inline" />
          <div className="relative">
            <div className="text-[11px] text-gray-500 whitespace-nowrap flex items-center gap-1">
              MFE Realized %
              <button
                type="button"
                onClick={() => { setMfeInfoOpen(o => !o); setMaeInfoOpen(false) }}
                className={`transition-colors ${mfeInfoOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                title="What is MFE Realized %?"
              >
                <HelpCircle className="w-3 h-3" />
              </button>
            </div>
            <div className={`font-mono text-base ${captureStats.avg == null ? 'text-gray-500'
              : captureStats.avg < 0 ? 'text-red-400 font-bold'
              : 'text-gray-400'}`}>
              {captureStats.avg == null ? '—' : `${(captureStats.avg * 100).toFixed(0)}%`}
            </div>
            {mfeInfoOpen && (
              <div
                ref={mfeInfoRef}
                className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal"
              >
                <div className="flex items-start justify-between mb-2">
                  <p className="font-semibold text-white">MFE Realized %</p>
                  <button type="button" onClick={() => setMfeInfoOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="mb-2">
                  Averaged across <strong>{captureStats.count}</strong> trade{captureStats.count === 1 ? '' : 's'} on this day. <em>How much of the favorable move did you actually book?</em>
                </p>
                <p className="mb-2 text-gray-400">
                  = realized PnL ÷ peak favorable excursion (in $) — bounded by entry → exit, so it measures execution <em>while you held</em>.
                </p>
                <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-400">
                  <li><strong>100%</strong>: exited at the high — perfect timing</li>
                  <li><strong>50%</strong>: trade ran +2R, you took +1R — cut a runner</li>
                  <li><strong>0% or negative</strong>: <strong className="text-red-300">give-back</strong> — trade went green then closed at a loss</li>
                </ul>
                <p className="text-gray-500">Red bold appears only when the day averaged a give-back.</p>
              </div>
            )}
          </div>
          <div className="relative">
            <div className="text-[11px] text-gray-500 whitespace-nowrap flex items-center gap-1">
              MAE Heat %
              <button
                type="button"
                onClick={() => { setMaeInfoOpen(o => !o); setMfeInfoOpen(false) }}
                className={`transition-colors ${maeInfoOpen ? 'text-blue-300' : 'text-gray-600 hover:text-gray-300'}`}
                title="What is MAE Heat %?"
              >
                <HelpCircle className="w-3 h-3" />
              </button>
            </div>
            <div className={`font-mono text-base ${heatStats.avg == null ? 'text-gray-500'
              : heatStats.avg > 1.0 ? 'text-red-400 font-bold'
              : 'text-gray-400'}`}>
              {heatStats.avg == null ? '—' : `${(heatStats.avg * 100).toFixed(0)}%`}
            </div>
            {maeInfoOpen && (
              <div
                ref={maeInfoRef}
                className="fixed z-50 top-24 right-6 w-80 max-h-[calc(100vh-7rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs text-gray-300 text-left shadow-xl normal-case font-normal"
              >
                <div className="flex items-start justify-between mb-2">
                  <p className="font-semibold text-white">MAE Heat %</p>
                  <button type="button" onClick={() => setMaeInfoOpen(false)} className="text-gray-500 hover:text-white -mt-0.5 -mr-0.5" aria-label="Close">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <p className="mb-2">
                  Averaged across <strong>{heatStats.count}</strong> trade{heatStats.count === 1 ? '' : 's'} on this day. <em>How much of your planned risk did you sit through before exiting?</em>
                </p>
                <p className="mb-2 text-gray-400">
                  = peak adverse excursion ÷ planned stop distance (entry − stop_price) — separate from realized $ PnL.
                </p>
                <ul className="list-disc pl-4 space-y-1 mb-2 text-gray-400">
                  <li><strong>0–50%</strong>: clean entry, light pressure</li>
                  <li><strong>50–100%</strong>: meaningful heat but stop respected</li>
                  <li><strong>&gt; 100%</strong>: <strong className="text-red-300">past stop</strong> — moved, slipped, or reversed in time to save you</li>
                </ul>
                <p className="text-gray-500">Red bold appears only when the day averaged &gt; 100%.</p>
              </div>
            )}
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
            onClick={() => setChartView('live')}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              chartView === 'live' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <CandlestickChart className="w-3.5 h-3.5" /> Live chart
          </button>
          <button
            type="button"
            onClick={() => setChartView('screenshot')}
            className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
              chartView === 'screenshot' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
            }`}
          >
            <ImageIcon className="w-3.5 h-3.5" /> Screenshot
          </button>
        </div>
      </div>

      {chartView === 'live' ? (
        <LiveChart
          date={date}
          symbol={chartSymbol}
          trades={trades}
          refreshKey={barsVersion}
          hoverTradeId={hoveredTradeId}
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
        onRowOpen={id => router.push(`/intraday/${date}?trade=${id}`)}
        summaries={summaries}
        summariesLoading={summariesLoading}
        liveAtrByTradeId={liveAtrByTradeId}
        postExitByTradeId={postExitByTradeId}
        bars={bars}
      />

      <RecordingCommentary trades={trades} onTradesChanged={refreshTrades} />

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

      {/* Cursor-following hover popup removed — the live chart already pops
          up the same trade details (+ screenshot, + tags) on the chart
          itself via hoverTradeId, so this duplicated the info next to the
          cursor while the trade log row was hovered. One popup, one spot. */}
    </div>
  )
}
