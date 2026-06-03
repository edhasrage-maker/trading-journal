'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle, Database, Settings2, X } from 'lucide-react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type Time,
  type AutoscaleInfo,
} from 'lightweight-charts'
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
const viewKey = (symbol: string, date: string) => `livechart-view-v3-${symbol}-${date}`
function loadView(symbol: string, date: string): { from: number; to: number } | null {
  try { const r = localStorage.getItem(viewKey(symbol, date)); return r ? JSON.parse(r) : null } catch { return null }
}
function saveView(symbol: string, date: string, range: { from: number; to: number }) {
  try { localStorage.setItem(viewKey(symbol, date), JSON.stringify(range)) } catch { /* ignore */ }
}
function clearView(symbol: string, date: string) {
  try { localStorage.removeItem(viewKey(symbol, date)) } catch { /* ignore */ }
}

/**
 * Native chart (lightweight-charts v5) shared by the EOD + Intraday pages.
 * Renders the day's 1m bars with VWAP + EMA(9) + EMA(20) overlays, plus
 * entry/exit markers via the v5 createSeriesMarkers primitive. Replaces the
 * screenshot + calibration flow for days where bars have been imported.
 *
 * Empty states:
 *   - No symbol on trades → "Import trades first" message
 *   - Bars not found for that symbol+date → "Import bars" hint with link
 *     to /settings/bars
 */
