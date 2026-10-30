'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { format } from 'date-fns'
import Link from 'next/link'
import { Crosshair, Image as ImageIcon, CandlestickChart, Upload, Share2, ChevronRight } from 'lucide-react'
import { deleteBlob } from '@/lib/storage'
import EodNotesForm from './EodNotesForm'
import ChartScreenshotPanel from './ChartScreenshotPanel'
import CalibrationOverlay, { type CalibStep, type CalibDraft } from './CalibrationOverlay'
import TradeArrowOverlay from './TradeArrowOverlay'
import LiveChart, { type LiveChartHandle } from '@/components/charts/LiveChart'
import { useChartInstruments } from '@/lib/use-chart-instruments'
import BarWatcher from '@/components/charts/BarWatcher'
import TradeList from './TradeList'
import TradeContextMenu, { type TradeContextMenuState } from '@/components/session/TradeContextMenu'
import TradeEditDrawer from '@/components/session/TradeEditDrawer'
import ImportTradesButton, { type ImportResult } from './ImportTradesButton'
import SCFolderWatcher from './SCFolderWatcher'
import EodAnalysisCard from './EodAnalysisCard'
import TapeScoreHeader from './TapeScoreHeader'
import { entryRulesSig, type EntryRuleConfig } from '@/lib/entry-rules'
import type { RunnerRuleConfig } from '@/lib/runner-rules'
import RecordingCommentary from './RecordingCommentary'
import BrowserRecap from './BrowserRecap'
import TradeManagementCard from '@/components/TradeManagementCard'
import HeatBaseline from './HeatBaseline'
import { summarizeTodayHeat, type HeatBaseline as HeatBaselineData } from '@/lib/heat-baseline'
import BehavioralProxiesPanel from './BehavioralProxiesPanel'
import RecapWhatHappened from './RecapWhatHappened'
import RecapTomorrow from './RecapTomorrow'
import AchievementBadges from '@/components/AchievementBadges'
import AchievementShowcase from '@/components/eod/AchievementShowcase'
import { dayAchievements, type AchievementId } from '@/lib/achievements'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import { useSessionClock } from '@/lib/use-session-clock'
import { type BarLike } from '@/lib/analytics'
import { mgmtTotals } from '@/lib/trade-management'
import { aggregateRoundTrips } from '@/lib/trade-excursion'
import { buildHighlights } from '@/lib/trade-highlights'
import { effectiveAnalysis, sizeUpTradeIds } from '@/lib/tapescore-day-rules'
import { perTrade, type PerTrade } from '@/lib/trade-r'
import type { RiskYardstick } from '@/lib/exit-score'
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
  /** All the user's realized session P&Ls ({date, pnl}) for achievement badges
   *  (Career Day percentile + Heat Check streak). Server-fetched; omit to skip
   *  those two badges. */
  pnlHistory?: { date: string; pnl: number }[]
  /** Lifetime earned-achievement counts across the user's history (server-
   *  computed from trading_days.achievements_json). Powers the showcase ×N
   *  badges + collection strip. Omit / zeros before the backfill runs. */
  achievementCounts?: Record<AchievementId, number>
  /** How the trader's trades historically split by heat (did the MAE stay
   *  inside half the planned risk?). Server-computed over the trailing book;
   *  null when it's too thin to claim anything. */
  heatBaseline?: HeatBaselineData | null
  /** The trader's round-trip "was up" multiple (×ATR) from Settings → ATR
   *  measurement. Defaults to 1× when unset / pre-migration. */
  giveBackAtr?: number
  /** The trader's risk yardstick going INTO this day (mean + SD of recent
   *  planned dollar risk) — what Risk's "Loss size" and the size-up rule are
   *  judged against (src/lib/exit-rollup.ts). Server-computed from the prior
   *  days by the same rule every surface uses. Null = fewer than 5 stop trades
   *  before this day. */
  riskYardstick?: RiskYardstick | null
  /** The trader's ATR stop setting (scoring profile; default 1) — the
   *  yardstick for Risk's "Stop size". */
  atrStopTarget?: number
  /** The trader's setting: include the order-flow Score in Entry (default on). */
  includeFlowScore?: boolean
  /** The trader's entry rules (Settings → Trading Rules) — the Rules column and Entry's "Entry rules" part. */
  entryRules?: EntryRuleConfig[]
  /** The trader's runner rules — the Runner column and Exit's "Runner rules" part. */
  runnerRules?: RunnerRuleConfig[]
  /** The trader's daily loss limit in dollars (positive); null = not tracked. The card's takeaway line reads it. */
  dailyLossLimit?: number | null
  /** Their usual Net $ / R / risk per trade over the last 10 sessions before this day (src/lib/trade-r.ts); null = none. */
  usualPerTrade?: PerTrade | null
}

