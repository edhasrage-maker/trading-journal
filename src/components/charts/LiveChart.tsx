'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, Database, Settings2, X, Activity, Square, Trash2, Pencil, Type as TypeIcon } from 'lucide-react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type Time,
  type AutoscaleInfo,
} from 'lightweight-charts'
import { TradeArrowsPrimitive, type TradeArrow } from './TradeArrowsPrimitive'
import { AnnotationsPrimitive, type ChartAnnotation } from './AnnotationsPrimitive'
import type { Trade } from '@/lib/supabase/types'
import type { SessionLevels, LevelSeriesPoint } from '@/lib/session-levels'
import { migrateChartPrefs, schedulePushChartPref, pullChartPref } from '@/lib/chart-prefs'

interface Props {
  date: string
  symbol: string | null
  trades: Trade[]
  height?: number
  /** Bumped externally (e.g. by the bar watcher) to force a bars/levels re-fetch. */
  refreshKey?: number
  /** Trade currently hovered in the EOD list — highlight it on the chart + show its popup. */
  hoverTradeId?: string | null
  /** Double-click on a trade arrow. When provided (e.g. the EOD page, where the
   *  trade list is on-screen), the parent scrolls to that trade's row. When
   *  omitted, LiveChart falls back to navigating to /eod/<date>?trade=<id>. */
  onTradeActivate?: (tradeId: string) => void
  /** Fires whenever the computed session levels load/refresh — the prep page
   *  uses this to auto-fill the Market Context form (PDH/PDL/IBH/IBL/ONH/ONL)
   *  from the same values the chart draws, for fields the user hasn't edited. */
  onLevels?: (levels: SessionLevels | null) => void
}

interface ApiBar {
  ts: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

interface ChartPrefs {
  background: string
  upColor: string
  downColor: string
  showGrid: boolean
  vwapColor: string
  ema9Color: string
  ema20Color: string
  levelColor: string
  fontFamily: string
  fontSize: number
  timeZone: string
  emaTimeframeMins: number
  showLevels: boolean
  hiddenLevels: string[]
}
const DEFAULT_PREFS: ChartPrefs = {
  background: '#030712',
  upColor: '#22c55e',
  downColor: '#ef4444',
  showGrid: false, // grid off by default (task 1)
  vwapColor: '#3b82f6',
  ema9Color: '#eab308',
  ema20Color: '#a855f7',
  levelColor: '#9ca3af',
  fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`,
  fontSize: 12,
  timeZone: 'America/Los_Angeles', // axis/crosshair display only; level windows stay PT
  emaTimeframeMins: 5,
  showLevels: true,
  hiddenLevels: [],
}
const PREFS_KEY = 'livechart-prefs-v2'
// Per-(symbol, date) active-TF persistence. Each calendar day remembers its own
// chosen timeframe — opening 06/04 lands on 5m if that's what you saved there,
// and 06/05 lands on 1m independently. Aligns with the saved-zoom keying.
const TF_VALID = new Set<number>([1, 5, 15, 30, 60, 240])

// Annotation palette — swatches offered in the drawing right-click menu.
const ANN_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#e5e7eb']
function tfKey(symbol: string | null, date: string): string {
  return `livechart-tf-${symbol ?? 'unknown'}-${date}`
}

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Sans', value: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` },
  { label: 'Monospace', value: `'Courier New', ui-monospace, monospace` },
  { label: 'Serif', value: `Georgia, 'Times New Roman', serif` },
  { label: 'System', value: `system-ui, sans-serif` },
]

// Display-timezone choices for the time axis + crosshair. The browser's own
// zone is prepended as "Local" when it isn't already one of the presets.
const TZ_OPTIONS: { label: string; value: string }[] = (() => {
  const base = [
    { label: 'Pacific (PT)', value: 'America/Los_Angeles' },
    { label: 'Mountain (MT)', value: 'America/Denver' },
    { label: 'Central (CT)', value: 'America/Chicago' },
    { label: 'Eastern (ET)', value: 'America/New_York' },
    { label: 'UTC', value: 'UTC' },
  ]
  let local = 'UTC'
  try { local = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { /* ignore */ }
  if (!base.some(o => o.value === local)) base.unshift({ label: `Local (${local})`, value: local })
  return base
})()

// lightweight-charts has no native timezone support, so we render the axis +
// crosshair labels via Intl formatters bound to the chosen zone. The bar
// timestamps themselves stay UTC unix seconds — only the labels are localized.
function makeTimeFormatters(timeZone: string) {
  const hm = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  const md = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' })
  const full = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return {
    tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
      const ms = (time as number) * 1000
      return tickMarkType === TickMarkType.Time || tickMarkType === TickMarkType.TimeWithSeconds
        ? hm.format(ms)
        : md.format(ms)
    },
    timeFormatter: (time: Time) => full.format((time as number) * 1000),
  }
}

const MS_PER_MINUTE = 60_000

function displayBucketStartMs(ms: number, tfMins: number) {
  const bucketMs = Math.max(1, tfMins) * MS_PER_MINUTE
  return Math.floor(ms / bucketMs) * bucketMs
}

function displayTimeFromMs(ms: number, tfMins: number): Time {
  return (displayBucketStartMs(ms, tfMins) / 1000) as Time
}

interface HoverInfo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trade: any
  x: number
  y: number
}

// Per-symbol+date saved zoom/pan. Stored as a LOGICAL (bar-index) range —
// setVisibleLogicalRange restores reliably right after setData, whereas the
// time-range API (setVisibleRange) is frequently overridden by the library's
// post-setData layout, so the zoom never locked. Index ranges are stable across
// reloads (same bars) and on the live day (appended bars don't shift earlier
// indices). v3 key: prior keys stored a different range type — ignore them.
// Saved-view storage keyed per (symbol, date, tf). Separating by TF lets each
// timeframe remember its own zoom independently — switching 1m → 5m → 1m
// restores the exact 1m zoom even after the 5m view scrolled. Legacy v3 keys
// (no TF) are read as 1m so existing saves don't get lost on the migration.
const viewKey = (symbol: string, date: string, tfMins: number) =>
  `livechart-view-v4-${symbol}-${date}-${tfMins}m`
const legacyViewKey = (symbol: string, date: string) => `livechart-view-v3-${symbol}-${date}`

function loadView(symbol: string, date: string, tfMins: number): { from: number; to: number } | null {
  try {
    const r = localStorage.getItem(viewKey(symbol, date, tfMins))
    if (r) return JSON.parse(r)
    // Legacy fallback: pre-multi-TF saves were always 1m, so honor them only
    // when the caller is asking about 1m.
    if (tfMins === 1) {
      const legacy = localStorage.getItem(legacyViewKey(symbol, date))
      return legacy ? JSON.parse(legacy) : null
    }
    return null
  } catch { return null }
}
function saveView(symbol: string, date: string, tfMins: number, range: { from: number; to: number }) {
  try { localStorage.setItem(viewKey(symbol, date, tfMins), JSON.stringify(range)) } catch { /* ignore */ }
}
function clearView(symbol: string, date: string, tfMins: number) {
  try {
    localStorage.removeItem(viewKey(symbol, date, tfMins))
    // Also clear the legacy v3 key for 1m so reverting to default fully resets.
    if (tfMins === 1) localStorage.removeItem(legacyViewKey(symbol, date))
  } catch { /* ignore */ }
}

// Diagnostic flag — flip to true to see the chart's range-decision log in
// the browser console. Filter by "[livechart]" to follow. Off in normal
// operation; turn on when debugging TF-switch / zoom / saved-view issues.
const LIVECHART_DEBUG = false

/** Imperative handle exposed via ref so parents (e.g. PrepClient) can grab a
 *  PNG of the live chart canvas. Used as a fallback chart-read image for AI
 *  prep when the user hasn't pasted a Sierra screenshot. Returns null when
 *  the chart isn't ready (no symbol / no bars / pre-mount). */
export interface LiveChartHandle {
  takeScreenshotPng(): Promise<{ data: string; mediaType: 'image/png' } | null>
}

/**
 * Native chart (lightweight-charts v5) shared by the EOD + Intraday pages.
 * Renders the day's 1m bars with VWAP + EMA(9) + EMA(20) overlays, plus
 * entry/exit arrows via a custom TradeArrowsPrimitive. Replaces the
 * screenshot + calibration flow for days where bars have been imported.
 *
 * Empty states:
 *   - No symbol on trades → "Import trades first" message
 *   - Bars not found for that symbol+date → "Import bars" hint with link
 *     to /settings/bars
 */