export default function LiveChart({ date, symbol, trades, height = 480, refreshKey = 0, hoverTradeId = null }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // Current candle OHLC (kept in a ref) so the price-scale autoscale provider
  // can fit the axis to the VISIBLE candles instead of the far-away level lines.
  const candleDataRef = useRef<Array<{ high: number; low: number }>>([])
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null)
  // v5 moved markers off the series API into a separate primitive.
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  // Static session-level horizontal lines (recreated each data update).
  const priceLinesRef = useRef<IPriceLine[]>([])
  // Parallel record of the currently-drawn levels (key + price) so the
  // right-click handler can hit-test a click against the nearest line.
  const levelLinesRef = useRef<Array<{ key: string; price: number }>>([])
  // Per-trade entry→exit connector lines (2-point dashed line series each).
  const tradeLinesRef = useRef<ISeriesApi<'Line'>[]>([])

  const [bars, setBars] = useState<ApiBar[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
  const [hasSavedView, setHasSavedView] = useState(false)
  useEffect(() => { setHasSavedView(!!(symbol && loadView(symbol, date))) }, [symbol, date])

  // Pull-on-mount: the one-shot chart-prefs migration only runs once per PC,
  // so a view saved on the OTHER PC after this PC migrated would never appear
  // here. This effect closes that gap — fetches the server's value for this
  // exact (symbol, date) view key, and if it differs from local, hydrates
  // localStorage + applies it. 30s cache in pullChartPref prevents repeated
  // fetches when chartView toggles or the component re-mounts.
  useEffect(() => {
    if (!symbol) return
    let cancelled = false
    void pullChartPref(viewKey(symbol, date)).then(serverValue => {
      if (cancelled) return
      if (!serverValue || typeof serverValue !== 'object') return
      const range = serverValue as { from: number; to: number }
      if (typeof range.from !== 'number' || typeof range.to !== 'number') return
      const local = loadView(symbol, date)
      if (local && local.from === range.from && local.to === range.to) return
      // Server differs from local — hydrate localStorage so loadView picks it
      // up on subsequent restores, then apply directly if the chart is
      // already past its first-restore for this day.
      saveView(symbol, date, range)
      setHasSavedView(true)
      const sameDay = restoredKeyRef.current === `${symbol}|${date}`
      const tscale = chartRef.current?.timeScale()
      if (sameDay && tscale) {
        tscale.setVisibleLogicalRange(range)
        requestAnimationFrame(() => {
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
    const r = chartRef.current?.timeScale().getVisibleLogicalRange()
    if (r && symbol) {
      const range = { from: r.from, to: r.to }
      saveView(symbol, date, range)
      // Push the per-day view to Supabase so opening the same day on the
      // other PC restores the same zoom.
      schedulePushChartPref(viewKey(symbol, date), range)
      setHasSavedView(true)
    }
    setViewSavedFlash(true)
    setTimeout(() => setViewSavedFlash(false), 1500)
  }

  // Right-click a level line to hide it. Hit-tests the click Y against each
  // drawn level's screen coordinate (priceToCoordinate); if one is within ~8px
  // we suppress the browser menu and add its key to hiddenLevels. Re-show via
  // the settings popover's "Hidden levels" chips or "Show all".
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!candleRef.current || levelLinesRef.current.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    let bestKey: string | null = null
    let bestDelta = Infinity
    for (const lvl of levelLinesRef.current) {
      const coord = candleRef.current.priceToCoordinate(lvl.price)
      if (coord == null) continue
      const d = Math.abs(coord - y)
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
  useEffect(() => {
    if (!symbol) { setLevels(null); return }
    let cancelled = false
    fetch(`/api/bars/levels?symbol=${encodeURIComponent(symbol)}&date=${date}&emaTf=${prefs.emaTimeframeMins}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setLevels({ levels: d.levels ?? null, series: d.series ?? [] }) })
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
    // VWAP/EMA overlays must NOT drive the price axis — on a trend day the
    // session-anchored VWAP sits far from the candles and would blow out the
    // vertical scale (squashing the candles). Returning null keeps the price
    // axis fit to the candles only; these lines clip if they fall off-screen.
    const noAutoscale = { autoscaleInfoProvider: () => null }
    vwapRef.current = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      ...noAutoscale,
    })
    ema9Ref.current = chart.addSeries(LineSeries, {
      color: '#eab308',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      ...noAutoscale,
    })
    ema20Ref.current = chart.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      ...noAutoscale,
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
        const ts = new Date(t.entry_time).getTime() / 1000
        const d = Math.abs(ts - timeSec)
        if (d < bestDelta) { bestDelta = d; best = t }
      }
      if (best && bestDelta <= 90) setHover({ trade: best, x: param.point.x, y: param.point.y })
      else setHover(null)
    })

    // NOTE: no auto-save-on-pan. The saved view is written ONLY by the explicit
    // "Save chart view" button, so it's a true lock-in — panning/zooming (or new
    // bars shifting the range on the live day) can never silently overwrite it.

    return () => {
      obs.disconnect()
      markersRef.current = null
      priceLinesRef.current = []
      levelLinesRef.current = []
      tradeLinesRef.current = []
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      vwapRef.current = null
      ema9Ref.current = null
      ema20Ref.current = null
    }
  }, [height])

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
  }, [prefs])

  // Push data + markers whenever bars or trades change
  useEffect(() => {
    if (!candleRef.current || !vwapRef.current || !ema9Ref.current || !ema20Ref.current) return
    if (!bars || bars.length === 0) {
      candleRef.current.setData([])
      candleDataRef.current = []
      vwapRef.current.setData([])
      ema9Ref.current.setData([])
      ema20Ref.current.setData([])
      markersRef.current?.setMarkers([])
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

    const candleData = bars.map(b => ({
      time: (new Date(b.ts).getTime() / 1000) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
    candleRef.current.setData(candleData)
    candleDataRef.current = candleData // for the price-scale autoscale provider

    // Study-matched VWAP / EMA9 / EMA20 series from /api/bars/levels (replaces
    // the previous simple client-side calc). Falls back to empty until levels
    // load.
    const ser = levels?.series ?? []
    const toLine = (key: 'vwap' | 'ema9' | 'ema20') =>
      ser
        .filter(p => p[key] != null)
        .map(p => ({ time: (new Date(p.ts).getTime() / 1000) as Time, value: p[key] as number }))
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

    // Trade markers — entries are direction-shaped arrows; exits are one
    // circle PER partial-fill (from exits_json) so multi-leg scale-outs
    // render distinctly. Falls back to the aggregated exit_time/exit_price
    // single marker for old trades that pre-date exits_json.
    type Marker = {
      time: Time
      position: 'belowBar' | 'aboveBar'
      color: string
      shape: 'arrowUp' | 'arrowDown' | 'circle'
      text: string
    }
    const markers: Marker[] = []
    for (const t of trades) {
      if (!t.entry_time || !t.direction) continue
      const isLong = t.direction === 'long'
      const entryPrice = t.entry_price ?? null
      const pnl = t.pnl ?? 0
      const entryColor = pnl > 0 ? '#22c55e' : pnl < 0 ? '#ef4444' : '#6b7280'
      // Entry
      markers.push({
        time: (new Date(t.entry_time).getTime() / 1000) as Time,
        position: isLong ? 'belowBar' : 'aboveBar',
        color: entryColor,
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: `${t.direction.toUpperCase()} ${t.quantity ?? ''}@${entryPrice ?? '?'}`,
      })
      // Exits: prefer per-fill array, fall back to aggregated single exit
      const exitList: Array<{ time: string; price: number; qty: number }> =
        Array.isArray(t.exits_json) && t.exits_json.length > 0
          ? t.exits_json
          : t.exit_time && t.exit_price != null
            ? [{ time: t.exit_time, price: t.exit_price, qty: t.quantity ?? 0 }]
            : []
      for (const e of exitList) {
        // Per-exit color based on whether THIS partial was favorable
        const favorable = entryPrice != null
          ? (isLong ? e.price > entryPrice : e.price < entryPrice)
          : true
        const exitColor = favorable ? '#22c55e' : '#ef4444'
        markers.push({
          time: (new Date(e.time).getTime() / 1000) as Time,
          position: isLong ? 'aboveBar' : 'belowBar',
          color: exitColor,
          shape: 'circle',
          text: `Exit ${e.qty}@${e.price}`,
        })
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    // v5 markers API: create the primitive once, then update it. (v4's
    // candleSeries.setMarkers() was removed in v5 and threw here, which
    // also prevented fitContent() below from running — leaving the chart
    // looking blank even when candle data was set.)
    if (markersRef.current) {
      markersRef.current.setMarkers(markers)
    } else {
      markersRef.current = createSeriesMarkers(candleRef.current, markers)
    }

    // Entry→exit connector lines: a 2-point dashed line series per trade leg.
    // Endpoints snapped to the minute so they sit on the candle time scale;
    // legs whose entry and exit fall in the same minute are skipped (a line
    // would collapse to a point). Color matches the exit marker (green if the
    // partial beat entry, red if not).
    const chart = chartRef.current
    if (chart) {
      for (const s of tradeLinesRef.current) chart.removeSeries(s)
      tradeLinesRef.current = []
      const snapMin = (ms: number) => (Math.floor(ms / 60000) * 60) as Time
      for (const t of trades) {
        if (!t.entry_time || !t.direction || t.entry_price == null) continue
        const isLong = t.direction === 'long'
        const entryMin = snapMin(new Date(t.entry_time).getTime())
        const exitList: Array<{ time: string; price: number }> =
          Array.isArray(t.exits_json) && t.exits_json.length > 0
            ? t.exits_json
            : t.exit_time && t.exit_price != null
              ? [{ time: t.exit_time, price: t.exit_price }]
              : []
        for (const e of exitList) {
          const exitMin = snapMin(new Date(e.time).getTime())
          if ((exitMin as number) <= (entryMin as number)) continue // same/earlier minute → skip
          const favorable = isLong ? e.price > t.entry_price : e.price < t.entry_price
          const line = chart.addSeries(LineSeries, {
            color: favorable ? '#22c55e' : '#ef4444',
            lineWidth: 1,
            lineStyle: 2, // dashed
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null, // don't let connectors drive the price axis
          })
          line.setData([
            { time: entryMin, value: t.entry_price },
            { time: exitMin, value: e.price },
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
      if (restoredKeyRef.current !== dayKey) {
        // First open of this day: restore the saved view (or fit if none).
        restoredKeyRef.current = dayKey
        const saved = symbol ? loadView(symbol, date) : null
        const applyView = () => {
          if (saved) tscale.setVisibleLogicalRange({ from: saved.from, to: saved.to })
          else tscale.fitContent()
        }
        applyView()
        // Re-apply after the library's post-setData layout pass — a synchronous
        // range set on the FIRST data load is otherwise overridden by the
        // chart's auto-fit, which is why the saved zoom never stuck.
        requestAnimationFrame(applyView)
      } else if (prevRange) {
        // Already restored: a data update (watcher refresh, levels/trades load).
        // Re-apply the pre-setData view both now AND after the layout pass —
        // setData re-fits a frame later, which was widening the locked zoom on
        // every live-day bar-watcher refresh.
        const pr = { from: prevRange.from, to: prevRange.to }
        tscale.setVisibleLogicalRange(pr)
        requestAnimationFrame(() => { chartRef.current?.timeScale().setVisibleLogicalRange(pr) })
      }
    }
  }, [bars, trades, levels, prefs, symbol, date])

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
    const timeSec = (Math.floor(new Date(t.entry_time).getTime() / 60000) * 60) as Time
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
  }, [hoverTradeId, trades, bars, levels, height])

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-2">
      {/* Header: legend + symbol + bar count */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-3 text-gray-400">
          <span className="font-mono">{symbol ?? '—'}</span>
          {bars && bars.length > 0 && (
            <span className="text-gray-600">· {bars.length.toLocaleString()} bars</span>
          )}
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
                        if (symbol) clearView(symbol, date)
                        setHasSavedView(false)
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
        <div ref={containerRef} onContextMenu={handleContextMenu} style={{ height, width: '100%' }} className={loading || error ? 'opacity-30' : ''} />

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
                  <div>Exits: {exits.map((e: { qty: number; price: number }) => `${e.qty}@${e.price}`).join(', ')}</div>
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
}
