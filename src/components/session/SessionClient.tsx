'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import Link from 'next/link'
import { Crosshair, Image as ImageIcon, CandlestickChart, Upload, Share2, Flag, Loader2, GitMerge, Trash2, Tag, X } from 'lucide-react'
import { deleteBlob } from '@/lib/storage'
import EodNotesForm from '@/components/eod/EodNotesForm'
import ChartScreenshotPanel from '@/components/eod/ChartScreenshotPanel'
import CalibrationOverlay, { type CalibStep, type CalibDraft } from '@/components/eod/CalibrationOverlay'
import TradeArrowOverlay from '@/components/eod/TradeArrowOverlay'
import LiveChart, { type LiveChartHandle } from '@/components/charts/LiveChart'
import { useChartInstruments } from '@/lib/use-chart-instruments'
import BarWatcher from '@/components/charts/BarWatcher'
import SessionTradeTable from './SessionTradeTable'
import TradeContextMenu, { type TradeContextMenuState } from './TradeContextMenu'
import TradeEditDrawer from './TradeEditDrawer'
import BulkTagModal from './BulkTagModal'
import PasteStrip from './PasteStrip'
import TradeForm from '@/components/intraday/TradeForm'
import ImportTradesButton, { type ImportResult } from '@/components/eod/ImportTradesButton'
import SCFolderWatcher from '@/components/eod/SCFolderWatcher'
import EodAnalysisCard from '@/components/eod/EodAnalysisCard'
import TapeScoreHeader from '@/components/eod/TapeScoreHeader'
import type { EntryRuleConfig } from '@/lib/entry-rules'
import type { RunnerRuleConfig } from '@/lib/runner-rules'
import RecordingCommentary from '@/components/eod/RecordingCommentary'
import BrowserRecap from '@/components/eod/BrowserRecap'
import TradeManagementCard from '@/components/TradeManagementCard'
import HeatBaseline from '@/components/eod/HeatBaseline'
import { summarizeTodayHeat, type HeatBaseline as HeatBaselineData } from '@/lib/heat-baseline'
import BehavioralProxiesPanel from '@/components/eod/BehavioralProxiesPanel'
import AchievementBadges from '@/components/AchievementBadges'
import AchievementShowcase from '@/components/eod/AchievementShowcase'
import { dayAchievements, type AchievementId } from '@/lib/achievements'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import { useSessionClock } from '@/lib/use-session-clock'
import { rthCloseMs } from '@/lib/rth'
import { mgmtTotals } from '@/lib/trade-management'
import { aggregateRoundTrips } from '@/lib/trade-excursion'
import { buildHighlights } from '@/lib/trade-highlights'
import { effectiveAnalysis, sizeUpTradeIds } from '@/lib/tapescore-day-rules'
import { perTrade, type PerTrade } from '@/lib/trade-r'
import { mergeTradeTags } from '@/lib/suggest-tags'
import SessionTabs from './SessionTabs'
import type { RiskYardstick } from '@/lib/exit-score'
import type {
  TradingDay,
  Trade,
  TradeTag,
  TradeTags,
  ChartCalibration,
  MarketContext,
  EodAiAnalysis,
} from '@/lib/supabase/types'

/**
 * The Session page — the Log and the Recap as one page (Session merge, build
 * scope 2026-10-29; mockup board SessionOnePage).
 *
 * While the session is live (today, before the RTH close, not ended with "I'm
 * done") it is a write surface: paste / add trades, the chart, the trade table
 * in its capture columns, the journal. No score, verdicts or AI on screen.
 * After the close the same page carries the recap: the score card, the table's
 * review columns, the behaviour flags and the session analysis.
 */
interface Props {
  date: string
  initialDay: TradingDay | null
  initialTrades: Trade[]
  initialMarketContext: MarketContext | null
  allTags: TradeTag[]
  /** Server's read of the clock at render: today, before the close. Used until
   *  the client clock mounts, so the first paint is already in the right mode
   *  and a live session never flashes its score. */
  initialLive: boolean
  /** day_types from Prep — seeds a NEW trade's day-type tag. */
  prepDayTypes?: string[]
  /** Show the Replay Review tab (decided on the server — see deep-dive-access.ts). */
  deepDive?: boolean
  /** trade.id → live ATR-10 at entry (points), from 1-min bars server-side. */
  liveAtrByTradeId?: Record<string, number>
  /** trade.id → post-exit continuation @30m, from bars server-side. */
  postExitByTradeId?: Record<string, import('@/lib/atr').PostExitData>
  /** All realized session P&Ls, for the Career Day / Heat Check badges. */
  pnlHistory?: { date: string; pnl: number }[]
  /** Lifetime earned-achievement counts (the showcase's ×N). */
  achievementCounts?: Record<AchievementId, number>
  /** The trader's heat split over the trailing book; null when too thin. */
  heatBaseline?: HeatBaselineData | null
  /** The trader's "was up" multiple (×ATR); defaults to 1×. */
  giveBackAtr?: number
  /** Planned-risk yardstick going INTO this day (src/lib/exit-rollup.ts). */
  riskYardstick?: RiskYardstick | null
  /** ATR stop setting (default 1) — Risk's "Stop size". */
  atrStopTarget?: number
  /** Include the order-flow Score in Entry (default on). */
  includeFlowScore?: boolean
  entryRules?: EntryRuleConfig[]
  runnerRules?: RunnerRuleConfig[]
  /** Daily loss limit in dollars (positive); null = not tracked. */
  dailyLossLimit?: number | null
  /** Usual Net $ / R / risk per trade over the last 10 sessions; null = none. */
  usualPerTrade?: PerTrade | null
}