// Stable content hash for a trade's summary-relevant fields, so a cached AI
// summary is reused until the tags/notes/fills or the trader's entry rules
// actually change. djb2. SUMMARY_VERSION retires every cached summary when the
// coach's input changes (2: rule results go in as facts, 2026-10-29).
const SUMMARY_VERSION = 2
function hashTrade(t: Trade, rulesSig: string): string {
  const basis = JSON.stringify({
    v: SUMMARY_VERSION, r: rulesSig,
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
  allTags: initialAllTags,
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
  const [day, setDay] = useState<TradingDay | null>(initialDay)
  const [trades, setTrades] = useState<Trade[]>(initialTrades)
  // Recap edit-in-place drawer (Session-merge Pt 13 step 2): the id of the trade
  // being quick-edited, or null when the drawer is closed.
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null)
  // Right-click menu on a trade row, and the trade currently "highlighted"
  // (P&L + its own execution score) from that menu.
  const [tradeMenu, setTradeMenu] = useState<TradeContextMenuState | null>(null)
  // Tags are local so a label created inline from the drawer's TagSelector
  // shows up immediately instead of waiting for a page reload.
  const [allTags, setAllTags] = useState<TradeTag[]>(initialAllTags)
  const addTag = (tag: TradeTag) =>
    setAllTags(prev => (prev.some(t => t.id === tag.id) ? prev : [...prev, tag]))
  // Time-aware seam (Pt 13 step 3). `endedAt` = the manual end-session stamp.
  // The recap is still "live" only when it's today, before the RTH close, and
  // the trader hasn't ended by choice — then judgment is premature and we point
  // them back to Intraday instead. (Flags are false until mount → no flash/SSR
  // mismatch.)
  const { isToday, beforeClose } = useSessionClock(date)
  const endedAt = day?.session_ended_at ?? null
  const sessionStillLive = isToday && beforeClose && !endedAt
  // Explicit PT (not date-fns local) so the SSR render (Vercel is UTC) matches
  // the client's PT render — otherwise the "ended by choice" time hydrates wrong.
  const endedAtLabel = endedAt
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(endedAt))
    : null
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
  // Temporary spotlight on the row we just JUMPED to (chart double-click or
  // ?trade= deep-link). Unlike hoveredTradeId (which follows the cursor), this
  // persists ~5s regardless of mouse movement so it's obvious WHICH trade the
  // chart scrolled to, then fades. A ref holds the pending clear timer.
  const [flashTradeId, setFlashTradeId] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTrade = (id: string) => {
    setFlashTradeId(id)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashTradeId(null), 5000)
  }
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current) }, [])
  const [analyzing, setAnalyzing] = useState(false)
  const [aiAnalysis, setAiAnalysis] = useState<EodAiAnalysis | null>(() => {
    const a = initialDay?.eod_ai_analysis_json
    return a && Object.keys(a).length > 0 ? (a as EodAiAnalysis) : null
  })
  // The analysis as TapeScore reads it — the stored audit and checklist with the
  // read-time corrections from the day's trades (a broken daily loss limit is a
  // Breach, the size-up rule re-read from the fills against the same average
  // risk yardstick Loss size uses, "no mistakes tagged" from the tags). The score
  // card and the rules card both show this one, so they can't disagree; the
  // stored analysis itself is never rewritten.
  const scoredAnalysis = useMemo(
    () => effectiveAnalysis(aiAnalysis, trades, riskYardstick),
    [aiAnalysis, trades, riskYardstick],
  )
  // "Pressing into drawdown" read the way the Score's size-up rule reads it
  // (dollar risk against the trader's usual spread), so the two never disagree.
  const pressingIds = useMemo(() => sizeUpTradeIds(trades, riskYardstick), [trades, riskYardstick])
  // Trade management's Net $ / R / Risk per trade for the day (src/lib/trade-r.ts).
  const dayPerTrade = useMemo(() => perTrade(trades), [trades])
  const imageContainerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  // On-chart highlight chips (P&L + score) for trades flagged `highlighted`.
  const highlights = useMemo(() => buildHighlights(trades, aiAnalysis), [trades, aiAnalysis])
  /** Toggle a trade's chip. Optimistic so the chart responds to the right-click
   *  immediately; reverted if the write fails, because a callout that looks
   *  saved and isn't would be discovered by the person you shared it with. */
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

  // Highlights hides the MFE/MAE-capture metrics in the header (kept for
  // Detailed Tape); plain stats — Trades, Win Rate, W/L, PnL — always show.
  const { mode, setMode } = useUiMode()
  // Highlights reorders the Recap around three questions — how did I do, what
  // do I change tomorrow, what happened (docs/tapescore-recap-highlights-mockup-r1.html).
  const simpleView = mode === 'beginner'
  // Deep-link: /eod/<date>?trade=<id> (e.g. double-clicking a chart arrow from
  // another page) scrolls to + highlights that trade's row once it's rendered.
  const searchParams = useSearchParams()
  const deepLinkTradeId = searchParams.get('trade')
  useEffect(() => {
    if (!deepLinkTradeId) return
    const el = document.getElementById(`eod-trade-${deepLinkTradeId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deep-link highlight: mark the linked trade so its row + chart arrow stand out on arrival
    setHoveredTradeId(deepLinkTradeId)
    flashTrade(deepLinkTradeId)
  }, [deepLinkTradeId, trades])
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
  const summaryRulesSig = useMemo(() => entryRulesSig(entryRules), [entryRules])
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [summariesLoading, setSummariesLoading] = useState(false)

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
  // ES/NQ instrument switcher for the chart (shared with intraday + prep).
  const { activeSymbol, symbolOptions, onSymbolChange, chartTrades } = useChartInstruments(chartSymbol, trades, date)

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
      const h = hashTrade(t, summaryRulesSig)
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
            try { localStorage.setItem(summaryCacheKey(t.id), JSON.stringify({ h: hashTrade(t, summaryRulesSig), s: got[t.id] })) } catch { /* ignore */ }
          }
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setSummariesLoading(false) })
    return () => { cancelled = true }
  }, [trades, summaryRulesSig])

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
          sessionEndedAt: day?.session_ended_at ?? null,
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
    // A Sierra log routinely covers more than the day you picked — the export is
    // "recent activity", not "this session". Each date now lands on its own
    // trading_day, but say so: silently filing trades under days the trader
    // didn't choose is how 20% of the journal ended up mis-dated unnoticed.
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

  // Mint (or reuse) a read-only coach-review link for this day and copy it.
  const [sharing, setSharing] = useState(false)
  // Ref onto the live chart so Share can grab a PNG of it for the link preview.
  const liveChartRef = useRef<LiveChartHandle | null>(null)
  const shareForReview = async () => {
    if (!day?.id) return
    setSharing(true)
    try {
      // Capture the chart FIRST so the preview exists by the time the link is
      // pasted — scrapers fetch within seconds. Best-effort: a failed capture
      // must never stop the link being minted, it only costs the thumbnail.
      // takeScreenshotPng grabs the chart canvas, which carries the arrows and
      // the drawn zone/text annotations (both are chart primitives, not DOM).
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
  const winRate = trades.length > 0 ? (winCount / trades.length) * 100 : 0

  // Trade management for the day: every trade sorted into "went your way" /
  // "never got going", with its MFE, MAE and result. One shared definition
  // (src/lib/trade-management.ts) — the dashboard card pools the same sums — and
  // the same live ATR + "was up" multiple the round-trip panel below uses, so the
  // two can't sort a trade differently.
  const mgmt = useMemo(
    () => mgmtTotals(trades, { atrByTradeId: liveAtrByTradeId, thresholdAtr: giveBackAtr }),
    [trades, liveAtrByTradeId, giveBackAtr],
  )
  // Today's own heat split — how many trades stayed inside halfway to the stop,
  // how many pushed past, how many ran to it. This LEADS the read; the lifetime
  // baseline is context beneath it.
  const todayHeat = useMemo(() => summarizeTodayHeat(trades), [trades])
  // Round-trip / "gave it back" rollup for the day — trades that were up ≥1×ATR
  // then closed ≤ BE. Same shared excursion layer + live ATR the coach uses, so
  // the panel line and the coach's read can't drift. Hidden by the panel when 0.
  const roundTripStats = useMemo(() => aggregateRoundTrips(trades, liveAtrByTradeId, giveBackAtr), [trades, liveAtrByTradeId, giveBackAtr])

  // Achievement badges earned this day — pure derivation (src/lib/achievements.ts).
  const achievements = useMemo(() => {
    const dayPnl = day?.eod_pnl ?? (trades.length > 0 ? trades.reduce((s, t) => s + (t.pnl ?? 0), 0) : null)
    // Game Winner measures the best trade's capture against the day's high-low
    // range (market_context.day_range, in points).
    const dayRangePts = initialMarketContext?.day_range ?? null
    return dayAchievements({ date, dayPnl, trades, pnlHistory, dayRangePts })
  }, [date, day?.eod_pnl, trades, pnlHistory, initialMarketContext?.day_range])

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
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Header — single row. Left (title + date) is shrink-0 so it never gets
          compressed; the gap-4 guarantees clear space before the action buttons
          (no more date sitting under the Watch-folder button). */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4">
        <div data-tour="eod-header" className="shrink-0">
          {/* Achievement badges sit ON the title line rather than below it.
              Stacked under "Ended by choice" they read as another status line;
              beside the heading they read as what they are — a mark on the day.
              flex-wrap so a day with several badges drops them to their own row
              instead of squeezing the heading. */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-xl font-bold text-white">{simpleView ? 'Recap' : 'EOD Recap'}</h1>
            <AchievementBadges items={achievements} />
          </div>
          {/* Ended by choice (Pt 13 step 3) — a positive discipline note when the
              trader called the session early rather than trading to the close. */}
          {endedAtLabel && (
            <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-emerald-300">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Ended by choice at {endedAtLabel}
            </p>
          )}
          {/* Date + action buttons share one row, aligned under the title. */}
          <div className="flex items-center gap-2 mt-1">
            <input
              type="date"
              value={date}
              onChange={e => {
                const next = e.target.value
                if (next && next !== date) router.push(`/review/today/${next}`)
              }}
              className="bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-md px-2 py-1 font-mono focus:outline-none focus:border-blue-500"
              title="Switch to a different day's recap"
            />
            {/* Local-only ingestion cluster (SC folder watcher, .scid bar
                watcher, Sierra-log import) — hidden in the cloud build; cloud
                testers import via the CSV uploader (sidebar → Import). */}
            {LOCAL_FEATURES_ENABLED && (
              <>
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
              </>
            )}
            {/* Cloud build: the local Sierra-log button is hidden, so give a
                direct jump to the Import page (CSV / Sierra .txt / template).
                While the session is still live the banner below owns both ways
                of getting trades in, at equal weight — a small grey chip up here
                competing with a big button down there made importing look like
                an afterthought and made the button beside it look like the
                import. */}
            {!LOCAL_FEATURES_ENABLED && !sessionStillLive && (
              // Promoted to a filled button when the day has NO trades: that is
              // the one thing worth doing here, and as a grey chip among other
              // grey chips it read as just another secondary action. Reverts to
              // muted once trades exist, so it stops competing with the recap.
              <Link
                href="/import"
                className={`inline-flex items-center gap-1.5 text-xs rounded-md px-2.5 py-1 transition-colors ${
                  trades.length === 0
                    ? 'bg-blue-600 hover:bg-blue-500 text-white font-medium border border-blue-500'
                    : 'bg-gray-800 border border-gray-700 text-gray-200 hover:bg-gray-700'
                }`}
                title="Bring in a whole session from a file (CSV or Sierra Chart .txt)"
              >
                {/* Same words as the live banner's button — one action, one
                    name, wherever it appears. */}
                <Upload className="w-3.5 h-3.5" /> Import trade log
              </Link>
            )}
            {/* Coach-review share: read-only public link to this day's chart. */}
            {!LOCAL_FEATURES_ENABLED && day?.id && (
              <button
                type="button"
                onClick={shareForReview}
                disabled={sharing}
                className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-md px-2.5 py-1 hover:bg-gray-700 transition-colors disabled:opacity-60"
                title="Copy a read-only link to share this day's chart with a coach"
              >
                <Share2 className="w-3.5 h-3.5" /> {sharing ? 'Sharing…' : 'Share'}
              </button>
            )}
          </div>
        </div>
        {/* The P&L / Trades / Win Rate strip that sat here moved into the one
            Recap card below (TapeScoreHeader) — it was the same three numbers
            the card and its boxes already printed. */}
      </div>

      {/* Time-aware seam (Pt 13 step 3): before the close a "session still
          live" note points back to Intraday. The score itself shows whenever
          the day has been analysed, live or not (founder, 2026-10-23). */}
      {sessionStillLive && (
        <div className="rounded-xl border border-amber-800/50 bg-amber-950/20 px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-amber-300 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /> LIVE
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white">Session still live.</p>
            <p className="text-[13px] text-gray-400 mt-0.5">
              Keep logging on Trade; end early with &ldquo;I&rsquo;m done&rdquo; when you&rsquo;re finished.
            </p>
          </div>
          {/* The two ways trades get in, side by side and equally weighted:
              bring in a file, or add them one at a time. The primary used to
              read "Log trades", which sat next to nothing and was mistaken for
              the importer — "Add trades" is the plain opposite of "Import". */}
          <div className="shrink-0 self-start sm:self-center flex items-center gap-2">
            {!LOCAL_FEATURES_ENABLED && (
              <Link
                href="/import"
                className="inline-flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium rounded-lg px-3.5 py-2 transition-colors"
                title="Bring in a whole session from a file (CSV or Sierra Chart .txt)"
              >
                <Upload className="w-4 h-4" /> Import trade log
              </Link>
            )}
            <Link
              href={`/intraday/${date}`}
              className="inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-[#1b1408] text-sm font-semibold rounded-lg px-3.5 py-2 transition-colors"
            >
              Add trades →
            </Link>
          </div>
        </div>
      )}

      {/* The one Recap card: the day's TapeScore (ring, verdict, Risk / Entry /
          Exit), the day's numbers in one line (P&L · trades · win rate) and —
          in Detailed Tape — the Trade management read on its right half.
          While the session is live the score stays hidden and the card carries
          just the numbers and Trade management. */}
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
        live={sessionStillLive}
        partsInline={simpleView}
        aside={mode === 'pro' && trades.length > 0
          ? <TradeManagementCard totals={mgmt} className="min-w-0" perTrade={{ day: dayPerTrade, usual: usualPerTrade }} />
          : undefined}
      />

      {/* The behavioral flags stay promoted above the fold (alpha-readiness
          item 23) — self-suppressing, so an empty day shows nothing. The heat
          read that used to sit beside it moved down to the trade table, where
          the MAE column it interprets actually lives. */}
      {simpleView ? (
        <>
          {/* Second on the page: the coach's Tomorrow lines, or — before the
              day is graded — the Grade button. The tour's "grade" step points here. */}
          <div data-tour="eod-analyze">
            <RecapTomorrow
              analysis={scoredAnalysis}
              loading={analyzing}
              onAnalyze={runAnalysis}
              disabled={trades.length === 0 && !day?.eod_notes}
              hasTrades={trades.length > 0}
            />
          </div>
          <RecapWhatHappened trades={trades} sessionEndedAt={endedAt} roundTrip={roundTripStats} pressingIds={pressingIds} today={todayHeat} />
        </>
      ) : (
        <BehavioralProxiesPanel trades={trades} sessionEndedAt={endedAt} roundTrip={roundTripStats} pressingIds={pressingIds} />
      )}

      {/* Chart area — toggle between legacy screenshot+calibration and the
          new live-bars rendering. Screenshot path will be removed in Phase 5
          of the chart migration once Live has proven itself across the
          intraday + dashboard surfaces too.
          Shown on mobile too — LiveChart now self-measures its width and uses
          a shorter mobile height, so the chart + toggle are usable on a phone. */}
      <div className="space-y-6">
      {/* Highlights keeps the live chart only; Screenshot + calibration are Detailed. */}
      {!simpleView && <div className="flex justify-end -mb-2">
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
      </div>}

      {chartView === 'live' || simpleView ? (
        <LiveChart
          ref={liveChartRef}
          date={date}
          symbol={activeSymbol}
          symbolOptions={symbolOptions}
          onSymbolChange={onSymbolChange}
          trades={chartTrades}
          refreshKey={barsVersion}
          hoverTradeId={hoveredTradeId}
          // Double-click an arrow → scroll to + spotlight that trade's row in
          // the log below (the chart and list are on the same page here).
          onTradeActivate={id => {
            setHoveredTradeId(id)
            flashTrade(id)
            document.getElementById(`eod-trade-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
          onHighlightTrade={toggleHighlight}
          highlights={highlights}
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
      {chartView === 'screenshot' && !simpleView && day?.last_sc_import_at && (
        <p className="text-xs text-gray-500 -mt-3 ml-1">
          Last import: {format(new Date(day.last_sc_import_at), 'MMM d, HH:mm')}
        </p>
      )}
      </div>

      {selectedIds.size > 0 && (
        <div className="bg-blue-950/60 border border-blue-800 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-y-2 text-sm">
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

      {/* The line that makes the table's MAE column mean something: the
          trader's own inside-half vs past-half split. Sits directly above the
          table it interprets — the number itself is already in the MAE cell. */}
      {/* Highlights says today's half of this in "What happened"; the lifetime split is Detailed. */}
      {!simpleView && <HeatBaseline baseline={heatBaseline} today={todayHeat} />}

      <TradeList
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
        onContextMenu={(tradeId, e) => setTradeMenu({ tradeId, x: e.clientX, y: e.clientY })}
        editingId={editingTradeId}
        summaries={summaries}
        summariesLoading={summariesLoading}
        liveAtrByTradeId={liveAtrByTradeId}
        giveBackAtr={giveBackAtr}
        postExitByTradeId={postExitByTradeId}
        bars={bars}
        entryRules={entryRules}
        runnerRules={runnerRules}
        includeFlow={includeFlowScore}
        atrStopTarget={atrStopTarget}
        pressingIds={pressingIds}
        giveBackIds={roundTripStats?.ids ?? null}
      />

      {/* Right-click menu on a trade row → open the full log, or highlight the
          trade's own P&L + execution score. */}
      <TradeContextMenu
        state={tradeMenu}
        onClose={() => setTradeMenu(null)}
        onOpenIntraday={id => router.push(`/intraday/${date}#trade-${id}`)}
        onHighlight={toggleHighlight}
        isHighlighted={(id: string) => !!highlights[id]}
      />

      {/* Edit-in-place drawer (Pt 13 step 2). Opens on a recap row's edit
          action; saves via the shared compact TradeForm and replaces the row in
          place so R / capture / setup re-derive without a page bounce. The
          deep-link to the full intraday log lives inside as "Open full log". */}
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
            onOpenFullLog={id => router.push(`/intraday/${date}?trade=${id}`)}
            onTagCreated={addTag}
          />
        )
      })()}

      {/* OBS frame commentary reads local recordings via ffmpeg — local only. */}
      {LOCAL_FEATURES_ENABLED && !simpleView && (
        <RecordingCommentary trades={trades} onTradesChanged={refreshTrades} />
      )}

      {/* Cloud build: no ffmpeg/filesystem, so recap runs in the browser —
          the user's recording is decoded client-side and never uploaded. */}
      {!LOCAL_FEATURES_ENABLED && !simpleView && (
        <BrowserRecap trades={trades} date={date} onTradesChanged={refreshTrades} />
      )}

      {/* EOD Notes */}
      <EodNotesForm
        date={date}
        initialNotes={day?.eod_notes ?? ''}
        initialPnl={day?.eod_pnl ?? null}
        computedPnl={computedPnl}
        onSaved={(notes, pnl, auto) => {
          setDay(prev => prev ? { ...prev, eod_notes: notes, eod_pnl: pnl } : prev)
          if (!auto) showToast('EOD recap saved', 'success')
        }}
        onError={msg => showToast(msg, 'error')}
        simple={simpleView}
      />

      {/* AI session analysis. latestTradeUpdate flags the analysis as stale
          when any trade has been modified after the analysis was generated —
          common when the user backfills tags, stops, or detected levels post-
          analysis. */}
      <div data-tour={simpleView ? undefined : 'eod-analyze'}>
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

      {/* Bigger achievement treatment (gamification Phase 2): the small pills
          stay pinned by the recap title; this is the large earned-today coins
          + the lifetime collection strip, at the foot of the recap. */}
      <AchievementShowcase earned={achievements} counts={achievementCounts} className="mt-2" />

      {/* Graduation seam — the same one the Highlights dashboard ends with. */}
      {simpleView && (
        <button
          type="button"
          onClick={() => setMode('pro')}
          className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 border border-gray-800 hover:border-gray-600 rounded-xl py-2.5 transition-colors"
        >
          See the full breakdown in Detailed Tape <ChevronRight className="w-4 h-4" />
        </button>
      )}

      {/* Danger Zone delete moved exclusively to the dashboard's per-row
          trash button + bulk-delete — duplicate entry point on the EOD page
          was easy to mis-click and added clutter. */}

      {/* Cursor-following hover popup removed — the live chart already pops
          up the same trade details (+ screenshot, + tags) on the chart
          itself via hoverTradeId, so this duplicated the info next to the
          cursor while the trade log row was hovered. One popup, one spot. */}
    </div>
  )
}
