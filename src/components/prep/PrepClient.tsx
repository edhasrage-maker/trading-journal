'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { todayPT } from '@/lib/pt-time'
import { Loader2, Check, AlertTriangle } from 'lucide-react'
import ScreenshotUpload from './ScreenshotUpload'
import ConditionFilterPanel from '@/components/condition/ConditionFilterPanel'
import MarketContextForm from './MarketContextForm'
import PrepNotesForm from './PrepNotesForm'
import SessionPicker from './SessionPicker'
import DiscordDashboard from './DiscordDashboard'
import DiscordCardInputs from './DiscordCardInputs'
import TradePlansSection from './TradePlansSection'
import SpellCheckModal from './SpellCheckModal'
import DayTypePredictor from './DayTypePredictor'
import { classifyIbDayType, ibDayTypeHeadline, ibDayTypeAiRead } from '@/lib/ib-day-type'
import HighImpactNews from './HighImpactNews'
import Section, { GhostButton, Segmented, Chip } from '@/components/ui/Section'
import PrepHero from './PrepHero'
import PrepBridge from './PrepBridge'
import PrepLedger from './PrepLedger'
import PrepAiRead, { WatchKeep } from './PrepAiRead'
import { dayTypeConsequence, formatR, type Carryover } from '@/lib/prep-carryover'
import type { TradeWithContext } from '@/lib/analytics'
import type { NewsEvent } from '@/lib/economic-calendar'
import LiveChart, { type LiveChartHandle } from '@/components/charts/LiveChart'
import { useChartInstruments } from '@/lib/use-chart-instruments'
import BarWatcher from '@/components/charts/BarWatcher'
import { LOCAL_FEATURES_ENABLED } from '@/lib/local-features'
import { useUiMode } from '@/lib/ui-mode'
import { deleteBlob } from '@/lib/storage'
import type { TradingDay, MarketContext, PrepNotes, AiAnalysis, PlanAssessment, TradePlan, Trade } from '@/lib/supabase/types'
import type { SessionLevels, SessionKind } from '@/lib/session-levels'
import type { DayContextStats } from '@/lib/market-context-from-bars'
import type { SpellCheckCorrection } from '@/app/api/spell-check/route'

interface Props {
  date: string
  initialDay: TradingDay | null
  initialContext: MarketContext | null
  /** Day-type labels from trade_tags. Single source of truth shared with the
   *  intraday TradeForm — picking one here pre-selects the matching chip on
   *  every NEW trade for the day (via the auto-populate flow). */
  dayTypeOptions: string[]
  /** Auto-detected DR_ADR (6:30-7:30 PT range ÷ ADR) from 1-min bars in the
   *  ohlcv_bars table. Null when bars haven't been imported yet for the date
   *  or market_context.adr is missing — pill falls back to manual entry. */
  drAdrAuto: number | null
  /** Symbol fed to the LiveChart — derived server-side from the day's trades,
   *  falling back to MNQM6.CME on days with no trades yet so the chart still
   *  renders the current session's price action. */
  chartSymbol: string | null
  /** Trades already taken on this date (may be empty during morning prep).
   *  Powers the chart's entry/exit markers. */
  initialTrades: Trade[]
  /** High-impact ("red folder") economic news for the day, server-fetched. */
  highImpactNews: NewsEvent[]
  /** Admin (owner) flag — the Morning Conditions panel is admin-only, matching
   *  the admin-only Condition Lookup settings page. Computed server-side. */
  isAdmin: boolean
  /** The Review → Prep carryover: one finding from the trader's own recent
   *  sessions, turned into a commitment for today. Null when nothing separated
   *  itself — the bridge then renders its honest "no read" state rather than
   *  manufacturing a lesson. */
  carryover: Carryover | null
  /** Trades from the carryover window, joined with day/context. Powers the
   *  per-day-type consequence line ("on high-action days you average +0.6R"). */
  historyTrades: TradeWithContext[]
}