/** The trade form shown in the page: a new trade (pasted or typed), or one
 *  trade's full log ("Open full log" from the drawer or the row menu). */
type FormMode = { type: 'none' } | { type: 'add'; file: File | null } | { type: 'edit'; trade: Trade }

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

/** "1:00 PM" / "11:45 AM" in Pacific — explicit zone so the server (UTC) and
 *  the browser draw the same text. */
const PT_SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' })
const ptShort = (ms: number | string) => {
  const p = Object.fromEntries(PT_SHORT.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return `${p.hour}:${p.minute} ${p.dayPeriod}`
}

const pnlColor = (p: number) => (p > 0 ? 'text-green-400' : p < 0 ? 'text-red-400' : 'text-gray-300')

export default function SessionClient({
  date,
  initialDay,
  initialTrades,
  initialMarketContext,
  allTags: initialAllTags,
  initialLive,
  prepDayTypes,
  deepDive = false,
  liveAtrByTradeId,
  postExitByTradeId,
  pnlHistory,
  achievementCounts,
  heatBaseline = null,
  giveBackAtr = 1,
  riskYardstick = null,
  atrStopTarget = 1,
  includeFlowScore = true,
  entryRules,
  runnerRules,
  dailyLossLimit = null,
  usualPerTrade = null,
}: Props) {
  const router = useRouter()
  const [day, setDay] = useState<TradingDay | null>(initialDay)
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
  const [allTags, setAllTags] = useState<TradeTag[]>(initialAllTags)
  const addTag = (tag: TradeTag) =>
    setAllTags(prev => (prev.some(t => t.id === tag.id) ? prev : [...prev, tag]))

  // ── Live vs recap ──
  // `endedAt` is kept apart from `day` because "I'm done" can be the first
  // write of a day that has no trading_days row yet.
  const [endedAt, setEndedAt] = useState<string | null>(initialDay?.session_ended_at ?? null)
  const clock = useSessionClock(date)
  const beforeClose = clock.mounted ? clock.isToday && clock.beforeClose : initialLive
  const live = beforeClose && !endedAt
  const closeMs = rthCloseMs(date)
  const closeLabel = Number.isFinite(closeMs) ? ptShort(closeMs) : '1:00 PM'
  const endedAtLabel = endedAt ? ptShort(endedAt) : null
  const [ending, setEnding] = useState(false)

  const endSession = async () => {
    if (ending) return
    if (!confirm(
      'End the session now and run your recap?\n\n' +
      'You can still add a missed trade afterward, but a trade entered after this ' +
      'is flagged as re-opening the session — the tape holds you to calling it done.',
    )) return
    setEnding(true)
    try {
      const res = await fetch(`/api/trading-days/${date}/end-session`, { method: 'POST' })
      if (!res.ok) { showToast('Could not end the session. Please try again.', 'error'); return }
      const data = await res.json() as { endedAt?: string; day?: TradingDay | null }
      if (data.day) setDay(data.day)
      setEndedAt(data.endedAt ?? new Date().toISOString())
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch {
      showToast('Could not end the session. Please try again.', 'error')
    } finally {
      setEnding(false)
    }
  }

  // ── Toasts ──
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Adding / editing trades ──
  const [formMode, setFormMode] = useState<FormMode>({ type: 'none' })
  // Recap edit-in-place drawer: the id of the trade being quick-edited.
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null)
  const startFromFile = (file: File) => setFormMode({ type: 'add', file })
  const startManual = () => setFormMode({ type: 'add', file: null })
  const openFullLog = (id: string) => {
    const t = trades.find(x => x.id === id)
    if (!t) return
    setEditingTradeId(null)
    setFormMode({ type: 'edit', trade: t })
  }
  // Bring an opened form into view, so starting one from a lower row isn't silent.
  useEffect(() => {
    if (formMode.type === 'none') return
    document.getElementById('session-trade-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [formMode])
  // Ctrl+V anywhere on the page starts a trade from the pasted screenshot —
  // unless a form or the drawer already has the trader's attention.
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (formMode.type !== 'none' || editingTradeId) return
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) startFromFile(file)
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [formMode.type, editingTradeId])
  const handleFormSave = (saved: Trade) => {
    setTrades(prev => {
      const exists = prev.some(t => t.id === saved.id)
      const next = exists ? prev.map(t => (t.id === saved.id ? saved : t)) : [...prev, saved]
      return next.sort((a, b) => (a.entry_time ?? '').localeCompare(b.entry_time ?? ''))
    })
    setFormMode({ type: 'none' })
  }

  // ── Row hover / jump spotlight ──
  // The chart follows the hovered row (hoverTradeId); a jump (chart double-click
  // or ?trade= deep-link) rings the row for ~5 s so it's obvious which one.
  const [hoveredTradeId, setHoveredTradeId] = useState<string | null>(null)
  const [flashTradeId, setFlashTradeId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTrade = (id: string) => {
    setFlashTradeId(id)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashTradeId(null), 5000)
  }
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) }, [])
  const searchParams = useSearchParams()
  const deepLinkTradeId = searchParams.get('trade')
  useEffect(() => {
    if (!deepLinkTradeId) return
    const el = document.getElementById(`trade-${deepLinkTradeId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link highlight: mark the linked trade so its row + chart arrow stand out on arrival
    setHoveredTradeId(deepLinkTradeId)
    flashTrade(deepLinkTradeId)
  }, [deepLinkTradeId, trades])
  const handleHoverEnter = (tradeId: string) => setHoveredTradeId(tradeId)
  const handleHoverLeave = () => setHoveredTradeId(null)

  // Right-click menu on a trade row.
  const [tradeMenu, setTradeMenu] = useState<TradeContextMenuState | null>(null)

  // ── Analysis ──
  const [analyzing, setAnalyzing] = useState(false)
  const [aiAnalysis, setAiAnalysis] = useState<EodAiAnalysis | null>(() => {
    const a = initialDay?.eod_ai_analysis_json
    return a && Object.keys(a).length > 0 ? (a as EodAiAnalysis) : null
  })
  // The analysis as TapeScore reads it — the stored audit with the read-time
  // corrections from the day's trades, so the score card and the rules card
  // can't disagree (src/lib/tapescore-day-rules.ts).
  const scoredAnalysis = useMemo(
    () => effectiveAnalysis(aiAnalysis, trades, riskYardstick),
    [aiAnalysis, trades, riskYardstick],
  )
  const pressingIds = useMemo(() => sizeUpTradeIds(trades, riskYardstick), [trades, riskYardstick])
  const dayPerTrade = useMemo(() => perTrade(trades), [trades])
  const { mode: uiMode } = useUiMode()

  // On-chart highlight chips (P&L + score) — recap only, since they carry the score.
  const highlights = useMemo(() => buildHighlights(trades, aiAnalysis), [trades, aiAnalysis])
  const toggleHighlight = async (tradeId: string) => {
    const t = trades.find(x => x.id === tradeId)
    if (!t) return
    const next = !t.highlighted
    setTrades(prev => prev.map(x => (x.id === tradeId ? { ...x, highlighted: next } : x)))
    try {
      const res = await fetch(`/api/trades/${tradeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ highlighted: next }),
      })
      if (!res.ok) throw new Error(String(res.status))
    } catch {
      setTrades(prev => prev.map(x => (x.id === tradeId ? { ...x, highlighted: !next } : x)))
      showToast('Could not save the highlight.', 'error')
    }
  }

  // ── Chart ──
  // 'live' = native bars; 'screenshot' = the legacy uploaded chart + calibration.
  const [chartView, setChartView] = useState<'screenshot' | 'live'>('live')
  const [barsVersion, setBarsVersion] = useState(0)
  const liveChartRef = useRef<LiveChartHandle | null>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const [chartUrl, setChartUrl] = useState<string | null>(initialDay?.eod_chart_screenshot_url ?? null)
  const [uploadingChart, setUploadingChart] = useState(false)
  const [calibration, setCalibration] = useState<ChartCalibration | null>(initialDay?.chart_calibration_json ?? null)
  const [calibMode, setCalibMode] = useState<{ step: CalibStep; draft: CalibDraft } | null>(null)
  const [savingCalib, setSavingCalib] = useState(false)
  // Most-common symbol on the day; NQ on an empty day so the chart still snaps
  // to the latest session instead of disappearing.
  const chartSymbol = useMemo<string | null>(() => {
    const counts = new Map<string, number>()
    for (const t of trades) if (t.symbol) counts.set(t.symbol, (counts.get(t.symbol) ?? 0) + 1)
    let best: string | null = null
    let bestCount = 0
    for (const [sym, c] of counts) if (c > bestCount) { best = sym; bestCount = c }
    return best
  }, [trades])
  const { activeSymbol, symbolOptions, onSymbolChange, chartTrades } = useChartInstruments(chartSymbol ?? 'NQ', trades, date)

  // ── AI overview lines (recap only) ──
  // Cached in localStorage by content hash; misses go in one batched call.
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summariesLoading, setSummariesLoading] = useState(false)
  useEffect(() => {
    if (live || trades.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no AI lines while live or on an empty day
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
  }, [trades, live])

  const refreshTrades = async () => {
    try {
      const res = await fetch(`/api/trades?date=${date}`)
      if (!res.ok) return
      setTrades((await res.json()) as Trade[])
    } catch {
      // best-effort refresh; toast already shown on import errors
    }
  }

  const toBase64 = async (source: File | string): Promise<{ data: string; mediaType: string } | null> => {
    try {
      const blob = source instanceof File ? source : await fetch(source).then(r => r.blob())
      return await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const [header, data] = (reader.result as string).split(',')
          resolve({ data, mediaType: header.match(/:(.*?);/)?.[1] ?? 'image/png' })
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
      const image = chartUrl && !chartUrl.startsWith('blob:') ? await toBase64(chartUrl) : null
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
          sessionEndedAt: endedAt,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast(`Analysis failed: ${err.error ?? 'unknown'}`, 'error')
        return
      }
      const analysis = (await res.json()) as EodAiAnalysis
      setAiAnalysis(analysis)
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
      showToast(
        `Imported ${result.inserted} trades` +
          (result.skippedDuplicates ? ` (${result.skippedDuplicates} duplicates skipped)` : '') +
          (result.skippedFiltered ? ` (${result.skippedFiltered} filtered out)` : ''),
        'success',
      )
    }
    // A Sierra log routinely covers more than the day you picked — say where
    // the other sessions' trades went rather than filing them silently.
    if (result.dates && result.dates.length > 1) {
      const others = result.dates.filter(d => d.date !== date)
      const otherTrades = others.reduce((a, d) => a + d.trades, 0)
      showToast(
        `That log covered ${result.dates.length} sessions (${result.dates[0].date} → ${result.dates[result.dates.length - 1].date}). ` +
        `${otherTrades} trade${otherTrades === 1 ? '' : 's'} went to ${others.length} other day${others.length === 1 ? '' : 's'}, not ${date}.`,
        'success',
      )
    }
    if (result.droppedColumns) {
      const dropped = Object.entries(result.droppedColumns).map(([scope, cols]) => `${scope}: ${cols.join(', ')}`).join(' · ')
      showToast(`Some columns weren't written — ${dropped}. Run schema migration in Supabase to enable.`, 'error')
    }
    await refreshTrades()
    try {
      const res = await fetch(`/api/trading-days/${date}`)
      if (res.ok) {
        const { day: refreshed } = await res.json()
        if (refreshed) setDay(refreshed as TradingDay)
      }
    } catch { /* ignore */ }
  }

  // Mint (or reuse) a read-only coach-review link for this day and copy it.
  const [sharing, setSharing] = useState(false)
  const shareForReview = async () => {
    if (!day?.id) return
    setSharing(true)
    try {
      // Capture the chart first so the link preview exists by the time it's
      // pasted. Best-effort: a failed capture only costs the thumbnail.
      if (chartView === 'live') {
        try {
          const shot = await liveChartRef.current?.takeScreenshotPng()
          if (shot?.data) {
            await fetch('/api/share/preview', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ date, dataUrl: `data:image/png;base64,${shot.data}` }),
            })
          }
        } catch { /* thumbnail is optional; the link is not */ }
      }
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trading_day_id: day.id }),
      })
      const json = await res.json()
      if (!res.ok || !json.url) { showToast(json.error || 'Could not create link', 'error'); return }
      await navigator.clipboard.writeText(json.url).catch(() => {})
      showToast('Review link copied — send it to your coach', 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Share failed', 'error')
    } finally {
      setSharing(false)
    }
  }

  // ── Legacy chart screenshot + calibration ──
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
      if (!upRes.ok || !upData.url) { showToast(`Upload failed: ${upData.error ?? 'unknown error'}`, 'error'); return }
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
      if (previousUrl && previousUrl !== upData.url) void deleteBlob(previousUrl)
      showToast('EOD chart saved', 'success')
    } catch (e) {
      showToast(`Error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setUploadingChart(false)
    }
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
    if (step === 'high' || step === 'low') newDraft[step] = { ...pos, price: (value as { price: number }).price }
    else newDraft[step] = { ...pos, time: (value as { time: string }).time }

    const nextIdx = STEP_ORDER.indexOf(step) + 1
    if (nextIdx < STEP_ORDER.length) {
      setCalibMode({ step: STEP_ORDER[nextIdx], draft: newDraft })
      return
    }
    if (!newDraft.high || !newDraft.low || !newDraft.start || !newDraft.end) {
      showToast('Calibration incomplete', 'error')
      return
    }
    setSavingCalib(true)
    try {
      const res = await fetch(`/api/trading-days/${date}/calibration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ high: newDraft.high, low: newDraft.low, start: newDraft.start, end: newDraft.end }),
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

  // ── Day numbers ──
  const computedPnl = useMemo(() => trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0), [trades])
  const winCount = trades.filter(t => (t.pnl ?? 0) > 0).length
  const lossCount = trades.filter(t => (t.pnl ?? 0) < 0).length
  const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0
  // Trade management (src/lib/trade-management.ts), with the same live ATR and
  // "was up" multiple the round-trip panel uses.
  const mgmt = useMemo(
    () => mgmtTotals(trades, { atrByTradeId: liveAtrByTradeId, thresholdAtr: giveBackAtr }),
    [trades, liveAtrByTradeId, giveBackAtr],
  )
  const todayHeat = useMemo(() => summarizeTodayHeat(trades), [trades])
  const roundTripStats = useMemo(() => aggregateRoundTrips(trades, liveAtrByTradeId, giveBackAtr), [trades, liveAtrByTradeId, giveBackAtr])
  const achievements = useMemo(() => {
    const dayPnl = day?.eod_pnl ?? (trades.length > 0 ? computedPnl : null)
    const dayRangePts = initialMarketContext?.day_range ?? null
    return dayAchievements({ date, dayPnl, trades, pnlHistory, dayRangePts })
  }, [date, day?.eod_pnl, trades, computedPnl, pnlHistory, initialMarketContext?.day_range])

  // ── Selection: bulk tag / merge / delete ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [merging, setMerging] = useState(false)
  const [deletingTradeId, setDeletingTradeId] = useState<string | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const toggleTradeSelection = (id: string) =>
    setSelectedIds(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s })
  const clearSelection = () => setSelectedIds(new Set())

  // Same direction within ±60 s → likely the same fill logged twice (a pasted
  // trade and its imported twin). A visual hint for the merge flow only.
  const nearDuplicateIds = useMemo(() => {
    const flagged = new Set<string>()
    for (let i = 0; i < trades.length; i++) {
      const a = trades[i]
      if (!a.entry_time) continue
      const aMs = new Date(a.entry_time).getTime()
      for (let j = i + 1; j < trades.length; j++) {
        const b = trades[j]
        if (!b.entry_time || b.direction !== a.direction) continue
        if (Math.abs(new Date(b.entry_time).getTime() - aMs) <= 60_000) { flagged.add(a.id); flagged.add(b.id) }
      }
    }
    return flagged
  }, [trades])

  const tradeLine = (t: Trade) =>
    `${t.entry_time ? format(new Date(t.entry_time), 'HH:mm:ss') : '--:--:--'} ${t.direction?.toUpperCase() ?? '--'} @ ${t.entry_price ?? '--'}`

  const handleMergeSelected = async () => {
    if (selectedIds.size !== 2) return
    const [idA, idB] = Array.from(selectedIds)
    const a = trades.find(t => t.id === idA)
    const b = trades.find(t => t.id === idB)
    if (!a || !b) return
    const fmtT = (t: Trade) => `${tradeLine(t)} qty ${t.quantity ?? '--'}${t.sierra_trade_id ? ' [SC]' : ' [manual]'}`
    if (!confirm(
      `Merge these two trades into one?\n\n  ${fmtT(a)}\n  ${fmtT(b)}\n\n` +
      `The SC-imported trade keeps its fill data (time, price, qty, pnl). ` +
      `The manual trade's tags, notes, screenshot, and stop/TP levels are ` +
      `carried over. The other row is deleted.\n\nThis cannot be undone.`,
    )) return
    setMerging(true)
    try {
      const res = await fetch('/api/trades/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeIds: [idA, idB] }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(`Merge failed: ${data.error ?? 'unknown error'}`, 'error'); return }
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
    if (!confirm(`Delete trade ${tradeLine(t)}?\n\nThis permanently removes the row${t.sierra_trade_id ? ' (will re-appear on next SC log re-import if the fill is still in the log)' : ''}. Cannot be undone.`)) return
    setDeletingTradeId(id)
    try {
      const res = await fetch(`/api/trades/${id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(`Delete failed: ${data.error ?? res.statusText}`, 'error'); return }
      if (t.screenshot_url) await deleteBlob(t.screenshot_url).catch(() => { /* non-fatal */ })
      setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
      setTrades(prev => prev.filter(x => x.id !== id))
      showToast('Trade deleted', 'success')
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
    } finally {
      setDeletingTradeId(null)
    }
  }

  const handleBulkDelete = async () => {
    const selected = trades.filter(t => selectedIds.has(t.id))
    if (selected.length === 0) return
    if (!confirm(
      `Delete ${selected.length} trade${selected.length === 1 ? '' : 's'}?\n\n` +
      selected.map(t => `  • ${tradeLine(t)}${t.sierra_trade_id ? ' [SC]' : ' [manual]'}`).join('\n') +
      `\n\nThis permanently removes the rows${selected.some(t => t.sierra_trade_id) ? ' (SC-imported ones will re-appear on next log re-import)' : ''}. Cannot be undone.`,
    )) return
    setBulkDeleting(true)
    const deleted = new Set<string>()
    for (const t of selected) {
      try {
        const res = await fetch(`/api/trades/${t.id}`, { method: 'DELETE' })
        if (res.ok) {
          deleted.add(t.id)
          if (t.screenshot_url) void deleteBlob(t.screenshot_url).catch(() => { /* non-fatal */ })
        }
      } catch { /* counted as failed below */ }
    }
    setTrades(prev => prev.filter(t => !deleted.has(t.id)))
    clearSelection()
    setBulkDeleting(false)
    const failed = selected.length - deleted.size
    if (failed === 0) showToast(`Deleted ${deleted.size} trade${deleted.size === 1 ? '' : 's'}`, 'success')
    else if (deleted.size === 0) showToast(`All ${failed} deletes failed`, 'error')
    else showToast(`Deleted ${deleted.size}, ${failed} failed`, 'error')
  }

  // Additive: each selected trade keeps its tags and gains the picked ones.
  const handleBulkApplyTags = async (toAdd: TradeTags) => {
    if (selectedIds.size === 0) return
    setBulkApplying(true)
    const updated: Trade[] = []
    for (const t of trades.filter(x => selectedIds.has(x.id))) {
      const res = await fetch(`/api/trades/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags_json: mergeTradeTags(t.tags_json as TradeTags | undefined, toAdd) }),
      })
      if (res.ok) updated.push(await res.json() as Trade)
    }
    if (updated.length > 0) {
      const byId = new Map(updated.map(t => [t.id, t]))
      setTrades(prev => prev.map(t => byId.get(t.id) ?? t))
    }
    setBulkApplying(false)
    setBulkTagOpen(false)
    clearSelection()
  }

  // ── Status chip ──
  // Live / ended by you / closed / a past day's recap. (The full seam set —
  // "Run my recap", reopened — is the next step of the build.)
  const status = live
    ? { text: `Live · market closes ${closeLabel}`, tone: 'live' as const }
    : endedAtLabel
      ? { text: `Ended by you at ${endedAtLabel}`, tone: 'ended' as const }
      : clock.mounted && clock.isToday
        ? { text: `Market closed ${closeLabel}`, tone: 'plain' as const }
        : { text: 'Recap', tone: 'plain' as const }

  const tradeForm = formMode.type !== 'none' && (
    <div id="session-trade-form" className="scroll-mt-4">
      {formMode.type === 'edit' ? (
        <TradeForm
          key={formMode.trade.id}
          date={date}
          allTags={allTags}
          trade={formMode.trade}
          onTagCreated={addTag}
          defaultSymbol={chartSymbol}
          dayTrades={trades}
          onSave={handleFormSave}
          onCancel={() => setFormMode({ type: 'none' })}
        />
      ) : (
        <TradeForm
          date={date}
          allTags={allTags}
          initialFile={formMode.file}
          prepDayTypes={prepDayTypes}
          onTagCreated={addTag}
          defaultSymbol={chartSymbol}
          dayTrades={trades}
          onSave={handleFormSave}
          onCancel={() => setFormMode({ type: 'none' })}
        />
      )}
    </div>
  )

  return (
    <div className="space-y-5">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Header: title, day, status · then the day's actions. */}
      <div data-tour="eod-header" className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
        <h1 className="text-[22px] font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Session</h1>
        <SessionTabs day={date} active="day" deepDive={deepDive} onPickDay={next => router.push(`/session/${next}`)} />
        <span
          className={`inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-0.5 border ${
            status.tone === 'live' || status.tone === 'ended'
              ? 'text-emerald-300 bg-emerald-950/40 border-emerald-800/60'
              : 'text-gray-300 bg-gray-800/60 border-gray-700'
          }`}
        >
          {status.tone === 'live' && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
          {status.text}
        </span>
        {!live && <AchievementBadges items={achievements} />}
        <span className="flex-1" />
        {LOCAL_FEATURES_ENABLED && (
          <>
            <SCFolderWatcher onActivity={(msg, type) => showToast(msg, type)} onImported={refreshTrades} />
            <BarWatcher activeDate={date} onRefresh={() => setBarsVersion(v => v + 1)} />
            <ImportTradesButton date={date} onImported={handleImported} onError={msg => showToast(msg, 'error')} />
          </>
        )}
        {!LOCAL_FEATURES_ENABLED && (
          <Link
            href="/import"
            className={`inline-flex items-center gap-1.5 text-xs rounded-md px-2.5 min-h-9 transition-colors ${
              trades.length === 0 && !live
                ? 'bg-blue-600 hover:bg-blue-500 text-white font-medium border border-blue-500'
                : 'bg-gray-800 border border-gray-700 text-gray-200 hover:bg-gray-700'
            }`}
            title="Bring in a whole session from a file (CSV or Sierra Chart .txt)"
          >
            <Upload className="w-3.5 h-3.5" /> Import trade log
          </Link>
        )}
        {!LOCAL_FEATURES_ENABLED && day?.id && !live && (
          <button
            type="button"
            onClick={shareForReview}
            disabled={sharing}
            className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-md px-2.5 min-h-9 hover:bg-gray-700 transition-colors disabled:opacity-60"
            title="Copy a read-only link to share this day's chart with a coach"
          >
            <Share2 className="w-3.5 h-3.5" /> {sharing ? 'Sharing…' : 'Share'}
          </button>
        )}
        {/* "I'm done" ends the session early: the recap runs now, and ending by
            choice is recorded as a discipline event. */}
        {live && (
          <button
            type="button"
            onClick={endSession}
            disabled={ending}
            className="inline-flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-amber-600/60 text-gray-100 text-[13px] font-semibold rounded-md px-3.5 min-h-[38px] transition-colors disabled:opacity-60"
            title="End the session now and run your recap"
          >
            {ending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flag className="w-4 h-4 text-amber-400" />}
            I&rsquo;m done — end session
          </button>
        )}
      </div>

      {live ? (
        /* Live: paste strip beside the day's plain numbers — no score card. */
        <section className="flex flex-wrap gap-3 items-stretch">
          <div className="flex-[2_1_460px] min-w-0">
            <PasteStrip roomy onFile={startFromFile} onManual={startManual} />
          </div>
          <div className="flex-[1_1_300px] min-w-0 rounded-xl border border-gray-800 bg-gray-900/60 px-4 py-3.5 grid grid-cols-3 gap-2 items-center text-center">
            <div>
              <div className="text-[11px] text-gray-500">Trades</div>
              <div className="text-[22px] font-bold tabular-nums text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>{trades.length}</div>
            </div>
            <div>
              <div className="text-[11px] text-gray-500">Day P&amp;L</div>
              <div className={`text-[22px] font-bold tabular-nums ${pnlColor(computedPnl)}`} style={{ fontFamily: 'var(--font-display)' }}>
                {`${computedPnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(computedPnl)).toLocaleString('en-US')}`}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-gray-500">Wins / Losses</div>
              <div className="text-[22px] font-bold tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>
                <span className="text-green-400">{winCount}</span>
                <span className="text-gray-600"> / </span>
                <span className="text-red-400">{lossCount}</span>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* Recap: the score card (TapeScore, the day's numbers, Trade
              management in Detailed Tape), then a slim strip for a missed trade. */}
          <TapeScoreHeader
            analysis={scoredAnalysis}
            prepScore={day?.ai_analysis_json?.score ?? null}
            trades={trades}
            riskYardstick={riskYardstick}
            atrStopTarget={atrStopTarget}
            includeFlow={includeFlowScore}
            entryRules={entryRules}
            runnerRules={runnerRules}
            tradeCount={trades.length}
            winRate={winRate}
            pnl={computedPnl}
            dailyLossLimit={dailyLossLimit}
            aside={uiMode === 'pro' && trades.length > 0
              ? <TradeManagementCard totals={mgmt} className="min-w-0" perTrade={{ day: dayPerTrade, usual: usualPerTrade }} />
              : undefined}
          />
          <PasteStrip onFile={startFromFile} onManual={startManual} />
        </>
      )}

      {tradeForm}

      {/* Behaviour flags — judgment, so recap only. Self-suppressing when empty. */}
      {!live && <BehavioralProxiesPanel trades={trades} sessionEndedAt={endedAt} roundTrip={roundTripStats} pressingIds={pressingIds} />}

      {/* Chart: native bars, or the legacy uploaded screenshot + calibration. */}
      <div className="space-y-3">
        <div className="flex justify-end">
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
            ref={liveChartRef}
            date={date}
            symbol={activeSymbol}
            symbolOptions={symbolOptions}
            onSymbolChange={onSymbolChange}
            trades={chartTrades}
            refreshKey={barsVersion}
            hoverTradeId={hoveredTradeId}
            onTradeActivate={id => {
              setHoveredTradeId(id)
              flashTrade(id)
              document.getElementById(`trade-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
            onHighlightTrade={live ? undefined : toggleHighlight}
            highlights={live ? undefined : highlights}
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
                  {!calibMode && (
                    <button
                      onClick={() => setCalibMode({ step: 'high', draft: {} })}
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
                onCancel={() => setCalibMode(null)}
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
          <p className="text-xs text-gray-500 ml-1">Last import: {format(new Date(day.last_sc_import_at), 'MMM d, HH:mm')}</p>
        )}
      </div>

      {/* What the MAE column means for this trader — recap only. */}
      {!live && <HeatBaseline baseline={heatBaseline} today={todayHeat} />}

      {/* ONE trade table: capture columns while live, review columns after. */}
      {trades.length > 0 && (
        <div>
          <SessionTradeTable
            config={live ? 'capture' : 'review'}
            trades={trades}
            hoveredTradeId={hoveredTradeId}
            flashTradeId={flashTradeId}
            onHoverEnter={handleHoverEnter}
            onHoverLeave={handleHoverLeave}
            selectedIds={selectedIds}
            onToggleSelect={toggleTradeSelection}
            nearDuplicateIds={nearDuplicateIds}
            onDelete={handleDeleteTrade}
            deletingId={deletingTradeId}
            onEdit={setEditingTradeId}
            onContextMenu={live ? undefined : (tradeId, e) => setTradeMenu({ tradeId, x: e.clientX, y: e.clientY })}
            editingId={editingTradeId ?? (formMode.type === 'edit' ? formMode.trade.id : null)}
            rowIdPrefix="trade-"
            summaries={summaries}
            summariesLoading={summariesLoading}
            liveAtrByTradeId={liveAtrByTradeId}
            giveBackAtr={giveBackAtr}
            postExitByTradeId={postExitByTradeId}
            entryRules={entryRules}
            runnerRules={runnerRules}
            includeFlow={includeFlowScore}
            atrStopTarget={atrStopTarget}
          />
          {live && (
            <p className="mt-2 text-xs text-gray-500">No scores, verdicts or AI while the market is open. The same table gains them in the recap.</p>
          )}
        </div>
      )}

      <TradeContextMenu
        state={tradeMenu}
        onClose={() => setTradeMenu(null)}
        onOpenIntraday={openFullLog}
        openLabel="Open full log"
        openHint="Edit the screenshot, levels and direction"
        onHighlight={toggleHighlight}
        isHighlighted={(id: string) => !!trades.find(t => t.id === id)?.highlighted}
      />

      {/* Edit-in-place drawer; "Open full log" opens the full form on this page. */}
      {editingTradeId && (() => {
        const editingTrade = trades.find(tr => tr.id === editingTradeId)
        if (!editingTrade) return null
        return (
          <TradeEditDrawer
            trade={editingTrade}
            date={date}
            allTags={allTags}
            defaultSymbol={chartSymbol}
            onSave={saved => {
              setTrades(prev => prev.map(tr => (tr.id === saved.id ? saved : tr)))
              setEditingTradeId(null)
              showToast('Trade updated', 'success')
            }}
            onClose={() => setEditingTradeId(null)}
            onOpenFullLog={openFullLog}
            onTagCreated={addTag}
          />
        )
      })()}

      {/* Recording recap (local: ffmpeg; cloud: decoded in the browser) — recap only. */}
      {!live && LOCAL_FEATURES_ENABLED && <RecordingCommentary trades={trades} onTradesChanged={refreshTrades} />}
      {!live && !LOCAL_FEATURES_ENABLED && <BrowserRecap trades={trades} date={date} onTradesChanged={refreshTrades} />}

      {/* Session analysis + journal. The journal is the same trading_days.eod_notes
          field live or not; the AI analysis waits for the recap. */}
      <div className="flex flex-wrap gap-3.5 items-start">
        {!live && (
          <div data-tour="eod-analyze" className="flex-[2_1_480px] min-w-0">
            <EodAnalysisCard
              analysis={scoredAnalysis}
              loading={analyzing}
              onAnalyze={runAnalysis}
              disabled={trades.length === 0 && !day?.eod_notes}
              latestTradeUpdate={trades.reduce<string | null>((max, t) => {
                if (!t.updated_at) return max
                return max == null || t.updated_at > max ? t.updated_at : max
              }, null)}
            />
          </div>
        )}
        <div className="flex-[1_1_300px] min-w-0">
          <EodNotesForm
            date={date}
            initialNotes={day?.eod_notes ?? ''}
            initialPnl={day?.eod_pnl ?? null}
            computedPnl={computedPnl}
            onSaved={(notes, pnl, auto) => {
              setDay(prev => prev ? { ...prev, eod_notes: notes, eod_pnl: pnl } : prev)
              if (!auto) showToast('Journal saved', 'success')
            }}
            onError={msg => showToast(msg, 'error')}
          />
        </div>
      </div>

      {!live && <AchievementShowcase earned={achievements} counts={achievementCounts} className="mt-2" />}

      {/* Floating bulk-action bar — appears when 1+ trades are selected. */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-gray-900 border border-gray-700 rounded-lg shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)] px-4 py-2 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-gray-300 font-medium">
            <strong>{selectedIds.size}</strong> trade{selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <span className="text-gray-700">·</span>
          <button
            type="button"
            onClick={() => setBulkTagOpen(true)}
            className="inline-flex items-center gap-1.5 text-blue-300 bg-blue-500/[0.08] border border-blue-500 hover:bg-blue-500/[0.14] px-3 py-1.5 rounded text-xs font-semibold transition-colors"
          >
            <Tag className="w-3 h-3" /> Add tags
          </button>
          <button
            type="button"
            onClick={handleMergeSelected}
            disabled={selectedIds.size !== 2 || merging}
            className="inline-flex items-center gap-1.5 text-gray-300 border border-gray-700 hover:text-gray-100 hover:border-gray-600 disabled:opacity-50 px-3 py-1.5 rounded text-xs font-semibold transition-colors"
            title={selectedIds.size === 2 ? 'Merge these two rows (manual + SC dedupe)' : 'Select exactly 2 trades to merge'}
          >
            {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />}
            Merge
          </button>
          <button
            type="button"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="inline-flex items-center gap-1.5 text-red-400 border border-red-700 hover:bg-red-400/[0.08] disabled:opacity-50 px-3 py-1.5 rounded text-xs font-semibold transition-colors"
            title={`Delete all ${selectedIds.size} selected trade${selectedIds.size === 1 ? '' : 's'}`}
          >
            {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            Delete
          </button>
          <button type="button" onClick={clearSelection} className="text-gray-500 hover:text-white transition-colors" title="Clear selection">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {bulkTagOpen && (
        <BulkTagModal
          count={selectedIds.size}
          allTags={allTags}
          applying={bulkApplying}
          onCancel={() => setBulkTagOpen(false)}
          onApply={handleBulkApplyTags}
        />
      )}
    </div>
  )
}