const LiveChart = forwardRef<LiveChartHandle, Props>(function LiveChart(
  { date, symbol, trades, height = 480, refreshKey = 0, hoverTradeId = null, onTradeActivate, onLevels },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // Current candle OHLC (kept in a ref) so the price-scale autoscale provider
  // can fit the axis to the VISIBLE candles instead of the far-away level lines.
  const candleDataRef = useRef<Array<{ high: number; low: number }>>([])
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null)
  // Trade entry/exit arrows — custom series primitive (real left/right
  // triangles, which the built-in marker shapes can't draw).
  const tradeArrowsRef = useRef<TradeArrowsPrimitive | null>(null)
  // Screen hit-targets for the arrows (one per drawn arrow) so double/right
  // click can map a click position back to a trade. Kept in sync with the
  // primitive's data in the render effect.
  const arrowHitsRef = useRef<Array<{ tradeId: string; time: Time; price: number }>>([])
  // User-drawn annotations (zones + text) — a second primitive on the candle
  // series, plus an opt-in draw overlay. Fully additive: when Drawing Mode is
  // off the overlay is gone and the chart pans/zooms exactly as before. When
  // on, the overlay captures the mouse: right-click opens a tool menu (draw /
  // type / recolor / delete), left-drag draws a zone once armed.
  const annotationsPrimRef = useRef<AnnotationsPrimitive | null>(null)
  const [annotations, setAnnotations] = useState<ChartAnnotation[]>([])
  const [drawingMode, setDrawingMode] = useState(false)
  const [armedTool, setArmedTool] = useState<'zone' | null>(null)
  const [drawColor, setDrawColor] = useState(ANN_COLORS[0])
  const [selectedAnnId, setSelectedAnnId] = useState<string | null>(null)
  // Right-click context menu (position in overlay px + the time/price under it +
  // the annotation it landed on, if any).
  const [annMenu, setAnnMenu] = useState<{ x: number; y: number; t: number; p: number; annId: string | null } | null>(null)
  // In-place text editor (create when editId is null, else edit that annotation).
  const [textInput, setTextInput] = useState<{ x: number; y: number; t: number; p: number; value: string; editId: string | null } | null>(null)
  const drawStartRef = useRef<{ x: number; y: number; t: number; p: number } | null>(null)
  const router = useRouter()
  // Right-click-on-arrow context menu (container-relative px + the trade it hit).
  const [arrowMenu, setArrowMenu] = useState<{ x: number; y: number; tradeId: string } | null>(null)
  useEffect(() => {
    if (!arrowMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setArrowMenu(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [arrowMenu])
  // Static session-level horizontal lines (recreated each data update).
  const priceLinesRef = useRef<IPriceLine[]>([])
  // Parallel record of the currently-drawn levels (key + price) so the
  // right-click handler can hit-test a click against the nearest line.
  const levelLinesRef = useRef<Array<{ key: string; price: number }>>([])
  // Per-trade entry→exit connector lines (2-point dashed line series each).
  const tradeLinesRef = useRef<ISeriesApi<'Line'>[]>([])

  // Imperative handle: lets parents (PrepClient) snapshot the chart as a PNG
  // for AI analysis when the user hasn't pasted a Sierra screenshot.
  // lightweight-charts' takeScreenshot() returns an HTMLCanvasElement; we
  // convert to a base64 PNG (stripped of the data: prefix) since that's what
  // /api/analyze-prep accepts. Returns null when the chart isn't ready (no
  // candles drawn yet) so the caller can fall back to text-only analysis.
  useImperativeHandle(ref, () => ({
    async takeScreenshotPng() {
      const chart = chartRef.current
      const candleSeries = candleRef.current
      if (!chart || !candleSeries || candleDataRef.current.length === 0) return null
      try {
        const canvas = chart.takeScreenshot()
        const dataUrl = canvas.toDataURL('image/png')
        const base64 = dataUrl.split(',')[1] ?? null
        if (!base64) return null
        return { data: base64, mediaType: 'image/png' }
      } catch (e) {
        console.warn('[livechart] takeScreenshotPng failed:', e)
        return null
      }
    },
  }), [])

  const [bars, setBars] = useState<ApiBar[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Display timeframe in minutes. Stored 1-min bars get aggregated client-side
  // when this is > 1. Persisted PER (symbol, date) so each day remembers its
  // own TF — 5m on 06/04 stays 5m, 1m on 06/05 stays 1m. Saved logical-range
  // zoom keys remain (symbol, date, tf) so a 5m saved view restores correctly
  // when the per-day TF persistence opens you on 5m.
  const [chartTfMins, setChartTfMins] = useState<number>(() => {
    if (typeof window === 'undefined' || !symbol) return 1
    try {
      const raw = localStorage.getItem(tfKey(symbol, date))
      if (raw) {
        const n = parseInt(raw, 10)
        if (TF_VALID.has(n)) return n
      }
    } catch { /* ignore */ }
    return 1
  })
  // Day-switch handling: when (symbol, date) changes WITHOUT remount (e.g.
  // App-Router soft nav between dates), reload the saved TF for the new day
  // INSTEAD of writing the old day's TF into the new day's slot.
  // tfInitKeyRef tracks the last key we initialized; mismatch = day switched.
  const tfInitKeyRef = useRef<string>(symbol ? tfKey(symbol, date) : '')
  useEffect(() => {
    if (typeof window === 'undefined' || !symbol) return
    const key = tfKey(symbol, date)
    if (tfInitKeyRef.current !== key) {
      tfInitKeyRef.current = key
      try {
        const raw = localStorage.getItem(key)
        const n = raw ? parseInt(raw, 10) : NaN
        const saved = TF_VALID.has(n) ? n : 1
        if (saved !== chartTfMins) setChartTfMins(saved)
      } catch { /* ignore */ }
    } else {
      // Same day, TF changed by user → persist.
      try { localStorage.setItem(key, String(chartTfMins)) } catch { /* ignore */ }
    }
  }, [chartTfMins, symbol, date])

  // Chart appearance prefs — persisted to localStorage, applied live.
  const [prefs, setPrefs] = useState<ChartPrefs>(DEFAULT_PREFS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prefsHydrated, setPrefsHydrated] = useState(false)
  // Load once on mount, then flag hydrated so the persist effect may run.
  // Now also runs the Supabase one-shot migration (gated by the
  // `chart-prefs-migrated-v1` flag): on the OTHER PC it overwrites local
  // prefs with whatever the server has; on THIS PC (first run, empty server)
  // it pushes local up as the baseline. After migration, if localStorage was
  // changed by the hydrate path, we re-read it so the chart picks up the
  // synced values immediately.
  useEffect(() => {
    // Synchronous hot path: read whatever's in localStorage RIGHT NOW.
    try {
      const raw = localStorage.getItem(PREFS_KEY)
      if (raw) setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(raw) })
    } catch { /* ignore */ }
    setPrefsHydrated(true)

    // Async: trigger the cross-PC migration. If it hydrated localStorage from
    // the server, re-read so the chart reflects the synced values on this
    // render cycle (otherwise the user would see stale local prefs flash
    // before the next reload picked them up).
    migrateChartPrefs().then(result => {
      if (result.action === 'hydrated') {
        try {
          const raw = localStorage.getItem(PREFS_KEY)
          if (raw) setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(raw) })
        } catch { /* ignore */ }
      }
    })
  }, [])
  // Persist on change — but ONLY after hydration. The guard MUST be state, not
  // a ref: the load effect and this effect run in the same initial commit, so a
  // ref flipped to true inside the load effect would let this effect fire on
  // that same commit while `prefs` is still DEFAULT_PREFS — clobbering the saved
  // value with defaults (and under StrictMode the next pass re-reads that
  // clobbered value, losing the prefs for good). The state guard is false for
  // that first commit and only becomes true on the re-render that also carries
  // the loaded prefs.
  useEffect(() => {
    if (!prefsHydrated) return
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
    // Cross-PC sync: debounced upsert to Supabase. localStorage is still the
    // synchronous source of truth; the server write is fire-and-forget.
    schedulePushChartPref(PREFS_KEY, prefs)
  }, [prefs, prefsHydrated])
  const updatePref = (patch: Partial<ChartPrefs>) => setPrefs(prev => ({ ...prev, ...patch }))

  // Hover-to-show-trade (task 3). tradesRef keeps the crosshair handler (set up
  // once) reading the latest trades without re-subscribing.
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const tradesRef = useRef<Trade[]>(trades)
  useEffect(() => { tradesRef.current = trades }, [trades])
  // While a trade row is hovered we drive the crosshair programmatically; this
  // suppresses the mouse crosshair handler so it doesn't clear our popup.
  const suppressCrosshairRef = useRef(false)

  // Tracks the symbol|date we've already restored the saved view for, so the
  // restore runs once per day-open instead of on every data/prefs change.
  const restoredKeyRef = useRef<string | null>(null)
  // Tracks the TF that's currently displayed so we can fit-content on the
  // FIRST data render after a TF change. The saved logical range is in bar-
  // index units, not time units — at 1m a range of [0, 200] is 200 minutes;
  // at 5m the same indices span 1000 minutes worth of time slots, and the
  // candles end up spread thin across the visible width. Fitting on TF
  // change snaps the view back to the actual data extent.
  const lastRenderedTfRef = useRef<number | null>(null)

  // Pull-on-mount: the one-shot chart-prefs migration only runs once per PC,
  // so a view saved on the OTHER PC after this PC migrated would never appear
  // here. This effect closes that gap — fetches the server's value for this
  // exact (symbol, date) view key, and if it differs from local, hydrates
  // localStorage + applies it. 30s cache in pullChartPref prevents repeated
  // fetches when chartView toggles or the component re-mounts.
  useEffect(() => {
    if (!symbol) return
    let cancelled = false
    // Cross-PC sync is per-(symbol, date) on the server (no TF dimension yet).
    // Treat the server value as a 1m view, since that's the implicit TF the
    // legacy save key was recorded under.
    void pullChartPref(viewKey(symbol, date, 1)).then(serverValue => {
      if (cancelled) return
      if (!serverValue || typeof serverValue !== 'object') return
      const range = serverValue as { from: number; to: number }
      if (typeof range.from !== 'number' || typeof range.to !== 'number') return
      const local = loadView(symbol, date, 1)
      if (local && local.from === range.from && local.to === range.to) return
      // Server differs from local — hydrate localStorage so loadView picks it
      // up on subsequent restores, then apply directly if the chart is
      // already past its first-restore for this day.
      saveView(symbol, date, 1, range)
      if (LIVECHART_DEBUG) console.log('[livechart] pullChartPref hydrated 1m view', range)
      const sameDay = restoredKeyRef.current === `${symbol}|${date}`
      const tscale = chartRef.current?.timeScale()
      // Only apply the server-saved range if the user is still on the default
      // 1m timeframe. Saved views are stored without TF info, so a 1m-saved
      // range applied on a 5m/30m/etc. view would clobber whatever the
      // TF-change setter just put down. The 1m gate keeps the saved view
      // behavior intact for the default case where it was saved from.
      if (sameDay && tscale && lastRenderedTfRef.current === 1) {
        tscale.setVisibleLogicalRange(range)
        requestAnimationFrame(() => {
          if (lastRenderedTfRef.current !== 1) return
          chartRef.current?.timeScale().setVisibleLogicalRange(range)
        })
      }
    })
    return () => { cancelled = true }
  }, [symbol, date])


  const [viewSavedFlash, setViewSavedFlash] = useState(false)

  // Explicit "Save chart view" — locks in the current zoom for this day plus
  // the appearance prefs, with a confirmation flash. (Colors/font already
  // auto-persist; this also captures the per-day zoom and reassures the user
  // everything is locked.)
  const saveChartView = () => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* ignore */ }
    // Cross-PC: push the appearance prefs immediately too (the change-tracking
    // effect already debounces these, but this button is explicit "lock in".)
    schedulePushChartPref(PREFS_KEY, prefs)
    // Capture the visible logical (bar-index) range — current zoom + position.
    // Saved per-TF so each timeframe remembers its own zoom independently.
    const r = chartRef.current?.timeScale().getVisibleLogicalRange()
    if (r && symbol) {
      const range = { from: r.from, to: r.to }
      saveView(symbol, date, chartTfMins, range)
      // Push to Supabase only when saving the default 1m TF — cross-PC sync
      // is per-(symbol, date) without TF dimension on the server. Higher TFs
      // stay local-only until we add a TF column to chart_prefs.
      if (chartTfMins === 1) {
        schedulePushChartPref(viewKey(symbol, date, 1), range)
      }
      if (LIVECHART_DEBUG) console.log('[livechart] saveChartView', { tf: chartTfMins, range })
    }
    setViewSavedFlash(true)
    setTimeout(() => setViewSavedFlash(false), 1500)
  }

  // Right-click a level line to hide it. Hit-tests the click Y against each
  // drawn level's screen coordinate (priceToCoordinate); if one is within ~8px
  // we suppress the browser menu and add its key to hiddenLevels. Re-show via
  // the settings popover's "Hidden levels" chips or "Show all".
  // Map a container-relative click (px, py) to the nearest trade arrow within
  // ~16px. Returns the trade id, or null if the click didn't land on an arrow.
  const arrowAt = (px: number, py: number): string | null => {
    const candle = candleRef.current
    const ts = chartRef.current?.timeScale()
    if (!candle || !ts) return null
    let bestId: string | null = null
    let bestDist = Infinity
    for (const h of arrowHitsRef.current) {
      const ax = ts.timeToCoordinate(h.time)
      const ay = candle.priceToCoordinate(h.price)
      if (ax == null || ay == null) continue
      const d = Math.hypot(ax - px, ay - py)
      if (d < bestDist) { bestDist = d; bestId = h.tradeId }
    }
    return bestDist <= 16 ? bestId : null
  }

  // Double-click an arrow → jump to that trade. On the EOD page the parent
  // scrolls to the trade row (onTradeActivate); elsewhere we navigate to it.
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const id = arrowAt(e.clientX - rect.left, e.clientY - rect.top)
    if (!id) return
    setArrowMenu(null)
    if (onTradeActivate) onTradeActivate(id)
    else router.push(`/eod/${date}?trade=${id}`)
  }

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    // Right-click on a trade arrow opens the trade menu — takes priority over
    // the level-hide behavior below.
    const tradeId = arrowAt(px, py)
    if (tradeId) {
      e.preventDefault()
      setArrowMenu({ x: px, y: py, tradeId })
      return
    }
    // Otherwise: right-click near a session level hides it.
    if (!candleRef.current || levelLinesRef.current.length === 0) return
    let bestKey: string | null = null
    let bestDelta = Infinity
    for (const lvl of levelLinesRef.current) {
      const coord = candleRef.current.priceToCoordinate(lvl.price)
      if (coord == null) continue
      const d = Math.abs(coord - py)
      if (d < bestDelta) { bestDelta = d; bestKey = lvl.key }
    }
    if (bestKey && bestDelta <= 8) {
      e.preventDefault()
      const key = bestKey
      setPrefs(prev =>
        prev.hiddenLevels.includes(key)
          ? prev
          : { ...prev, hiddenLevels: [...prev.hiddenLevels, key] },
      )
    }
  }

  // Session levels (static lines) + study-matched VWAP/EMA series, computed
  // server-side from the SCID over an 8-day lookback.
  const [levels, setLevels] = useState<{ levels: SessionLevels | null; series: LevelSeriesPoint[] } | null>(null)
  // Ref so firing the onLevels callback doesn't re-run the fetch effect when the
  // parent passes a new callback identity each render.
  const onLevelsRef = useRef(onLevels)
  useEffect(() => { onLevelsRef.current = onLevels }, [onLevels])
  useEffect(() => {
    if (!symbol) { setLevels(null); onLevelsRef.current?.(null); return }
    let cancelled = false
    fetch(`/api/bars/levels?symbol=${encodeURIComponent(symbol)}&date=${date}&emaTf=${prefs.emaTimeframeMins}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        setLevels({ levels: d.levels ?? null, series: d.series ?? [] })
        onLevelsRef.current?.(d.levels ?? null)
      })
      .catch(() => { if (!cancelled) setLevels(null) })
    return () => { cancelled = true }
  }, [symbol, date, prefs.emaTimeframeMins, refreshKey])

  // Fetch bars. `silent` skips the loading spinner — used for the background
  // bar-watcher refresh so the chart doesn't flash a loader every few minutes.
  // A request-id guard discards responses superseded by a newer fetch.
  const barsReqRef = useRef(0)
  const loadBars = useCallback(async (silent: boolean) => {
    if (!symbol) {
      setError('no-symbol')
      setLoading(false)
      setBars(null)
      return
    }
    const reqId = ++barsReqRef.current
    if (!silent) { setLoading(true); setError(null) }
    try {
      const r = await fetch(`/api/bars?symbol=${encodeURIComponent(symbol)}&date=${date}`)
      const data = await r.json()
      if (reqId !== barsReqRef.current) return // superseded by a newer request
      if (!r.ok) { setError(data.error ?? 'Failed to fetch bars'); setBars(null) }
      else { setBars(data.bars ?? []) }
    } catch (err) {
      if (reqId !== barsReqRef.current) return
      if (!silent) setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      // Whichever request is the latest clears the spinner — even a silent one.
      // Otherwise a silent background refresh that supersedes the initial load
      // leaves `loading` stuck true, freezing the chart behind its overlay.
      if (reqId === barsReqRef.current) setLoading(false)
    }
  }, [symbol, date])

  // Initial + on symbol/date change: full load with spinner.
  useEffect(() => { loadBars(false) }, [loadBars])

  // Background refresh when the bar watcher bumps refreshKey: silent re-fetch
  // via the latest loadBars (kept in a ref so this only fires on refreshKey,
  // not on every symbol/date change). Skips the first run (refreshKey starts 0).
  const loadBarsRef = useRef(loadBars)
  useEffect(() => { loadBarsRef.current = loadBars }, [loadBars])
  const firstRefreshRef = useRef(true)
  useEffect(() => {
    if (firstRefreshRef.current) { firstRefreshRef.current = false; return }
    loadBarsRef.current(true)
  }, [refreshKey])

  // Initialize chart once
  useEffect(() => {
    if (!containerRef.current) return
    if (LIVECHART_DEBUG) console.log('[livechart] CHART-CREATE', { tf: chartTfMins, height })
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: '#030712' },
        textColor: '#9ca3af',
        attributionLogo: false, // hide the TradingView watermark — we render our own data, no TV feed
      },
      grid: {
        vertLines: { visible: false, color: '#1f2937' },
        horzLines: { visible: false, color: '#1f2937' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#374151',
        // Keep the SAME bars visible when the chart width changes (window resize,
        // opening/closing DevTools, layout shifts) instead of re-spreading bar
        // spacing — so the saved zoom looks consistent regardless of width.
        lockVisibleTimeRangeOnResize: true,
      },
      rightPriceScale: {
        borderColor: '#374151',
      },
      crosshair: {
        mode: 1,
      },
    })
    chartRef.current = chart
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
      // Fit the price axis to the VISIBLE candles (+ padding), not the session-
      // level price lines. Without this the far levels (Wk Open, IBH+100%, …)
      // blow out the vertical range and squash the candles — which read as
      // "scale not zoomed in enough". Manual price-axis drag still overrides
      // this (it disables autoScale for the scale).
      autoscaleInfoProvider: (baseImpl: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const data = candleDataRef.current
        const lr = chartRef.current?.timeScale().getVisibleLogicalRange()
        if (!data.length || !lr) return baseImpl()
        const from = Math.max(0, Math.floor(lr.from))
        const to = Math.min(data.length - 1, Math.ceil(lr.to))
        let min = Infinity, max = -Infinity
        for (let i = from; i <= to; i++) {
          const b = data[i]
          if (!b) continue
          if (b.low < min) min = b.low
          if (b.high > max) max = b.high
        }
        if (!isFinite(min) || !isFinite(max)) return baseImpl()
        const pad = (max - min) * 0.12 || 1
        return { priceRange: { minValue: min - pad, maxValue: max + pad } }
      },
    })
    // Trade arrows live as a primitive on the candle series — created once here,
    // fed via setData() in the data/markers effect below.
    tradeArrowsRef.current = new TradeArrowsPrimitive()
    candleRef.current.attachPrimitive(tradeArrowsRef.current)
    annotationsPrimRef.current = new AnnotationsPrimitive()
    candleRef.current.attachPrimitive(annotationsPrimRef.current)
    // VWAP/EMA overlays must NOT drive the price axis — on a trend day the
    // session-anchored VWAP sits far from the candles and would blow out the
    // vertical scale (squashing the candles). Returning null keeps the price
    // axis fit to the candles only; these lines clip if they fall off-screen.
    //
    // crosshairMarkerVisible: false on the overlay series so the crosshair
    // tooltip dot snaps ONLY to candles, not to VWAP/EMA. Without this the
    // crosshair jumps to whichever series is closest in price at the hovered
    // x — confusing when scrubbing candles near a VWAP that's many points away.
    const overlayOpts = {
      autoscaleInfoProvider: () => null,
      crosshairMarkerVisible: false,
    }
    vwapRef.current = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      ...overlayOpts,
    })
    ema9Ref.current = chart.addSeries(LineSeries, {
      color: '#eab308',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      ...overlayOpts,
    })
    ema20Ref.current = chart.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      ...overlayOpts,
    })

    const obs = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width })
    })
    obs.observe(containerRef.current)

    // Hover-to-show-trade: when the crosshair lands within ~90s of a trade's
    // entry time, surface that trade in a popup. Reads tradesRef so we never
    // re-subscribe on trade changes.
    chart.subscribeCrosshairMove(param => {
      if (suppressCrosshairRef.current) return // row-driven hover owns the popup
      if (param.time == null || !param.point) { setHover(null); return }
      const timeSec = param.time as number
      let best: Trade | null = null
      let bestDelta = Infinity
      for (const t of tradesRef.current) {
        if (!t.entry_time) continue
        const ts = displayTimeFromMs(new Date(t.entry_time).getTime(), chartTfMins) as number
        const d = Math.abs(ts - timeSec)
        if (d < bestDelta) { bestDelta = d; best = t }
      }
      if (best && bestDelta <= Math.max(90, chartTfMins * 60)) setHover({ trade: best, x: param.point.x, y: param.point.y })
      else setHover(null)
    })

    // NOTE: no auto-save-on-pan. The saved view is written ONLY by the explicit
    // "Save chart view" button, so it's a true lock-in — panning/zooming (or new
    // bars shifting the range on the live day) can never silently overwrite it.

    return () => {
      if (LIVECHART_DEBUG) console.log('[livechart] CHART-DESTROY', { tf: chartTfMins })
      obs.disconnect()
      priceLinesRef.current = []
      levelLinesRef.current = []
      tradeLinesRef.current = []
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      vwapRef.current = null
      ema9Ref.current = null
      ema20Ref.current = null
      tradeArrowsRef.current = null
      annotationsPrimRef.current = null
    }
  }, [height, chartTfMins])

  // When TF changes, force the saved-view restore path to fire again on the
  // fresh chart instance (the chart-creation effect just above this depends
  // on chartTfMins now, so it tears down and rebuilds). Without resetting
  // this ref, the data effect would think the day was already restored on
  // the new chart and skip applying the visible range entirely.
  useEffect(() => {
    restoredKeyRef.current = null
  }, [chartTfMins])

  // Apply appearance prefs to the live chart (runs on mount after localStorage
  // load, and on every pref change). Session-level line colors are applied in
  // the data effect (price lines recreate there); this handles everything that
  // can be set via applyOptions.
  useEffect(() => {
    if (!chartRef.current || !candleRef.current) return
    const { tickMarkFormatter, timeFormatter } = makeTimeFormatters(prefs.timeZone)
    chartRef.current.applyOptions({
      layout: {
        background: { color: prefs.background },
        fontFamily: prefs.fontFamily,
        fontSize: prefs.fontSize,
      },
      grid: {
        vertLines: { visible: prefs.showGrid, color: '#1f2937' },
        horzLines: { visible: prefs.showGrid, color: '#1f2937' },
      },
      localization: { timeFormatter },
      timeScale: { tickMarkFormatter },
    })
    candleRef.current.applyOptions({
      upColor: prefs.upColor,
      downColor: prefs.downColor,
      borderUpColor: prefs.upColor,
      borderDownColor: prefs.downColor,
      wickUpColor: prefs.upColor,
      wickDownColor: prefs.downColor,
    })
    vwapRef.current?.applyOptions({ color: prefs.vwapColor })
    ema9Ref.current?.applyOptions({ color: prefs.ema9Color })
    ema20Ref.current?.applyOptions({ color: prefs.ema20Color })
    // chartTfMins is in the deps so this re-runs after a TF-change destroys
    // and recreates the chart — without it, the fresh chart stays on the
    // hardcoded init-time defaults and the trader sees their customized
    // background/candle/EMA/VWAP colors revert every TF switch.
  }, [prefs, chartTfMins])

  // Aggregate the stored 1-min bars into the selected timeframe. Bucket
  // boundary uses floor(ms / bucketMs) so the same UTC second always falls
  // into the same bucket regardless of TF — keeps the candle alignment
  // stable when switching back and forth. tfMins === 1 short-circuits to
  // the raw array (zero copy, zero work).
  // Filter out corrupt bars where all OHLC = 0. Comes from edge cases in the
  // SCID importer (maintenance-window ticks, malformed records) — even one
  // such bar at the end of the data crushes the chart's price autoscale
  // (last close = 0 → axis range expands to include 0, candles at 30000s
  // get squashed into invisibility against a -8000..30807 scale).
  const validBars = useMemo(() => {
    if (!bars) return null
    return bars.filter(b =>
      Number.isFinite(b.open) && Number.isFinite(b.high) &&
      Number.isFinite(b.low) && Number.isFinite(b.close) &&
      !(b.open === 0 && b.high === 0 && b.low === 0 && b.close === 0)
    )
  }, [bars])

  const displayBars: ApiBar[] | null = useMemo(() => {
    if (!validBars) return null
    if (chartTfMins === 1) return validBars
    const out: ApiBar[] = []
    for (const b of validBars) {
      const ms = Date.parse(b.ts)
      if (!Number.isFinite(ms)) continue
      const bucketIso = new Date(displayBucketStartMs(ms, chartTfMins)).toISOString()
      const last = out[out.length - 1]
      if (last && last.ts === bucketIso) {
        if (b.high > last.high) last.high = b.high
        if (b.low < last.low) last.low = b.low
        last.close = b.close
        last.volume = (last.volume ?? 0) + (b.volume ?? 0)
      } else {
        out.push({ ts: bucketIso, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })
      }
    }
    return out
  }, [validBars, chartTfMins])

  // Push data + markers whenever bars or trades change
  useEffect(() => {
    if (!candleRef.current || !vwapRef.current || !ema9Ref.current || !ema20Ref.current) return
    if (!displayBars || displayBars.length === 0) {
      candleRef.current.setData([])
      candleDataRef.current = []
      vwapRef.current.setData([])
      ema9Ref.current.setData([])
      ema20Ref.current.setData([])
      tradeArrowsRef.current?.setData([])
      for (const pl of priceLinesRef.current) candleRef.current.removePriceLine(pl)
      priceLinesRef.current = []
      levelLinesRef.current = []
      if (chartRef.current) for (const s of tradeLinesRef.current) chartRef.current.removeSeries(s)
      tradeLinesRef.current = []
      return
    }

    // Capture the user's current view BEFORE replacing data: setData() resets
    // the visible range, so for an already-restored day we re-apply this below
    // (background refreshes from the bar watcher, levels/trades loading, etc.
    // must not move the chart). Null on the first non-empty render (no data yet).
    const prevRange = chartRef.current?.timeScale().getVisibleLogicalRange() ?? null

    // Lightweight-charts infers a base time interval from the FIRST setData,
    // then treats later setData calls as more bars on that same grid. Switching
    // 1m → 5m without clearing means the chart sees 5m bars as "1m bars spaced
    // 5 minutes apart" — rendering each 5m candle every 5 slots with 4 empty
    // 1m slots between them (exactly what the user was seeing). Clearing the
    // candle series first forces the chart to re-detect the interval from the
    // new bars' time deltas.
    const tfWasJustChanged = lastRenderedTfRef.current !== null && lastRenderedTfRef.current !== chartTfMins
    if (tfWasJustChanged) {
      if (LIVECHART_DEBUG) console.log('[livechart] clearing series before TF-switch setData (force interval re-detection)')
      candleRef.current.setData([])
      vwapRef.current?.setData([])
      ema9Ref.current?.setData([])
      ema20Ref.current?.setData([])
    }

    const candleData = displayBars.map(b => ({
      time: (new Date(b.ts).getTime() / 1000) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
    const candleTimes = candleData.map(p => p.time as number)
    const candleTimeSet = new Set(candleTimes)
    candleRef.current.setData(candleData)
    candleDataRef.current = candleData // for the price-scale autoscale provider

    // Study-matched VWAP / EMA9 / EMA20 series from /api/bars/levels (replaces
    // the previous simple client-side calc). Falls back to empty until levels
    // load. Keep these points on the candle grid. lightweight-charts merges
    // all series timestamps into one shared scale; feeding 1m VWAP points into
    // a 5m candle chart inserts empty x-slots between the candles.
    const ser = levels?.series ?? []
    const toLine = (key: 'vwap' | 'ema9' | 'ema20') => {
      const byDisplayTime = new Map<number, number>()
      for (const p of ser) {
        const value = p[key]
        if (value == null || !Number.isFinite(value)) continue
        const ms = Date.parse(p.ts)
        if (!Number.isFinite(ms)) continue
        const time = displayBucketStartMs(ms, chartTfMins) / 1000
        if (candleTimeSet.has(time)) byDisplayTime.set(time, value)
      }
      return candleTimes.flatMap(time => {
        const value = byDisplayTime.get(time)
        return value == null ? [] : [{ time: time as Time, value }]
      })
    }
    vwapRef.current.setData(toLine('vwap'))
    ema9Ref.current.setData(toLine('ema9'))
    ema20Ref.current.setData(toLine('ema20'))

    // Static session levels as horizontal price lines (recreate each update).
    // Gated on the master `showLevels` toggle; individual levels listed in
    // `hiddenLevels` (toggled via right-click or the settings popover) are
    // skipped. Each drawn line is recorded in levelLinesRef for hit-testing.
    for (const pl of priceLinesRef.current) candleRef.current.removePriceLine(pl)
    priceLinesRef.current = []
    levelLinesRef.current = []
    const L = levels?.levels
    if (L && prefs.showLevels) {
      const grey = prefs.levelColor
      const dim = prefs.levelColor
      const hidden = new Set(prefs.hiddenLevels)
      const addLine = (price: number | null | undefined, title: string, color: string, dashed = false) => {
        if (price == null || !Number.isFinite(price)) return
        if (hidden.has(title)) return
        levelLinesRef.current.push({ key: title, price })
        priceLinesRef.current.push(candleRef.current!.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: dashed ? 2 : 0,
          axisLabelVisible: true,
          title,
        }))
      }
      addLine(L.pdh, 'PDH', grey)
      addLine(L.pdl, 'PDL', grey)
      addLine(L.pdhFull, 'PDH·F', dim, true)
      addLine(L.pdlFull, 'PDL·F', dim, true)
      addLine(L.onh, 'ONH', grey)
      addLine(L.onl, 'ONL', grey)
      addLine(L.ibh, 'IBH', grey)
      addLine(L.ibl, 'IBL', grey)
      addLine(L.rthOpen, 'RTH Open', dim, true)
      addLine(L.weeklyOpen, 'Wk Open', dim, true)
      const pcts = [25, 50, 100]
      L.ibhExt.forEach((v, i) => addLine(v, `IBH+${pcts[i]}%`, dim, true))
      L.iblExt.forEach((v, i) => addLine(v, `IBL-${pcts[i]}%`, dim, true))
    }

    // Trade arrows (custom primitive — see TradeArrowsPrimitive). Two
    // orthogonal encodings so direction and leg read independently:
    //   - COLOR = DIRECTION: green = long, red = short (a trade's entry AND
    //     exits share its color). Favorability is NOT colored here — it lives
    //     in the connector-line color + the hover popup.
    //   - ARROW = LEG: ▶ (right) = entry; ◀ (left) = exit.
    // Arrows sit ON the candle at the fill price (vertical = true price, so a
    // long stopped out lower shows its exit ◀ BELOW its entry ▶) and are BLANK
    // by default (just the haloed shape). Hovering a trade enlarges its arrows
    // and reveals labels: the entry shows DIR + size @ price, exits show
    // size @ price. Exits are GROUPED by display-TF time bucket so multiple
    // fills in the same bucket render as ONE arrow at the volume-weighted avg.
    const hoveredId = hover?.trade?.id ?? hoverTradeId ?? null
    const fmtPx = (p: number) => (Number.isInteger(p) ? String(p) : String(+p.toFixed(2)))
    const arrows: TradeArrow[] = []
    // Parallel hit-targets (same time/price as each arrow) tagged with the trade
    // id, for double/right-click mapping.
    const arrowHits: Array<{ tradeId: string; time: Time; price: number }> = []
    for (const t of trades) {
      if (!t.entry_time || !t.direction) continue
      const isLong = t.direction === 'long'
      const entryPrice = t.entry_price ?? null
      const isHovered = hoveredId != null && t.id === hoveredId
      const dirColor = isLong ? '#22c55e' : '#ef4444'         // fill: green long / red short
      const dirOutline = isLong ? '#166534' : '#991b1b'       // border: darker green / darker red
      // Entry (needs a price to place on the axis)
      if (entryPrice != null) {
        const entryTime = displayTimeFromMs(new Date(t.entry_time).getTime(), chartTfMins)
        arrows.push({
          time: entryTime,
          price: entryPrice,
          leg: 'entry',
          color: dirColor,
          outline: dirOutline,
          // Blank until hovered; then DIR + contract size @ entry price.
          label: isHovered ? `${t.direction.toUpperCase()} ${t.quantity ?? ''} @ ${fmtPx(entryPrice)}` : '',
          hovered: isHovered,
        })
        arrowHits.push({ tradeId: t.id, time: entryTime, price: entryPrice })
      }
      // Exits: prefer per-fill array, fall back to aggregated single exit
      const exitList: Array<{ time: string; price: number; qty: number }> =
        Array.isArray(t.exits_json) && t.exits_json.length > 0
          ? t.exits_json
          : t.exit_time && t.exit_price != null
            ? [{ time: t.exit_time, price: t.exit_price, qty: t.quantity ?? 0 }]
            : []
      // Group exits by display-TF time bucket — every fill in the same bucket
      // becomes ONE arrow (total qty), placed at the volume-weighted avg price.
      const exitsByBucket = new Map<number, Array<{ price: number; qty: number }>>()
      for (const e of exitList) {
        const bucketSec = displayTimeFromMs(new Date(e.time).getTime(), chartTfMins) as number
        const arr = exitsByBucket.get(bucketSec) ?? []
        arr.push({ price: e.price, qty: e.qty })
        exitsByBucket.set(bucketSec, arr)
      }
      for (const [bucketSec, fills] of exitsByBucket) {
        const totalQty = fills.reduce((s, f) => s + f.qty, 0)
        const avgPrice = totalQty > 0
          ? fills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty
          : fills[0]?.price ?? 0
        arrows.push({
          time: bucketSec as Time,
          price: avgPrice,
          leg: 'exit',
          color: dirColor, // color is direction, not P&L
          outline: dirOutline,
          // Blank until hovered; then contract size @ avg exit price.
          label: isHovered ? `${totalQty} @ ${fmtPx(avgPrice)}` : '',
          hovered: isHovered,
        })
        arrowHits.push({ tradeId: t.id, time: bucketSec as Time, price: avgPrice })
      }
    }
    // Hovered arrows drawn last so they (and their labels) sit on top of the
    // rest when trades cluster.
    arrows.sort((a, b) => Number(a.hovered) - Number(b.hovered))
    tradeArrowsRef.current?.setData(arrows)
    arrowHitsRef.current = arrowHits

    // Entry→exit connector lines: one dashed 2-point line per scale-out,
    // fanning from the entry price to EACH exit's actual price (diagonal), so
    // every TP arrow — including ones far above/below the entry — gets its own
    // connecting line. Exits are grouped by display-TF bucket (matching the
    // arrows) so each line ends exactly on an exit arrow; a bucket equal to or
    // before the entry's is skipped (the line would collapse to a point). Color
    // reflects favorability (green if the exit beat entry, red if not) — which
    // is what distinguishes it from the arrows, whose color is direction.
    //
    // HOVER HIGHLIGHT: the hovered trade's connectors render solid (not dashed),
    // thicker (3px vs 1px), and in a brighter color — so when you mouse over an
    // entry the matching exit "ribbons" pop out, making multi-fill scale-outs
    // unambiguous in a cluster.
    const chart = chartRef.current
    if (chart) {
      for (const s of tradeLinesRef.current) chart.removeSeries(s)
      tradeLinesRef.current = []
      for (const t of trades) {
        if (!t.entry_time || !t.direction || t.entry_price == null) continue
        const isLong = t.direction === 'long'
        const entryMin = displayTimeFromMs(new Date(t.entry_time).getTime(), chartTfMins)
        const exitList: Array<{ time: string; price: number; qty: number }> =
          Array.isArray(t.exits_json) && t.exits_json.length > 0
            ? t.exits_json
            : t.exit_time && t.exit_price != null
              ? [{ time: t.exit_time, price: t.exit_price, qty: t.quantity ?? 0 }]
              : []
        const isHovered = hoveredId != null && t.id === hoveredId
        // Group exits by display-TF bucket exactly like the arrows, so every
        // connector ends ON an exit arrow (the bucket's volume-weighted avg
        // price). One line per scale-out, fanning from the entry to each TP.
        const exitsByBucket = new Map<number, Array<{ price: number; qty: number }>>()
        for (const e of exitList) {
          const bucket = displayTimeFromMs(new Date(e.time).getTime(), chartTfMins) as number
          if (bucket <= (entryMin as number)) continue // same/earlier bucket -> would collapse to a point
          const arr = exitsByBucket.get(bucket) ?? []
          arr.push({ price: e.price, qty: e.qty })
          exitsByBucket.set(bucket, arr)
        }
        for (const [bucket, fills] of exitsByBucket) {
          const totalQty = fills.reduce((s, f) => s + f.qty, 0)
          const avgPrice = totalQty > 0
            ? fills.reduce((s, f) => s + f.price * f.qty, 0) / totalQty
            : fills[0]?.price ?? 0
          const favorable = isLong ? avgPrice > t.entry_price : avgPrice < t.entry_price
          const baseColor = favorable ? '#22c55e' : '#ef4444'
          // Brighter, fully-opaque highlight color when hovered; default keeps
          // the standard green/red palette.
          const lineColor = isHovered
            ? (favorable ? '#4ade80' : '#f87171')
            : baseColor
          const line = chart.addSeries(LineSeries, {
            color: lineColor,
            lineWidth: isHovered ? 3 : 1,
            lineStyle: isHovered ? 0 : 2, // 0 = solid, 2 = dashed
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null, // don't let connectors drive the price axis
          })
          // Diagonal: entry price → this exit's actual price, so each TP arrow
          // (even ones well above/below the entry) gets its own connecting line.
          line.setData([
            { time: entryMin, value: t.entry_price },
            { time: bucket as Time, value: avgPrice },
          ])
          tradeLinesRef.current.push(line)
        }
      }
    }

    // View: restore the saved zoom for this symbol+date ONCE per day-open (on
    // the first non-empty render). Re-running on every prefs/levels/background-
    // refresh change would yank the chart back to a stale range and fight the
    // user's current pan — which made the saved view feel like it never locked
    // in. Navigating to another day changes the key and restores again.
    const tscale = chartRef.current?.timeScale()
    const dayKey = `${symbol ?? ''}|${date}`
    if (tscale) {
      const tfChanged = lastRenderedTfRef.current !== null && lastRenderedTfRef.current !== chartTfMins
      lastRenderedTfRef.current = chartTfMins
      // Per-TF default visible count. Keep 5m/15m/30m compact by targeting
      // roughly the same candle density as 1m instead of deliberately widening
      // higher timeframes.
      const total = displayBars.length
      const TARGET_VISIBLE =
        chartTfMins <= 30  ? 75 :
        chartTfMins <= 60  ? 60 :
                             50
      const defaultRange = {
        from: Math.max(0, total - TARGET_VISIBLE) - 0.5,
        to: total - 0.5,
      }

      // Per-TF saved view, falling back to the compact default when none exists.
      const savedThisTf = symbol ? loadView(symbol, date, chartTfMins) : null
      const savedFits = !!(savedThisTf && savedThisTf.to <= total && savedThisTf.from >= 0)

      if (LIVECHART_DEBUG) {
        console.log('[livechart] data effect', {
          symbol, date, tf: chartTfMins, total,
          restored: restoredKeyRef.current === dayKey,
          tfChanged,
          prevRange,
          savedThisTf,
          savedFits,
          defaultRange,
        })
      }

      if (restoredKeyRef.current !== dayKey) {
        // First open of this day. Restore the per-TF saved view if available
        // and fits; otherwise default to the compact target range. Three apply attempts
        // (sync + rAF + 100ms) to beat the post-setData auto-fit pass.
        restoredKeyRef.current = dayKey
        const range = savedFits ? { from: savedThisTf!.from, to: savedThisTf!.to } : defaultRange
        if (LIVECHART_DEBUG) console.log('[livechart] FIRST-OPEN apply', range, 'usingSaved=', savedFits)
        const apply = () => chartRef.current?.timeScale().setVisibleLogicalRange(range)
        apply()
        requestAnimationFrame(apply)
        setTimeout(apply, 100)
      } else if (tfChanged) {
        // TF change. Logs proved setVisibleLogicalRange + barSpacing weren't
        // moving the actual rendering — lightweight-charts was reporting the
        // logical range we set, but drawing fewer bars based on a separate
        // time-based visible range. Switching to setVisibleRange (time-based)
        // which is what actually drives rendering. Compute the time bounds
        // of the last N bars from the data directly. Reuses the per-TF
        // TARGET_VISIBLE from the default-range block above so TF changes use
        // the same compact density as first render.
        const startIdx = Math.max(0, total - TARGET_VISIBLE)
        const fromBar = displayBars[startIdx]
        const toBar = displayBars[total - 1]
        const fromSec = fromBar ? Date.parse(fromBar.ts) / 1000 : 0
        const toSec = toBar ? Date.parse(toBar.ts) / 1000 : 0
        if (LIVECHART_DEBUG) {
          console.log('[livechart] TF-CHANGE apply (time-based)', {
            startIdx, fromTs: fromBar?.ts, toTs: toBar?.ts, fromSec, toSec,
          })
        }
        const apply = () => {
          const ts = chartRef.current?.timeScale()
          if (!ts || !fromBar || !toBar) return
          const paneW = containerRef.current?.getBoundingClientRect().width ?? 900
          const usableW = Math.max(200, paneW - 70)
          const targetSlot = usableW / TARGET_VISIBLE
          ts.applyOptions({ barSpacing: targetSlot })
          // setVisibleRange uses time values directly — drives the actual
          // visible-time window, which the chart uses for rendering.
          ts.setVisibleRange({
            from: fromSec as Time,
            to: toSec as Time,
          })
        }
        apply()
        requestAnimationFrame(apply)
        setTimeout(apply, 50)
        setTimeout(apply, 200)
        // Post-apply diagnostic: dump BOTH the logical and time ranges +
        // chart width so we can spot any disconnect between them.
        if (LIVECHART_DEBUG) {
          setTimeout(() => {
            const ts = chartRef.current?.timeScale()
            const actualLogical = ts?.getVisibleLogicalRange()
            const actualTime = ts?.getVisibleRange()
            const paneW = containerRef.current?.getBoundingClientRect().width ?? 0
            const visibleBars = actualLogical ? (actualLogical.to - actualLogical.from) : 0
            const slotPx = visibleBars > 0 ? paneW / visibleBars : 0
            console.log('[livechart] POST-APPLY snapshot', {
              requestedTimeRange: { fromSec, toSec },
              actualLogicalRange: actualLogical,
              actualTimeRange: actualTime,
              chartPaneWidth: paneW,
              visibleBars: visibleBars.toFixed(1),
              slotPxPerBar: slotPx.toFixed(1),
            })
          }, 300)
        }
      } else if (prevRange) {
        // Watcher refresh / levels load / trades load (data update on same TF).
        // Re-apply the pre-setData view both now AND after the layout pass —
        // setData re-fits a frame later, which was widening the locked zoom
        // on every live-day bar-watcher refresh.
        const pr = {
          from: Math.max(0, Math.min(prevRange.from, total - 0.5)),
          to: Math.min(prevRange.to, total - 0.5),
        }
        if (pr.to > pr.from) {
          if (LIVECHART_DEBUG) console.log('[livechart] PREV-RANGE re-apply', pr)
          tscale.setVisibleLogicalRange(pr)
          requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleLogicalRange(pr) })
        }
      }
    }
    // hover.trade?.id and hoverTradeId are in the dep list: when the user
    // hovers near a trade (crosshair) or the EOD row, the arrows re-render with
    // that trade's labels revealed + size bump, and its connector line bolds.
  }, [displayBars, trades, levels, prefs, symbol, date, chartTfMins, hover?.trade?.id, hoverTradeId])

  // Row-hover ↔ chart link: when a trade is hovered in the EOD list, drop the
  // crosshair on its entry (highlight where it was) and show the same
  // details+screenshot popup at that point. Clears when no row is hovered.
  useEffect(() => {
    const chart = chartRef.current
    const candle = candleRef.current
    if (!chart || !candle) return
    if (!hoverTradeId) {
      if (suppressCrosshairRef.current) {
        suppressCrosshairRef.current = false
        chart.clearCrosshairPosition()
        setHover(null)
      }
      return
    }
    const t = trades.find(x => x.id === hoverTradeId)
    if (!t || !t.entry_time) return
    const timeSec = displayTimeFromMs(new Date(t.entry_time).getTime(), chartTfMins)
    const price = t.entry_price ?? null
    suppressCrosshairRef.current = true // hold across the synthetic crosshair event
    // setCrosshairPosition throws "Value is null" when the time falls outside
    // the loaded bar range (which happens whenever the hovered trade's entry
    // is on a day whose bars haven't been imported, or the chart is still
    // mounting). Skip the synthetic crosshair in that case — the popup still
    // renders at the timeToCoordinate-resolved position, just without the
    // hairline.
    if (price != null) {
      try {
        chart.setCrosshairPosition(price, timeSec, candle)
      } catch {
        suppressCrosshairRef.current = false
      }
    }
    const x = chart.timeScale().timeToCoordinate(timeSec)
    const y = price != null ? candle.priceToCoordinate(price) : null
    setHover({ trade: t, x: x ?? 8, y: y ?? height / 2 })
  }, [hoverTradeId, trades, bars, levels, height, chartTfMins])

  // ── Annotations: load, render, draw ────────────────────────────────────
  // Load saved zones for this (symbol, date). Best-effort — never blocks the chart.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const qs = `date=${date}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`
        const res = await fetch(`/api/annotations?${qs}`)
        if (!res.ok) return
        const { annotations: rows } = await res.json() as { annotations: ChartAnnotation[] }
        if (!cancelled) setAnnotations(Array.isArray(rows) ? rows : [])
      } catch { /* annotations are best-effort */ }
    })()
    return () => { cancelled = true }
  }, [date, symbol])

  // Push annotations (with current selection) into the primitive on any change.
  useEffect(() => {
    annotationsPrimRef.current?.setData(annotations.map(a => ({ ...a, selected: a.id === selectedAnnId })))
  }, [annotations, selectedAnnId])

  // Esc closes menus / disarms the tool / clears selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setAnnMenu(null); setTextInput(null); setArmedTool(null); setSelectedAnnId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Pixel (container-relative) → {t: epoch seconds, p: price}, or null off-plot.
  const pxToTP = (x: number, y: number): { t: number; p: number } | null => {
    const t = chartRef.current?.timeScale().coordinateToTime(x)
    const p = candleRef.current?.coordinateToPrice(y)
    if (t == null || p == null) return null
    return { t: Number(t), p }
  }
  const overlayXY = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  // Topmost annotation under a pixel — hit test for select / right-click.
  // Zones test the filled rect; text tests a small box around its anchor.
  const annAtPixel = (x: number, y: number): string | null => {
    const ts = chartRef.current?.timeScale(); const s = candleRef.current
    if (!ts || !s) return null
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i]
      if (a.kind === 'zone') {
        const x1 = ts.timeToCoordinate(a.geom.t1 as Time), x2 = ts.timeToCoordinate(a.geom.t2 as Time)
        const y1 = s.priceToCoordinate(a.geom.p1 as number), y2 = s.priceToCoordinate(a.geom.p2 as number)
        if (x1 == null || x2 == null || y1 == null || y2 == null) continue
        if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return a.id
      } else if (a.kind === 'text') {
        const tx = ts.timeToCoordinate(a.geom.t as Time), ty = s.priceToCoordinate(a.geom.p as number)
        if (tx == null || ty == null) continue
        if (x >= tx - 6 && x <= tx + 140 && y >= ty - 6 && y <= ty + 22) return a.id
      }
    }
    return null
  }
  const deleteAnnotation = async (id: string) => {
    setAnnotations(prev => prev.filter(a => a.id !== id))
    setSelectedAnnId(prev => (prev === id ? null : prev))
    try { await fetch(`/api/annotations?id=${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
  }
  // Optimistic recolor of one annotation.
  const changeColor = async (id: string, color: string) => {
    setAnnotations(prev => prev.map(a => (a.id === id ? { ...a, color } : a)))
    try {
      await fetch(`/api/annotations?id=${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color }),
      })
    } catch { /* ignore */ }
  }
  // Create a text annotation (editId null) or rename an existing one. Clearing
  // the text of an existing label deletes it.
  const saveText = async (t: number, p: number, value: string, editId: string | null) => {
    const text = value.trim()
    if (editId) {
      if (!text) { void deleteAnnotation(editId); return }
      setAnnotations(prev => prev.map(a => (a.id === editId ? { ...a, note: text } : a)))
      try {
        await fetch(`/api/annotations?id=${editId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: text }),
        })
      } catch { /* ignore */ }
      return
    }
    if (!text) return
    try {
      const res = await fetch('/api/annotations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, symbol, kind: 'text', geom: { t, p }, note: text, color: drawColor }),
      })
      if (!res.ok) return
      const { annotation } = await res.json() as { annotation: ChartAnnotation }
      setAnnotations(prev => [...prev, annotation])
    } catch { /* ignore */ }
  }

  // Right-click on the overlay → context menu (draw / type / recolor / delete).
  const onOverlayContext = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const { x, y } = overlayXY(e)
    const tp = pxToTP(x, y)
    if (!tp) return
    const annId = annAtPixel(x, y)
    setSelectedAnnId(annId)
    setAnnMenu({ x, y, t: tp.t, p: tp.p, annId })
  }
  const onDrawDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (armedTool !== 'zone' || e.button !== 0) return
    const { x, y } = overlayXY(e)
    const tp = pxToTP(x, y)
    if (tp) drawStartRef.current = { x, y, t: tp.t, p: tp.p }
  }
  const onDrawMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!drawStartRef.current) return
    const { x, y } = overlayXY(e)
    const tp = pxToTP(x, y)
    const s = drawStartRef.current
    if (tp) annotationsPrimRef.current?.setPreview({ t1: s.t, p1: s.p, t2: tp.t, p2: tp.p }, drawColor)
  }
  const onDrawUp = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // Finishing a zone drag.
    if (drawStartRef.current) {
      const s = drawStartRef.current
      drawStartRef.current = null
      annotationsPrimRef.current?.setPreview(null)
      const { x, y } = overlayXY(e)
      if (Math.abs(x - s.x) > 4 || Math.abs(y - s.y) > 4) {
        const tp = pxToTP(x, y)
        if (tp) {
          try {
            const res = await fetch('/api/annotations', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ date, symbol, kind: 'zone', geom: { t1: s.t, p1: s.p, t2: tp.t, p2: tp.p }, color: drawColor }),
            })
            if (res.ok) {
              const { annotation } = await res.json() as { annotation: ChartAnnotation }
              setAnnotations(prev => [...prev, annotation])
            }
          } catch { /* ignore */ }
        }
      }
      setArmedTool(null) // one zone per arm
      return
    }
    // Plain left-click (not drawing) → select / deselect.
    const { x, y } = overlayXY(e)
    setSelectedAnnId(annAtPixel(x, y))
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-2">
      {/* Header: legend + symbol + bar count */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-3 text-gray-400">
          <span className="font-mono">{symbol ?? '—'}</span>
          {displayBars && displayBars.length > 0 && (
            <span className="text-gray-600">· {displayBars.length.toLocaleString()} bars</span>
          )}
          {/* Timeframe selector. Aggregates the stored 1-min bars client-side
              into the chosen TF. VWAP/EMA hide above 1m because their values
              are derived from 1-min bars and wouldn't line up. */}
          <div className="flex items-center gap-0.5 ml-1">
            {([
              { mins: 1, label: '1m' },
              { mins: 5, label: '5m' },
              { mins: 15, label: '15m' },
              { mins: 30, label: '30m' },
              { mins: 60, label: '1h' },
              { mins: 240, label: '4h' },
            ] as const).map(tf => (
              <button
                key={tf.mins}
                type="button"
                onClick={() => setChartTfMins(tf.mins)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  chartTfMins === tf.mins
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800'
                }`}
                title={`Show ${tf.label} candles`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5" style={{ backgroundColor: prefs.vwapColor }} />VWAP</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5" style={{ backgroundColor: prefs.ema9Color }} />EMA 9</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5" style={{ backgroundColor: prefs.ema20Color }} />EMA 20</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setSettingsOpen(o => !o)}
              className={`transition-colors ${settingsOpen ? 'text-blue-300' : 'text-gray-500 hover:text-gray-300'}`}
              title="Chart appearance"
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
            {settingsOpen && (
              <div className="absolute right-0 top-full mt-2 z-50 w-60 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 text-gray-300 normal-case max-h-[420px] overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-white text-xs">Chart appearance</span>
                  <button type="button" onClick={() => setSettingsOpen(false)} className="text-gray-500 hover:text-white"><X className="w-3 h-3" /></button>
                </div>
                <div className="space-y-2 text-xs">
                  {([
                    ['Background', 'background'],
                    ['Up bars', 'upColor'],
                    ['Down bars', 'downColor'],
                    ['VWAP', 'vwapColor'],
                    ['EMA 9', 'ema9Color'],
                    ['EMA 20', 'ema20Color'],
                    ['Levels', 'levelColor'],
                  ] as [string, keyof ChartPrefs][]).map(([label, key]) => (
                    <label key={key} className="flex items-center justify-between">
                      <span>{label}</span>
                      <input
                        type="color"
                        value={prefs[key] as string}
                        onChange={e => updatePref({ [key]: e.target.value } as Partial<ChartPrefs>)}
                        className="w-8 h-5 bg-transparent border border-gray-700 rounded cursor-pointer"
                      />
                    </label>
                  ))}
                  <label className="flex items-center justify-between">
                    <span>Font</span>
                    <select
                      value={prefs.fontFamily}
                      onChange={e => updatePref({ fontFamily: e.target.value })}
                      className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[11px] w-28"
                    >
                      {FONT_OPTIONS.map(f => <option key={f.label} value={f.value}>{f.label}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center justify-between">
                    <span>Font size</span>
                    <input
                      type="number" min={9} max={18} value={prefs.fontSize}
                      onChange={e => updatePref({ fontSize: Number(e.target.value) || 12 })}
                      className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[11px] w-12 text-right"
                    />
                  </label>
                  <label className="flex items-center justify-between">
                    <span>Grid lines</span>
                    <input type="checkbox" checked={prefs.showGrid} onChange={e => updatePref({ showGrid: e.target.checked })} className="accent-blue-600" />
                  </label>
                  <label className="flex items-center justify-between">
                    <span>Time zone</span>
                    <select
                      value={prefs.timeZone}
                      onChange={e => updatePref({ timeZone: e.target.value })}
                      className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[11px] w-32"
                    >
                      {TZ_OPTIONS.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
                    </select>
                  </label>

                  {/* Session levels controls */}
                  <div className="border-t border-gray-800 pt-2 mt-1 space-y-2">
                    <label className="flex items-center justify-between">
                      <span>Show levels</span>
                      <input type="checkbox" checked={prefs.showLevels} onChange={e => updatePref({ showLevels: e.target.checked })} className="accent-blue-600" />
                    </label>
                    <label className="flex items-center justify-between">
                      <span>EMA timeframe</span>
                      <select
                        value={prefs.emaTimeframeMins}
                        onChange={e => updatePref({ emaTimeframeMins: Number(e.target.value) || 5 })}
                        className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[11px] w-20"
                      >
                        {[1, 3, 5, 15].map(m => <option key={m} value={m}>{m} min</option>)}
                      </select>
                    </label>
                    {prefs.showLevels && (
                      <p className="text-[10px] text-gray-500">Right-click a level line on the chart to hide it.</p>
                    )}
                    {prefs.hiddenLevels.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-500">Hidden levels (click to restore)</span>
                          <button
                            type="button"
                            onClick={() => updatePref({ hiddenLevels: [] })}
                            className="text-[10px] text-blue-400 hover:text-blue-300"
                          >
                            Show all
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {prefs.hiddenLevels.map(k => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => updatePref({ hiddenLevels: prefs.hiddenLevels.filter(h => h !== k) })}
                              className="text-[10px] bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-400 hover:text-white hover:border-gray-500"
                            >
                              {k} ✕
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="border-t border-gray-800 pt-2 mt-1 space-y-1.5">
                    {/* Primary: lock everything in for this day */}
                    <button
                      type="button"
                      onClick={saveChartView}
                      className={`w-full text-xs font-medium rounded py-1.5 transition-colors ${
                        viewSavedFlash
                          ? 'bg-green-600 text-white'
                          : 'bg-blue-600 hover:bg-blue-500 text-white'
                      }`}
                    >
                      {viewSavedFlash ? 'Saved ✓' : 'Save chart view'}
                    </button>
                    <p className="text-[10px] text-gray-500">
                      Locks the current zoom for {date} + your colors/font. Restored automatically next time you open this day.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        if (symbol) clearView(symbol, date, chartTfMins)
                        chartRef.current?.timeScale().fitContent()
                      }}
                      className="w-full text-[10px] text-gray-400 hover:text-white border border-gray-700 rounded py-1"
                    >
                      Reset zoom (fit all)
                    </button>
                    <button
                      type="button"
                      onClick={() => updatePref(DEFAULT_PREFS)}
                      className="w-full text-[10px] text-gray-400 hover:text-white border border-gray-700 rounded py-1"
                    >
                      Reset colors to defaults
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chart container — always rendered so the chart instance can mount */}
      <div className="relative">
        <div ref={containerRef} onContextMenu={handleContextMenu} onDoubleClick={handleDoubleClick} style={{ height, width: '100%' }} className={loading || error ? 'opacity-30' : ''} />

        {/* Draw overlay — present only in Drawing Mode. Captures the mouse:
            right-click opens the tool menu, left-drag draws a zone once armed,
            a plain click selects. Exit Drawing Mode to pan/zoom again. */}
        {drawingMode && (
          <div
            className={`absolute inset-0 z-30 ${armedTool === 'zone' ? 'cursor-crosshair' : 'cursor-default'}`}
            style={{ height }}
            onMouseDown={onDrawDown}
            onMouseMove={onDrawMove}
            onMouseUp={onDrawUp}
            onContextMenu={onOverlayContext}
            onMouseLeave={() => { if (drawStartRef.current) { drawStartRef.current = null; annotationsPrimRef.current?.setPreview(null) } }}
          />
        )}

        {/* Annotation toolbar — the Drawing Mode toggle + a contextual hint. */}
        <div className="absolute top-2 left-2 z-40 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setDrawingMode(m => !m)
              setArmedTool(null); setAnnMenu(null); setTextInput(null); setSelectedAnnId(null)
            }}
            title={drawingMode ? 'Exit Drawing Mode (Esc). Right-click the chart for tools.' : 'Drawing Mode — right-click the chart to draw a zone or add text'}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium border transition-colors ${
              drawingMode
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-900/80 border-gray-700 text-gray-300 hover:text-white hover:border-gray-500'
            }`}
          >
            <Pencil className="w-3 h-3" /> Drawing Mode
          </button>
          {drawingMode && (
            <span className="text-[11px] text-gray-400 bg-gray-900/80 border border-gray-700 rounded-md px-2 py-1">
              {armedTool === 'zone' ? 'Drag to draw the zone' : 'Right-click the chart for tools'}
            </span>
          )}
        </div>

        {/* Right-click tool menu — on an annotation: recolor / edit text /
            delete; on empty chart: draw zone / add text / pick draw color. */}
        {annMenu && (() => {
          const target = annMenu.annId ? annotations.find(a => a.id === annMenu.annId) : null
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAnnMenu(null)} onContextMenu={e => { e.preventDefault(); setAnnMenu(null) }} />
              <div
                className="absolute z-50 min-w-[172px] bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 text-sm"
                style={{ left: Math.min(annMenu.x, 9999), top: annMenu.y }}
              >
                {target ? (
                  <>
                    {target.kind === 'text' && (
                      <button
                        type="button"
                        onClick={() => { setTextInput({ x: annMenu.x, y: annMenu.y, t: target.geom.t as number, p: target.geom.p as number, value: target.note, editId: target.id }); setAnnMenu(null) }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-200 hover:bg-gray-800 hover:text-white text-left"
                      >
                        <TypeIcon className="w-3.5 h-3.5 text-blue-400" /> Edit text
                      </button>
                    )}
                    <div className="px-3 py-1.5">
                      <div className="text-[11px] text-gray-500 mb-1">Color</div>
                      <div className="flex items-center gap-1.5">
                        {ANN_COLORS.map(c => (
                          <button
                            key={c} type="button" title={c}
                            onClick={() => { void changeColor(target.id, c); setAnnMenu(null) }}
                            className="w-4 h-4 rounded-full border border-black/40 hover:scale-110 transition-transform"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="my-1 border-t border-gray-800" />
                    <button
                      type="button"
                      onClick={() => { void deleteAnnotation(target.id); setAnnMenu(null) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-200 hover:bg-gray-800 hover:text-red-400 text-left"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-red-400" /> Delete
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => { setArmedTool('zone'); setAnnMenu(null) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-200 hover:bg-gray-800 hover:text-white text-left"
                    >
                      <Square className="w-3.5 h-3.5 text-emerald-400" /> Draw zone
                    </button>
                    <button
                      type="button"
                      onClick={() => { setTextInput({ x: annMenu.x, y: annMenu.y, t: annMenu.t, p: annMenu.p, value: '', editId: null }); setAnnMenu(null) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-200 hover:bg-gray-800 hover:text-white text-left"
                    >
                      <TypeIcon className="w-3.5 h-3.5 text-blue-400" /> Add text here
                    </button>
                    <div className="px-3 py-1.5">
                      <div className="text-[11px] text-gray-500 mb-1">Draw color</div>
                      <div className="flex items-center gap-1.5">
                        {ANN_COLORS.map(c => (
                          <button
                            key={c} type="button" title={c}
                            onClick={() => setDrawColor(c)}
                            className={`w-4 h-4 rounded-full border hover:scale-110 transition-transform ${drawColor === c ? 'border-white' : 'border-black/40'}`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )
        })()}

        {/* In-place text editor for add/edit. Enter or click-away saves; Esc cancels. */}
        {textInput && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => { void saveText(textInput.t, textInput.p, textInput.value, textInput.editId); setTextInput(null) }} />
            <input
              autoFocus
              value={textInput.value}
              onChange={e => setTextInput(ti => (ti ? { ...ti, value: e.target.value } : ti))}
              onKeyDown={e => {
                if (e.key === 'Enter') { void saveText(textInput.t, textInput.p, textInput.value, textInput.editId); setTextInput(null) }
                else if (e.key === 'Escape') { setTextInput(null) }
              }}
              placeholder="Type a label…"
              className="absolute z-50 px-2 py-1 rounded-md bg-gray-900 border border-blue-500 text-white text-xs outline-none shadow-xl"
              style={{ left: Math.min(textInput.x, 9999), top: textInput.y, minWidth: 140 }}
            />
          </>
        )}

        {/* Right-click-on-arrow menu. Dismisses on outside click / Escape (a
            full-screen backdrop + the Escape handler below). */}
        {arrowMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setArrowMenu(null)} onContextMenu={e => { e.preventDefault(); setArrowMenu(null) }} />
            <div
              className="absolute z-50 min-w-44 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 text-sm"
              style={{ left: Math.min(arrowMenu.x, 9999), top: arrowMenu.y }}
            >
              <button
                type="button"
                onClick={() => { const id = arrowMenu.tradeId; setArrowMenu(null); router.push(`/intraday/${date}?trade=${id}`) }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-gray-200 hover:bg-gray-800 hover:text-white text-left"
              >
                <Activity className="w-3.5 h-3.5 text-blue-400" />
                Go to intraday review
              </button>
            </div>
          </>
        )}

        {/* Hover-to-show-trade popup (task 3) */}
        {hover && (() => {
          const t = hover.trade
          const pnl = t.pnl ?? 0
          const exits = Array.isArray(t.exits_json) && t.exits_json.length > 0
            ? t.exits_json
            : (t.exit_time && t.exit_price != null ? [{ price: t.exit_price, qty: t.quantity ?? 0 }] : [])
          const setups: string[] = t.tags_json?.setups ?? []
          const mistakes: string[] = t.tags_json?.mistakes ?? []
          // Clamp position so the popup stays inside the chart
          const left = Math.min(Math.max(hover.x + 12, 4), 9999)
          const top = Math.min(Math.max(hover.y + 12, 4), height - 8)
          return (
            <div
              className="absolute z-40 pointer-events-none bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl px-3 py-2 text-xs min-w-[160px]"
              style={{ left, top, transform: left > 220 ? 'translateX(-100%)' : undefined }}
            >
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className={`font-bold ${t.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                  {(t.direction ?? '').toUpperCase()} {t.quantity ?? ''} @ {t.entry_price ?? '?'}
                </span>
                <span className={`font-mono font-bold ${pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                  {`${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(0)}`}
                </span>
              </div>
              <div className="text-gray-400 space-y-0.5">
                {exits.length > 0 && (
                  <div>
                    <div className="text-gray-500">Exits</div>
                    {/* Per-fill list stacked vertically so multi-leg
                        scale-outs are readable at a glance — was a single
                        comma-joined line that ran wide for 3+ fills. */}
                    <ul className="ml-2 font-mono text-[11px] leading-tight">
                      {exits.map((e: { qty: number; price: number }, i: number) => (
                        <li key={i}>{e.qty} @ {e.price}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {setups.length > 0 && <div className="text-blue-300">{setups.join(' · ')}</div>}
                {mistakes.length > 0 && <div className="text-red-300">{mistakes.join(' · ')}</div>}
              </div>
              {/* Trade entry screenshot (task 1) */}
              {t.screenshot_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.screenshot_url}
                  alt="Trade screenshot"
                  className="mt-2 rounded border border-gray-700 max-w-[320px] max-h-[200px] object-contain block"
                />
              )}
            </div>
          )
        })()}

        {/* Overlay states */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
          </div>
        )}

        {!loading && error === 'no-symbol' && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-6">
            <div>
              <AlertCircle className="w-6 h-6 text-gray-500 mx-auto mb-2" />
              <p className="text-sm text-gray-300">No symbol on trades for this day.</p>
              <p className="text-xs text-gray-500 mt-1">Import a Sierra Chart log to populate trade symbols.</p>
            </div>
          </div>
        )}

        {!loading && error && error !== 'no-symbol' && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-6">
            <div>
              <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
              <p className="text-sm text-red-300">Failed to load bars</p>
              <p className="text-xs text-gray-500 mt-1">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && bars && bars.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-6">
            <div>
              <Database className="w-6 h-6 text-gray-500 mx-auto mb-2" />
              <p className="text-sm text-gray-300">No bars imported for {symbol} on {date}</p>
              <p className="text-xs text-gray-500 mt-1">
                Go to <a href="/settings/bars" className="text-blue-400 hover:underline">Settings → Bar Data</a> and upload a CSV for this symbol + date range.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

LiveChart.displayName = 'LiveChart'

export default LiveChart