export default function PrepClient({ date, initialDay, initialContext, dayTypeOptions, drAdrAuto, chartSymbol, initialTrades, highImpactNews, isAdmin, carryover, historyTrades }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  // Bumped by BarWatcher when new bars import; forces LiveChart to re-fetch.
  const [barsVersion, setBarsVersion] = useState(0)
  // ES/NQ instrument switcher for the chart (shared with intraday + EOD). Other
  // chartSymbol uses (market-context auto-fill) stay on the day's default.
  const { activeSymbol, symbolOptions, onSymbolChange, chartTrades } = useChartInstruments(chartSymbol, initialTrades)
  // Ref to the LiveChart so analyze() can snapshot its canvas as a PNG when
  // the user hasn't pasted a Sierra screenshot. Falls back to text-only
  // analysis if the chart isn't ready (no bars / pre-mount / screenshot view).
  const liveChartRef = useRef<LiveChartHandle>(null)
  // Chart view toggle — same pattern as EodClient. Defaults to LIVE so
  // session levels (PDH/PDL/IBH/IBL/ONH/ONL + extensions, VWAP, EMA9/20) are
  // visible immediately on page open — those compute from the .scid bars, no
  // screenshot required. User can flip to Screenshot when they want to paste
  // a Sierra view + run Auto-fill (which still owns the RVOL/ADR/ATR numerical
  // extraction + the AI prep-analysis vision step). State is per-mount
  // (resets on navigation between days).
  const [chartView, setChartView] = useState<'screenshot' | 'live'>('live')
  const isFirstRender = useRef(true)
  // Set true by the auto-fill paths (session levels, bar-native stats, derived
  // PD/GBX flags) whenever they actually change `context`, so the dirty effect
  // can tell a programmatic fill from a genuine user edit and skip marking the
  // form "Unsaved" on first load. Consumed (and reset) once per context change.
  const autoFilledContextRef = useRef(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [spellCheckOpen, setSpellCheckOpen] = useState(false)
  const [spellCheckLoading, setSpellCheckLoading] = useState(false)
  const [spellCheckResults, setSpellCheckResults] = useState<SpellCheckCorrection[]>([])
  const [spellCheckLabels, setSpellCheckLabels] = useState<Record<string, string>>({})

  // Auto-save state
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(
    initialDay?.updated_at ? new Date(initialDay.updated_at).getTime() : null,
  )
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savingRef = useRef(false) // prevents auto-save from racing with itself or with manual save
  const restoredRef = useRef(false)
  const STORAGE_KEY = `prep-draft-${date}`
  const AUTO_SAVE_DELAY_MS = 3000

  // Highlights (beginner) keeps Chart + Day Type + Prep Notes (Bias/Observations/
  // Mood) + the AI read; Detailed Tape (pro) adds Morning Conditions, Market
  // Context, and Trade Plans. (docs/BEGINNER_PRO_MODES.md)
  const { mode } = useUiMode()
  const [savedChartUrl, setSavedChartUrl] = useState<string | null>(initialDay?.chart_screenshot_url ?? null)
  const [chartUrl, setChartUrl] = useState<string | null>(initialDay?.chart_screenshot_url ?? null)
  // Multi-select: prep can tag combo sessions like "High Action + Double Inside".
  // Source of truth is the array. The legacy single `day_type` is derived as
  // dayTypes[0] (or '') when saving, so analytics/predict-day-type that still
  // read the single column keep working until they migrate.
  const [dayTypes, setDayTypes] = useState<string[]>(() => {
    if (initialDay?.day_types && initialDay.day_types.length > 0) return initialDay.day_types
    if (initialDay?.day_type) return [initialDay.day_type]
    return []
  })
  const dayType = dayTypes[0] ?? ''  // legacy alias for places that still read a single primary
  const toggleDayType = (label: string) => {
    setDayTypes(prev => prev.includes(label) ? prev.filter(l => l !== label) : [...prev, label])
  }
  const [backfilling, setBackfilling] = useState(false)
  const [context, setContext] = useState<Partial<Omit<MarketContext, 'id' | 'trading_day_id' | 'stat_performance_json' | 'created_at'>>>(
    initialContext ? {
      symbol: initialContext.symbol,
      pdh: initialContext.pdh ?? undefined,
      pdl: initialContext.pdl ?? undefined,
      ibh: initialContext.ibh ?? undefined,
      ibl: initialContext.ibl ?? undefined,
      onh: initialContext.onh ?? undefined,
      onl: initialContext.onl ?? undefined,
      rvol: initialContext.rvol ?? undefined,
      rvol_flag: initialContext.rvol_flag ?? undefined,
      ib_size: initialContext.ib_size ?? undefined,
      ib_10d_avg: initialContext.ib_10d_avg ?? undefined,
      ib_vs_10d_avg: initialContext.ib_vs_10d_avg ?? undefined,
      adr: initialContext.adr ?? undefined,
      adr_flag: initialContext.adr_flag ?? undefined,
      day_range: initialContext.day_range ?? undefined,
      gbx_pct_adr: initialContext.gbx_pct_adr ?? undefined,
      atr_1m: initialContext.atr_1m ?? undefined,
      atr_flag: initialContext.atr_flag ?? undefined,
      price_in_pd_range: initialContext.price_in_pd_range ?? undefined,
      price_in_gbx_range: initialContext.price_in_gbx_range ?? undefined,
    } : { symbol: 'NQ' }
  )
  const [prepNotes, setPrepNotes] = useState<PrepNotes>(initialDay?.prep_notes_json ?? {})
  // Which trading session this prep targets. Drives the session-aware chart
  // levels/IB + the market-context fetch. Persisted inside prep_notes_json (no
  // schema change); default RTH. Asia/London are the GBX/overnight sessions.
  const session: SessionKind = (prepNotes.session as SessionKind | undefined) ?? 'rth'
  // Latest session levels from the chart's onLevels callback — powers the
  // read-only GBX levels readout in the SessionPicker.
  const [liveLevels, setLiveLevels] = useState<SessionLevels | null>(null)
  const changeSession = (s: SessionKind) => {
    setPrepNotes(prev => (prev.session === s ? prev : { ...prev, session: s }))
    // Planning a GBX/overnight session → set the day-level GBX chip so prep,
    // day-type, and analytics agree before trades print (mirrors the intraday
    // GBX auto-tagging). Add-only: switching back to RTH doesn't strip a chip
    // the user may have set deliberately.
    if (s !== 'rth' && dayTypeOptions.includes('GBX')) {
      setDayTypes(prev => (prev.includes('GBX') ? prev : [...prev, 'GBX']))
    }
  }
  // Auto-fill the Market Context form from the Live chart's computed session
  // levels — the chart already draws PDH/PDL/IBH/IBL/ONH/ONL deterministically
  // from the .scid, so on "Live chart" view the form no longer stays empty.
  // Each field is filled at most once and only when blank, so a value the user
  // typed (or one loaded from a saved prep) is never clobbered, and a refresh
  // every 3 min won't re-fill a field the user later cleared.
  const levelsAutoFilledRef = useRef<Set<string>>(new Set())
  const handleLevels = useCallback((lvls: SessionLevels | null) => {
    setLiveLevels(lvls)
    if (!lvls) return
    // PDH/PDL/ONH/ONL are session-invariant (prior RTH high/low + overnight) —
    // always auto-fill. IBH/IBL are the ACTIVE session's IB; only write them into
    // the RTH-semantic market_context on RTH days, so a GBX session's IB never
    // overwrites the RTH IB that analytics condition-buckets read.
    const map: Record<string, number | null> = {
      pdh: lvls.pdh, pdl: lvls.pdl, onh: lvls.onh, onl: lvls.onl,
      ...(session === 'rth' ? { ibh: lvls.ibh, ibl: lvls.ibl } : {}),
    }
    setContext(prev => {
      const next = { ...prev }
      let changed = false
      for (const [k, v] of Object.entries(map)) {
        if (levelsAutoFilledRef.current.has(k)) continue
        levelsAutoFilledRef.current.add(k) // handle each field once, fill or skip
        if (v == null) { levelsAutoFilledRef.current.delete(k); continue } // no value yet — retry next refresh
        const cur = (prev as Record<string, unknown>)[k]
        if (cur == null || cur === '') { (next as Record<string, unknown>)[k] = v; changed = true }
      }
      if (changed) autoFilledContextRef.current = true // programmatic fill — must not mark the form dirty
      return changed ? next : prev
    })
  }, [session])

  // Auto-fill the volatility/volume stats (RVOL/ADR/ATR/IB size/day range) from
  // bars — the bar-native equivalent of reading them off a Sierra screenshot.
  // Same fill-blank-once discipline as levels; re-runs when BarWatcher imports
  // new bars (barsVersion) so realized stats land as the session prints. A
  // still-null field is un-marked so it retries on the next refresh.
  const statsAutoFilledRef = useRef<Set<string>>(new Set())
  // Bar-native current price → drives the PD/GBX "in range?" flags (effect
  // below), replacing the fragile screenshot read of "current price".
  const [barCurrentPrice, setBarCurrentPrice] = useState<number | null>(null)
  // 10-day average of the 1-min ATR — the "typical" baseline behind the
  // Today's Tape bar-volatility verdict ("2.7× normal"). Display-only; never
  // written into market_context. Kept once non-null so a session-switch fetch
  // returning null doesn't blank the verdict.
  const [atrBaseline, setAtrBaseline] = useState<number | null>(null)
  // Full bar-derived stats for the active session — feeds the IB day-type
  // classification (choppy/normal/extended via meanHL10). Distinct from the
  // fill-blank-once market_context auto-fill below (which only pulls 5 fields).
  const [contextStats, setContextStats] = useState<DayContextStats | null>(null)
  // IB day-type classification (choppy/normal/extended via IB÷ATR + small/normal/
  // large size) from the bar stats — folded into the Market Context ledger (pro),
  // surfaced as a Highlights one-liner (beginner), and fed to the AI predictor.
  const ibDayType = useMemo(() => classifyIbDayType({
    session,
    ibRange: contextStats?.ib_size ?? null,
    atrMeanHL10: contextStats?.meanHL10 ?? null,
    atrWilder10: contextStats?.atr_at_ib_close ?? null,
    ibVs10dAvg: contextStats?.ib_vs_10d_avg ?? null,
  }), [session, contextStats])
  useEffect(() => {
    if (!chartSymbol || !date) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/bars/market-context?symbol=${encodeURIComponent(chartSymbol)}&date=${date}${session !== 'rth' ? `&session=${session}` : ''}`)
        if (!res.ok) return
        const { stats } = await res.json() as { stats: DayContextStats | null }
        if (cancelled) return
        setContextStats(stats)
        if (!stats) return
        setBarCurrentPrice(stats.current_price ?? null)
        if (stats.atr_10d_avg != null) setAtrBaseline(stats.atr_10d_avg)
        // Only auto-fill the persisted RTH market_context on RTH days. On
        // Asia/London the stats are either session-anchored (IB size/range) or
        // muted (RVOL/ADR/ATR are RTH-baselined) — surfaced read-only in the
        // SessionPicker readout, never written into the RTH-semantic table.
        if (session !== 'rth') return
        const map: Record<string, number | null> = {
          rvol: stats.rvol, ib_size: stats.ib_size, adr: stats.adr, atr_1m: stats.atr_1m, day_range: stats.day_range,
          // ib_vs_10d_avg was omitted originally, so the ledger's "IB vs 10-day
          // avg" row + the Morning Conditions IB metric (both read the form value)
          // showed blank on any account that hadn't saved it — the bar feed
          // computes it, so auto-fill it too (ratio, e.g. 1.22).
          ib_vs_10d_avg: stats.ib_vs_10d_avg,
        }
        setContext(prev => {
          const next = { ...prev }
          let changed = false
          for (const [k, v] of Object.entries(map)) {
            if (statsAutoFilledRef.current.has(k)) continue
            statsAutoFilledRef.current.add(k)
            if (v == null) { statsAutoFilledRef.current.delete(k); continue }
            const cur = (prev as Record<string, unknown>)[k]
            if (cur == null || cur === '') { (next as Record<string, unknown>)[k] = v; changed = true }
          }
          if (changed) autoFilledContextRef.current = true // programmatic fill — must not mark the form dirty
          return changed ? next : prev
        })
      } catch { /* best-effort — screenshot/manual entry still available */ }
    })()
    return () => { cancelled = true }
  }, [chartSymbol, date, barsVersion, session])

  // Derive the "Price between PDH/PDL?" and "Price in GBX range?" flags from the
  // bar-native current price + the levels in the form — overwriting the fragile
  // screenshot read (which mis-grabs the trade-entry label as "current price").
  // Only once the day's session has printed a price (barCurrentPrice non-null)
  // and the relevant levels exist; re-runs as the price or levels update.
  useEffect(() => {
    if (barCurrentPrice == null) return
    const cp = barCurrentPrice
    const numOr = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
      return Number.isFinite(n) ? n : null
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derive PD/GBX flags from bar price + levels; runs only on price/level change and never loops (the flags aren't in deps)
    setContext(prev => {
      const next = { ...prev }
      let changed = false
      const pdl = numOr(prev.pdl), pdh = numOr(prev.pdh)
      if (pdl != null && pdh != null) {
        const v = cp >= Math.min(pdl, pdh) && cp <= Math.max(pdl, pdh)
        if (prev.price_in_pd_range !== v) { next.price_in_pd_range = v; changed = true }
      }
      const onl = numOr(prev.onl), onh = numOr(prev.onh)
      if (onl != null && onh != null) {
        const v = cp >= Math.min(onl, onh) && cp <= Math.max(onl, onh)
        if (prev.price_in_gbx_range !== v) { next.price_in_gbx_range = v; changed = true }
      }
      if (changed) autoFilledContextRef.current = true // derived flags — must not mark the form dirty
      return changed ? next : prev
    })
  }, [barCurrentPrice, context.pdl, context.pdh, context.onl, context.onh])

  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(
    initialDay?.ai_analysis_json && Object.keys(initialDay.ai_analysis_json).length > 0
      ? initialDay.ai_analysis_json as AiAnalysis
      : null
  )

  // Prep timing: first-edit start time + last-edit completion time.
  // Used to track "time at desk" vs subsequent PnL.
  const [prepStartedAt, setPrepStartedAt] = useState<string | null>(initialDay?.prep_started_at ?? null)
  const [prepCompletedAt, setPrepCompletedAt] = useState<string | null>(initialDay?.prep_completed_at ?? null)
  // PT-anchored so "is this today?" matches the PT-anchored nav links (todayPT).
  // Machine-local would mis-flag the live-chart default + prep-timing capture
  // on a host whose OS timezone is wrong.
  const todayStr = todayPT()
  const isToday = date === todayStr

  // Mark dirty on any field change (skip the very first render).
  // Also captures prep_started_at on the FIRST edit of today's prep.
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    // Auto-fill (session levels / bar stats / derived flags) mutated context —
    // that's the system populating the form, not a user edit. Skip marking dirty
    // (and skip capturing prep_started_at) so the form doesn't show "Unsaved" on
    // first load. Reset so the next genuine edit is caught.
    if (autoFilledContextRef.current) { autoFilledContextRef.current = false; return }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDirty(true)
    if (isToday && !prepStartedAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrepStartedAt(new Date().toISOString())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, prepNotes, chartUrl, dayType])

  // Warn before browser close / refresh when there are unsaved changes
  useEffect(() => {
    if (!isDirty) return
    const handle = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [isDirty])

  // ---- Auto-save: localStorage backup on every change ----
  // Survives disconnection, browser crash, accidental tab close.
  useEffect(() => {
    if (!isDirty) return
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        data: { context, prepNotes, dayType, dayTypes, chartUrl, aiAnalysis },
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // localStorage full / disabled — silent fallback to server-only save
    }
  }, [context, prepNotes, dayType, dayTypes, chartUrl, aiAnalysis, isDirty, STORAGE_KEY])

  const uploadScreenshot = async (file: File): Promise<string | null> => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('bucket', 'screenshots')
    formData.append('path', `chart/${date}-${Date.now()}.${file.name.split('.').pop()}`)
    const res = await fetch('/api/screenshots', { method: 'POST', body: formData })
    const data = await res.json()
    return data.url ?? null
  }

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  // One-shot button under the day-type grid: overwrites every existing trade's
  // tags_json.day_type for this date with the currently-selected dayTypes
  // array. Trades already tagged with the same set are skipped server-side.
  const backfillDayType = async () => {
    if (dayTypes.length === 0) return
    const label = dayTypes.length === 1 ? `"${dayTypes[0]}"` : `[${dayTypes.join(', ')}]`
    if (!confirm(
      `Apply day type ${label} to all existing trades on ${date}?\n\n` +
      `Each updated trade's other tags are preserved.`
    )) return
    setBackfilling(true)
    try {
      const res = await fetch('/api/trades/backfill-day-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send both for backward compat with the route until it's updated to
        // accept dayTypes natively. Route currently reads dayType only.
        body: JSON.stringify({ date, dayType, dayTypes }),
      })
      const data = await res.json() as { updated?: number; total?: number; skipped?: number; error?: string }
      if (!res.ok) {
        showToast(`Backfill failed: ${data.error ?? res.statusText}`, 'error')
        return
      }
      const { updated = 0, total = 0, skipped = 0 } = data
      if (total === 0) {
        showToast(`No trades logged for ${date} yet`, 'success')
      } else if (updated === 0) {
        showToast(`All ${total} trade${total === 1 ? '' : 's'} already tagged ${label}`, 'success')
      } else {
        const skipNote = skipped > 0 ? ` (${skipped} already tagged)` : ''
        showToast(`Updated ${updated} of ${total} trade${total === 1 ? '' : 's'} → ${label}${skipNote}`, 'success')
      }
    } catch (e) {
      showToast(`Backfill failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error')
    } finally {
      setBackfilling(false)
    }
  }

  const save = async (opts: { auto?: boolean } = {}) => {
    const isAuto = !!opts.auto
    if (savingRef.current) return // already saving — let the in-flight save complete; auto-save will retry next tick
    savingRef.current = true
    setSaving(true)
    setSaveStatus('saving')
    // Cancel any pending auto-save timer — we're saving now
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }

    try {
      let uploadedUrl = chartUrl

      if (pendingFile) {
        uploadedUrl = await uploadScreenshot(pendingFile)
        if (uploadedUrl) {
          setChartUrl(uploadedUrl)
          setPendingFile(null) // clear so we don't re-upload on next save
        } else {
          if (!isAuto) showToast('Screenshot upload failed — check storage bucket policies', 'error')
          setSaveStatus('error')
          return
        }
      }

      // Only update timing fields when on today's date — backfilled prep edits
      // shouldn't move the historical timestamps.
      const completedNow = isToday ? new Date().toISOString() : prepCompletedAt
      const res = await fetch(`/api/trading-days/${date}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketContext: context,
          prepNotes,
          chartScreenshotUrl: uploadedUrl,
          dayType,        // legacy single primary — kept in sync as dayTypes[0]
          dayTypes,       // multi-select array — written to trading_days.day_types
          aiAnalysis: aiAnalysis ?? {},
          ...(isToday && prepStartedAt ? { prepStartedAt } : {}),
          ...(isToday && completedNow ? { prepCompletedAt: completedNow } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown error' }))
        if (!isAuto) showToast(`Save failed: ${err.error}`, 'error')
        setSaveStatus('error')
      } else {
        const result = await res.json().catch(() => ({})) as { droppedColumns?: string[] }
        // If the saved chart URL changed, clean up the old blob from storage
        if (savedChartUrl && savedChartUrl !== uploadedUrl) {
          void deleteBlob(savedChartUrl)
        }
        setSavedChartUrl(uploadedUrl)
        if (isToday && completedNow) setPrepCompletedAt(completedNow)
        if (!isAuto) {
          if (result.droppedColumns && result.droppedColumns.length > 0) {
            showToast(
              `Saved, but ${result.droppedColumns.join(', ')} skipped — run schema migration in Supabase to enable.`,
              'error',
            )
          } else {
            showToast('Prep saved successfully', 'success')
          }
        }
        setIsDirty(false)
        setSaveStatus('saved')
        setLastSavedAt(Date.now())
        // Clear the local backup — server now has the truth
        try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
      }
    } catch (e) {
      if (!isAuto) showToast(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`, 'error')
      setSaveStatus('error')
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  // ---- Auto-save: restore from localStorage on mount if newer than server ----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    let raw: string | null = null
    try { raw = localStorage.getItem(STORAGE_KEY) } catch { return }
    if (!raw) return
    try {
      const backup = JSON.parse(raw) as {
        savedAt: string
        data: {
          context?: typeof context
          prepNotes?: PrepNotes
          dayType?: string
          dayTypes?: string[]
          chartUrl?: string | null
          aiAnalysis?: AiAnalysis | null
        }
      }
      const backupTime = new Date(backup.savedAt).getTime()
      const dbTime = initialDay?.updated_at ? new Date(initialDay.updated_at).getTime() : 0
      // Restore only if local is meaningfully newer (>2s skew tolerance)
      if (backupTime > dbTime + 2000) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (backup.data.context) setContext(backup.data.context)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (backup.data.prepNotes) setPrepNotes(backup.data.prepNotes)
        // Restore multi-select dayTypes from the newer schema; fall back to
        // the legacy single dayType for backups saved before this change.
        if (Array.isArray(backup.data.dayTypes)) {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setDayTypes(backup.data.dayTypes)
        } else if (typeof backup.data.dayType === 'string') {
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setDayTypes(backup.data.dayType ? [backup.data.dayType] : [])
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (backup.data.chartUrl !== undefined) setChartUrl(backup.data.chartUrl)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (backup.data.aiAnalysis !== undefined) setAiAnalysis(backup.data.aiAnalysis)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsDirty(true) // will trigger auto-save once mount finishes
        showToast(`Restored unsaved changes from ${formatDistanceToNowStrict(new Date(backup.savedAt))} ago`, 'success')
      }
    } catch {
      // corrupted backup — ignore, server data wins
    }
  }, [])

  // ---- Auto-save: debounced server save 3s after last change ----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isDirty || saving) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      void save({ auto: true })
    }, AUTO_SAVE_DELAY_MS)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [isDirty, context, prepNotes, dayType, dayTypes, chartUrl, aiAnalysis])

  const toBase64 = async (source: File | string): Promise<{ data: string; mediaType: string } | null> => {
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

  const analyze = async () => {
    setAnalyzing(true)
    try {
      // Image priority for the AI's Step-1 chart read:
      //   1. Newly-selected file (not yet uploaded) → user just pasted Sierra
      //   2. Already-saved Sierra screenshot URL → user pasted earlier
      //   3. LiveChart canvas snapshot → auto-fallback when no screenshot
      //      uploaded but the live chart is rendered (default view). Eliminates
      //      the "I forgot to paste" friction — AI still gets a chart image.
      // If all three miss, the analyze route runs text-only (no Step 1).
      let image: { data: string; mediaType: string } | null = null
      if (pendingFile) {
        image = await toBase64(pendingFile)
      } else if (chartUrl && !chartUrl.startsWith('blob:')) {
        image = await toBase64(chartUrl)
      } else if (chartView === 'live' && liveChartRef.current) {
        image = await liveChartRef.current.takeScreenshotPng()
      }

      const res = await fetch('/api/analyze-prep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prepNotes,
          marketContext: context,
          imageBase64: image?.data ?? null,
          imageMediaType: image?.mediaType ?? null,
        }),
      })

      let data: AiAnalysis | { error?: string } | null = null
      try {
        data = await res.json()
      } catch {
        const text = await res.text().catch(() => '')
        showToast(`Analyze failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`, 'error')
        return
      }

      if (!res.ok) {
        const msg = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : `${res.status} ${res.statusText}`
        showToast(`Analyze failed: ${msg}`, 'error')
        return
      }

      const analysis = data as AiAnalysis
      // Sanity check: the response should have at least summary or score
      if (!analysis || (analysis.summary == null && analysis.score == null)) {
        showToast('Analyze returned an empty result — Claude may not have produced valid JSON. Try again.', 'error')
        return
      }
      setAiAnalysis(analysis)
      // Copy the AI's viewer read into the editable Discord-card fields. Overwrites
      // on each analyze (that's the regenerate action); between analyzes, any manual
      // override the admin types sticks.
      if (analysis.day_stance || analysis.day_read) {
        setPrepNotes(prev => ({
          ...prev,
          ...(analysis.day_stance ? { day_stance: analysis.day_stance } : {}),
          ...(analysis.day_read ? { day_read: analysis.day_read } : {}),
        }))
      }
      showToast('Prep analysis ready', 'success')
    } catch (e) {
      showToast(`Analyze failed: ${e instanceof Error ? e.message : 'network or unknown error'}`, 'error')
    } finally {
      setAnalyzing(false)
    }
  }

  const extractContext = async () => {
    // Source the image either from a freshly-pasted file or, if absent,
    // from the already-saved screenshot URL.
    let fileToSend: File | Blob | null = pendingFile
    let filename = pendingFile?.name ?? 'chart.png'

    if (!fileToSend && chartUrl && !chartUrl.startsWith('blob:')) {
      try {
        const fetched = await fetch(chartUrl)
        if (!fetched.ok) {
          const hint = fetched.status === 404 || fetched.status === 400
            ? ' (file may have been deleted from storage — re-upload the chart)'
            : ''
          showToast(`Could not load saved chart: ${fetched.status} ${fetched.statusText}${hint}`, 'error')
          return
        }
        fileToSend = await fetched.blob()
        const urlTail = chartUrl.split('/').pop() ?? 'chart.png'
        filename = urlTail.split('?')[0]
      } catch (e) {
        showToast(`Could not load saved chart: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
        return
      }
    }

    if (!fileToSend) {
      showToast('No chart screenshot to read. Upload or paste one first.', 'error')
      return
    }

    setExtracting(true)
    try {
      const formData = new FormData()
      formData.append('file', fileToSend, filename)
      const res = await fetch('/api/extract-context', { method: 'POST', body: formData })

      let data: Record<string, unknown> = {}
      try {
        data = await res.json()
      } catch {
        const text = await res.text().catch(() => '')
        showToast(`Auto-fill failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`, 'error')
        return
      }

      if (!res.ok) {
        const msg = typeof data.error === 'string' ? data.error : `${res.status} ${res.statusText}`
        showToast(`Auto-fill failed: ${msg}`, 'error')
        return
      }

      // Merge extracted values — only overwrite fields that came back non-null/undefined
      const merged = { ...context } as Record<string, unknown>
      let filled = 0
      for (const [key, val] of Object.entries(data)) {
        if (val !== null && val !== undefined) {
          merged[key] = val
          filled++
        }
      }
      if (filled === 0) {
        showToast('Auto-fill returned no values — Claude could not read this chart.', 'error')
        return
      }
      // Derive GBX % of ADR from merged values if not already set
      const onh = merged.onh as number | undefined
      const onl = merged.onl as number | undefined
      const adr = merged.adr as number | undefined
      if (onh != null && onl != null && adr != null && adr > 0) {
        merged.gbx_pct_adr = parseFloat(((onh - onl) / adr * 100).toFixed(2))
      }
      setContext(merged)
      showToast(`Auto-filled ${filled} value${filled === 1 ? '' : 's'} from chart`, 'success')
    } catch (e) {
      showToast(`Auto-fill failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error')
    } finally {
      setExtracting(false)
    }
  }

  const handleScreenshotChange = useCallback((url: string | null, file?: File) => {
    setChartUrl(url)
    setPendingFile(file ?? null)
  }, [])

  // ---- Spell check ----
  const collectSpellCheckTexts = (): { texts: Record<string, string>; labels: Record<string, string> } => {
    const texts: Record<string, string> = {}
    const labels: Record<string, string> = {}
    const add = (key: string, val: string | null | undefined, label: string) => {
      if (val && val.trim().length > 0) {
        texts[key] = val
        labels[key] = label
      }
    }
    add('prep.bias_notes', prepNotes.bias_notes, 'Bias Notes')
    add('prep.setups_areas', prepNotes.setups_areas, 'Setups / Areas of Interest')
    add('prep.mood', prepNotes.mood, 'Mood')
    add('prep.market_clarity', prepNotes.market_clarity, 'Market Clarity')
    add('prep.volume_profile_notes', prepNotes.volume_profile_notes, 'Volume Profile Notes')
    add('prep.ib_behaviour', prepNotes.ib_behaviour, 'IB Behaviour')

    for (const p of prepNotes.trade_plans ?? []) {
      const planLabel = p.setup_name ? `Plan: ${p.setup_name}` : `Plan ${p.id.slice(0, 4)}`
      add(`plan.${p.id}.setup_name`, p.setup_name, `${planLabel} — Setup Name`)
      add(`plan.${p.id}.invalidation`, p.invalidation, `${planLabel} — Invalidation`)
      add(`plan.${p.id}.targets`, p.targets, `${planLabel} — Targets`)
      add(`plan.${p.id}.scary_factors`, p.scary_factors, `${planLabel} — Scary Factors`)
      ;(p.quality_reasons ?? []).forEach((r, i) => {
        add(`plan.${p.id}.quality_reasons.${i}`, r, `${planLabel} — Quality Reason ${i + 1}`)
      })
    }
    return { texts, labels }
  }

  const runSpellCheck = async () => {
    const { texts, labels } = collectSpellCheckTexts()
    if (Object.keys(texts).length === 0) {
      showToast('Nothing to check — fill in some prep notes first', 'error')
      return
    }
    setSpellCheckLabels(labels)
    setSpellCheckOpen(true)
    setSpellCheckLoading(true)
    setSpellCheckResults([])
    try {
      const res = await fetch('/api/spell-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      })
      const data = await res.json() as { corrections?: SpellCheckCorrection[]; error?: string }
      if (!res.ok) {
        showToast(`Spell check failed: ${data.error ?? 'unknown'}`, 'error')
        setSpellCheckOpen(false)
        return
      }
      setSpellCheckResults(data.corrections ?? [])
    } catch (e) {
      showToast(`Spell check error: ${e instanceof Error ? e.message : 'unknown'}`, 'error')
      setSpellCheckOpen(false)
    } finally {
      setSpellCheckLoading(false)
    }
  }

  const applySpellCheck = (toApply: SpellCheckCorrection[]) => {
    if (toApply.length === 0) {
      setSpellCheckOpen(false)
      return
    }
    let nextPrep: PrepNotes = { ...prepNotes }
    const nextPlans: TradePlan[] = [...(prepNotes.trade_plans ?? [])]
    let plansChanged = false

    for (const c of toApply) {
      const parts = c.key.split('.')
      if (parts[0] === 'prep') {
        const field = parts[1] as keyof PrepNotes
        ;(nextPrep as Record<string, unknown>)[field] = c.corrected
      } else if (parts[0] === 'plan') {
        const planId = parts[1]
        const idx = nextPlans.findIndex(p => p.id === planId)
        if (idx === -1) continue
        const plan: TradePlan = { ...nextPlans[idx] }
        if (parts[2] === 'quality_reasons' && parts[3] != null) {
          const qr = [...(plan.quality_reasons ?? [])]
          qr[Number(parts[3])] = c.corrected
          plan.quality_reasons = qr
        } else {
          const field = parts[2] as keyof TradePlan
          ;(plan as unknown as Record<string, unknown>)[field] = c.corrected
        }
        nextPlans[idx] = plan
        plansChanged = true
      }
    }
    if (plansChanged) nextPrep = { ...nextPrep, trade_plans: nextPlans }
    setPrepNotes(nextPrep)
    setSpellCheckOpen(false)
    showToast(`Applied ${toApply.length} fix${toApply.length === 1 ? '' : 'es'}`, 'success')
  }

  const pro = mode === 'pro'
  // Beginner Highlights day-read one-liner (null until the IB prints). Detailed
  // Tape gets the same signal as the IB-vs-ATR row in the Market Context ledger.
  const ibHeadline = ibDayTypeHeadline(ibDayType)

  // Step to the previous/next calendar day's prep. Saves the current day first
  // (the per-day localStorage draft is the fallback), then navigates — the
  // reliable way to browse prior preps, independent of the fiddly native date
  // input. Noon-UTC anchor dodges DST edges.
  const goToDay = async (deltaDays: number) => {
    const dt = new Date(`${date}T12:00:00Z`)
    dt.setUTCDate(dt.getUTCDate() + deltaDays)
    const next = dt.toISOString().slice(0, 10)
    if (next === date) return
    if (isDirty) { try { await save({ auto: true }) } catch { /* draft preserves edits */ } }
    router.push(`/prep/${next}`)
  }
  // Per-day-type consequence — turns the day-type taxonomy from a description
  // into something with a personal stake. Null until the trader has enough
  // scored trades on that day type to say anything honest.
  const consequence = dayTypeConsequence(historyTrades, dayTypes)

  // "FRI JUL 25 · RTH · NQ"
  const eyebrow = [
    format(new Date(date + 'T12:00:00'), 'EEE MMM d').toUpperCase(),
    session.toUpperCase(),
    (context.symbol ?? 'NQ').toUpperCase(),
  ].join(' · ')

  const nothingToAnalyze =
    !chartUrl &&
    !pendingFile &&
    !prepNotes.bias &&
    !prepNotes.bias_notes &&
    !prepNotes.setups_areas &&
    !prepNotes.ib_behaviour &&
    !prepNotes.volume_profile_shape &&
    !prepNotes.volume_profile_notes &&
    !prepNotes.mood &&
    !prepNotes.market_clarity &&
    !prepNotes.trade_plans?.length

  const analyzeButton = (
    <GhostButton onClick={analyze} disabled={analyzing || nothingToAnalyze}>
      {analyzing && <Loader2 className="w-3 h-3 animate-spin" />}
      {analyzing ? 'Reading…' : aiAnalysis ? 'Run read again' : 'Run the read'}
    </GhostButton>
  )

  const chartControl = (
    <>
      {chartView === 'live' && LOCAL_FEATURES_ENABLED && (
        <BarWatcher activeDate={date} onRefresh={() => setBarsVersion(v => v + 1)} />
      )}
      {chartView === 'screenshot' && (pendingFile || chartUrl) && (
        <GhostButton onClick={extractContext} disabled={extracting}>
          {extracting && <Loader2 className="w-3 h-3 animate-spin" />}
          {extracting ? 'Reading chart…' : 'Auto-fill from chart'}
        </GhostButton>
      )}
      <Segmented
        value={chartView}
        onChange={setChartView}
        options={[{ value: 'screenshot', label: 'Screenshot' }, { value: 'live', label: 'Live chart' }]}
      />
    </>
  )

  return (
    <div className="mx-auto w-full max-w-[1080px]">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <SpellCheckModal
        open={spellCheckOpen}
        loading={spellCheckLoading}
        corrections={spellCheckResults}
        labels={spellCheckLabels}
        onApply={applySpellCheck}
        onClose={() => setSpellCheckOpen(false)}
      />

      {/* Utility bar — day switcher + save. Deliberately quiet: the old "Daily
          Prep" h1 is gone because the hero headline IS the page's title, and a
          generic screen-name heading was one of the AI-dashboard tells. */}
      <div data-tour="prep-header" className="flex flex-wrap items-center justify-between gap-3 pb-5">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goToDay(-1)}
              title="Previous day"
              aria-label="Previous day"
              className="text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-600 rounded px-2 py-1 text-sm leading-none transition-colors"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => goToDay(1)}
              title="Next day"
              aria-label="Next day"
              className="text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-600 rounded px-2 py-1 text-sm leading-none transition-colors"
            >
              ›
            </button>
          </div>
          <input
            type="date"
            value={date}
            onChange={async e => {
              const next = e.target.value
              if (!next || next === date) return
              // Save the current day, THEN switch. The old confirm() gate could
              // stick permanently: a failed/lagging auto-save leaves isDirty
              // true, and once the browser suppresses the repeated "unsaved
              // changes" dialog, confirm() returns false → every day-switch was
              // silently blocked. Saving first (with the per-day localStorage
              // draft as a fallback) makes switching always work and never lose
              // edits.
              if (isDirty) {
                try { await save({ auto: true }) } catch { /* draft preserves edits */ }
              }
              router.push(`/prep/${next}`)
            }}
            className="bg-gray-950 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 font-mono focus:outline-none focus:border-blue-600"
            title="Switch to a different day's prep"
          />
          <PrepTiming startedAt={prepStartedAt} completedAt={prepCompletedAt} isToday={isToday} />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <SaveStatus saving={saving} isDirty={isDirty} saveStatus={saveStatus} lastSavedAt={lastSavedAt} />
          <GhostButton
            onClick={runSpellCheck}
            disabled={spellCheckLoading}
            title="Run AI spell + grammar check on all prep notes"
          >
            {spellCheckLoading && <Loader2 className="w-3 h-3 animate-spin" />}
            Spell check
          </GhostButton>
          <button
            onClick={() => save()}
            disabled={saving}
            className={`text-xs font-semibold px-3.5 py-1.5 rounded border transition-colors disabled:opacity-60 ${
              isDirty
                ? 'border-yellow-700 text-yellow-400 bg-yellow-400/[0.08] hover:bg-yellow-400/[0.14]'
                : 'border-gray-700 text-gray-400 hover:text-gray-200'
            }`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Red-folder economic news for the day. */}
      <HighImpactNews events={highImpactNews} />

      {/* ── The read + the trader's stance ── */}
      <PrepHero
        context={context as Partial<MarketContext>}
        atrBaseline={atrBaseline}
        prepNotes={prepNotes}
        onPrepNotesChange={setPrepNotes}
        eyebrow={eyebrow}
        isToday={isToday}
        maxConditions={pro ? 5 : 3}
        beginner={!pro}
      />

      {/* ── The commitment: Review diagnoses, Prep prescribes ── */}
      <PrepBridge
        carryover={carryover}
        prepNotes={prepNotes}
        onPrepNotesChange={setPrepNotes}
        canTrack={isToday}
      />

      {/* Session — Detailed Tape only. GBX/overnight planning is advanced; it
          re-anchors the chart's IB + reference levels. */}
      {pro && (
        <Section title="Session" sub="drives the chart’s levels and initial balance">
          <SessionPicker value={session} onChange={changeSession} levels={session !== 'rth' ? liveLevels : null} />
        </Section>
      )}

      {/* Chart — UNCHANGED by the redesign, by explicit founder instruction.
          Only the container around it moved from a card to a section. */}
      <Section title="Chart" control={chartControl} className="[&_h2]:sr-only sm:[&_h2]:not-sr-only">
        <div data-tour="prep-chart">
          {chartView === 'screenshot' ? (
            <ScreenshotUpload value={chartUrl} onChange={handleScreenshotChange} label="" />
          ) : (
            <LiveChart
              ref={liveChartRef}
              date={date}
              symbol={activeSymbol}
              symbolOptions={symbolOptions}
              onSymbolChange={onSymbolChange}
              trades={chartTrades}
              refreshKey={barsVersion}
              onLevels={handleLevels}
              session={session}
            />
          )}
        </div>
      </Section>

      {/* Your read (beginner/Highlights only): kept right under the chart for the
          quick-read flow — beginner has no market-annotation sections below it to
          form a read against. Detailed Tape moves this to the very bottom (see
          the matching block after TapeScore read), so the read is formed AFTER
          annotating the chart + market, not before. */}
      {!pro && (
        <Section title="Your read" sub="kept short on purpose">
          <PrepNotesForm
            part="read"
            value={prepNotes}
            onChange={setPrepNotes}
            ibh={context.ibh as number | null}
            ibl={context.ibl as number | null}
            ibSize={context.ib_size as number | null}
            showAdvanced={false}
            beginner
          />
        </Section>
      )}

      {/* Highlights stops here: one thing to watch, one to keep. Day-type
          classification, the full conditions ledger and the long-form AI read
          all live in Detailed Tape. */}
      {!pro && (
        <Section title="Watch / Keep" control={analyzeButton}>
          {/* Beginner day-read: one plain-language line calling out today's IB
              character (Detailed Tape shows this in the Market Context ledger). */}
          {ibHeadline && (
            <p className="text-sm text-gray-300 leading-normal max-w-[64ch] mb-3 pb-3 border-b border-gray-800">
              <span className="text-gray-500">Day read: </span>{ibHeadline}
            </p>
          )}
          <WatchKeep analysis={aiAnalysis} />
        </Section>
      )}

      {pro && (<>
        {/* Day type — chips sourced from trade_tags so prep + intraday stay in
            sync. No invented axes: the library is the trader's own. */}
        <Section
          title="Day type"
          control={dayTypes.length > 0 ? (
            <GhostButton
              onClick={backfillDayType}
              disabled={backfilling}
              title={`Set day_type tag = [${dayTypes.join(', ')}] on every existing trade for ${date}`}
            >
              {backfilling && <Loader2 className="w-3 h-3 animate-spin" />}
              {backfilling ? 'Applying…' : 'Apply to today’s trades'}
            </GhostButton>
          ) : undefined}
        >
          {dayTypeOptions.length === 0 ? (
            <p className="text-xs text-gray-500">
              No day types in the library yet. Add some from <span className="font-mono">/settings/tags</span>.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {dayTypeOptions.map(t => (
                <Chip key={t} selected={dayTypes.includes(t)} onClick={() => toggleDayType(t)}>
                  {t}
                </Chip>
              ))}
            </div>
          )}

          <DayTypePredictor
            date={date}
            currentDayTypes={dayTypes}
            ibRead={ibDayTypeAiRead(ibDayType)}
            // Multi-axis predictor returns an array — dedupe-append to the
            // multi-select so structural + regime + flags all land in one click.
            onAccept={labels => setDayTypes(prev => {
              const next = [...prev]
              for (const l of labels) if (!next.includes(l)) next.push(l)
              return next
            })}
          />

          {consequence && (
            <div className="mt-4 pt-3.5 border-t border-gray-800 max-w-[66ch]">
              <span className="block text-[11px] tracking-wide uppercase text-gray-500 mb-1.5">
                Why this matters for you
              </span>
              <p className="text-sm text-gray-100 leading-normal">
                On <b className="font-semibold">{consequence.label}</b> days you average{' '}
                <b className={consequence.avgR >= 0 ? 'text-green-400 font-bold tabular-nums' : 'text-red-400 font-bold tabular-nums'}>
                  {formatR(consequence.avgR)} / trade
                </b>{' '}
                across {consequence.n} trades.
              </p>
            </div>
          )}
        </Section>

        {/* Market context as a ledger, not a form — verdicts lead, raw numbers
            are demoted, and editing sits behind a disclosure because nearly
            every value auto-fills from the bar feed. */}
        <Section title="Market context" sub="most values auto-fill — read the verdicts, edit the rest">
          <PrepLedger
            context={context as Partial<MarketContext>}
            atrBaseline={atrBaseline}
            drAdrAuto={drAdrAuto}
            ibDayType={ibDayType}
          />
          <details className="mt-3 group">
            <summary className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer inline-block list-none marker:content-none">
              <span className="group-open:hidden">Edit values</span>
              <span className="hidden group-open:inline">Hide editor</span>
            </summary>
            <div className="mt-4 pt-4 border-t border-gray-800">
              <MarketContextForm value={context} onChange={setContext} />
            </div>
          </details>
        </Section>

        {/* Morning conditions — where today sits vs the trader's OWN history.
            Un-gated in Pt 14. It was admin-only because condition_lookup was
            once a SHARED table, so showing it would have leaked the owner's
            numbers to every user; the same-day 20260703 migration made it
            per-user (PK (user_id, condition_id) + owner RLS, rebuilt nightly
            for every user with history) and the gate was simply never lifted.
            Sample-size honesty is enforced upstream: buckets under n>=10 /
            5 sessions come back INSUFFICIENT_DATA, and the panel suppresses
            stats below MIN_SAMPLE rather than showing a confident number off
            six trades.

            dr_adr is reactive: compute from live context first so screenshot
            re-extraction updates it immediately; drAdrAuto is the fallback. */}
        <Section title="Morning conditions" sub="where today sits vs your history">
          <ConditionFilterPanel
            date={date}
            beginner={!pro}
            marketContext={{
              rvol: context.rvol ?? null,
              ib_vs_10d_avg: context.ib_vs_10d_avg ?? null,
              atr_1m: context.atr_1m ?? null,
              dr_adr:
                context.day_range != null && context.adr != null && context.adr > 0
                  ? Math.round((context.day_range / context.adr) * 100) / 100
                  : drAdrAuto,
            }}
          />
        </Section>

        {/* The owner's methodology fields, dropped well below the read. */}
        {isAdmin && (
          <Section title="Prep notes — detailed" sub="IB timing · volume profile · HTF MGI">
            <PrepNotesForm
              part="advanced"
              value={prepNotes}
              onChange={setPrepNotes}
              ibh={context.ibh as number | null}
              ibl={context.ibl as number | null}
              ibSize={context.ib_size as number | null}
              showAdvanced
              beginner={false}
            />
          </Section>
        )}

        <Section title="Trade plans" sub="your playbook — TapeScore names the gap, not a score">
          <TradePlansSection
            plans={prepNotes.trade_plans ?? []}
            onChange={plans => setPrepNotes({ ...prepNotes, trade_plans: plans })}
            planAssessments={(aiAnalysis as AiAnalysis | null)?.plan_assessments as PlanAssessment[] | undefined}
          />
        </Section>

        <Section title="TapeScore read" sub="plain read · yours to override" control={analyzeButton}>
          <PrepAiRead analysis={aiAnalysis} />
        </Section>

        {/* Your read — LAST in Detailed Tape on purpose: you form your bias,
            observations and mood AFTER annotating the chart, day type and market
            context above, not before. */}
        <Section title="Your read" sub="your call, after everything above">
          <PrepNotesForm
            part="read"
            value={prepNotes}
            onChange={setPrepNotes}
            ibh={context.ibh as number | null}
            ibl={context.ibl as number | null}
            ibSize={context.ib_size as number | null}
            showAdvanced={isAdmin}
            beginner={false}
          />
        </Section>
      </>)}

      {/* Discord prep-share card — the owner's personal community workflow
          (generates a prep-summary PNG to post to Discord). Admin-gated so it's
          available on the cloud site for the owner, hidden for public users. */}
      {isAdmin && (
        <Section title="Discord card" sub="your community post for this prep">
          {/* Viewer-read + roadmap inputs sit directly above the preview they
              feed, at the very bottom of the prep (moved out of Prep Notes). */}
          <DiscordCardInputs value={prepNotes} onChange={setPrepNotes} />
          <DiscordDashboard
            date={date}
            marketContext={context as Partial<MarketContext>}
            prepNotes={prepNotes}
            symbol={context.symbol ?? 'NQ'}
          />
        </Section>
      )}
    </div>
  )
}

function SaveStatus({
  saving,
  isDirty,
  saveStatus,
  lastSavedAt,
}: {
  saving: boolean
  isDirty: boolean
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  lastSavedAt: number | null
}) {
  // Re-render every 15s so the "Saved Xs ago" relative time stays fresh.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  // Hydration-safe relative time: SSR renders the page at time T, the client
  // hydrates a second or two later, and formatDistanceToNowStrict returns a
  // different string for the same lastSavedAt — React aborts hydration with a
  // mismatch. Gate the relative-time render on a `mounted` flag so the server
  // outputs a stable placeholder and the client computes the real value only
  // after mount.
  const [mounted, setMounted] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount flag for hydration-safe render
  useEffect(() => { setMounted(true) }, [])

  if (saving) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-blue-400 font-medium">
        <Loader2 className="w-3 h-3 animate-spin" />
        Saving…
      </span>
    )
  }
  if (saveStatus === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-red-400 font-medium" title="Will retry on next change. Click Save to retry now.">
        <AlertTriangle className="w-3 h-3" />
        Save failed — backed up locally
      </span>
    )
  }
  if (isDirty) {
    return (
      <span className="text-xs text-yellow-400 font-medium" title="Auto-save in 3s">
        Unsaved
      </span>
    )
  }
  if (lastSavedAt) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-500 font-medium" title={new Date(lastSavedAt).toLocaleString()}>
        <Check className="w-3 h-3 text-green-500" />
        {mounted ? `Saved ${formatDistanceToNowStrict(new Date(lastSavedAt))} ago` : 'Saved'}
      </span>
    )
  }
  return null
}

function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000))
  if (totalMin < 1) return '< 1 min'
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function PrepTiming({
  startedAt,
  completedAt,
  isToday,
}: {
  startedAt: string | null
  completedAt: string | null
  isToday: boolean
}) {
  // Tick every 30 seconds so the live duration display stays current.
  // Driving the displayed `now` from React state (rather than calling Date.now()
  // inline) keeps the render function pure.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // Hydration safety. Everything below formats an absolute instant into WALL
  // CLOCK time, which depends on the runtime's timezone: the server renders in
  // UTC and the browser in the trader's zone, so "Started 3:50 PM" (server) met
  // "Started 7:50 AM" (client) and React threw a text-mismatch on every load.
  // The elapsed duration has the same problem against the clock. Render nothing
  // time-derived until after mount, when only the browser's zone is in play.
  const [mounted, setMounted] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount flag for hydration-safe render
  useEffect(() => { setMounted(true) }, [])

  if (!startedAt) {
    if (!isToday) return null
    return (
      <p className="text-xs text-gray-600 italic">
        Edit any field to start the prep timer
      </p>
    )
  }

  const start = new Date(startedAt)
  // For today's date, duration is "now - start" (live ticking).
  // For past dates, duration is "completedAt - startedAt" (final value).
  const endMs = isToday
    ? now
    : completedAt
      ? new Date(completedAt).getTime()
      : start.getTime()
  const duration = formatDuration(endMs - start.getTime())

  return (
    <p
      className="text-xs text-gray-500 font-mono"
      title={mounted
        ? `Started ${start.toLocaleString()}${completedAt ? ` · last edit ${new Date(completedAt).toLocaleString()}` : ''}`
        : undefined}
    >
      {mounted
        ? <>Started {format(start, 'h:mm a')} · {duration}{!isToday && ' (final)'}</>
        : 'Prep timer running'}
    </p>
  )
}
