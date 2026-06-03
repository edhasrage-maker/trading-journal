'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { Save, Loader2, Sparkles, SpellCheck, Check, AlertTriangle, Layers } from 'lucide-react'
import ScreenshotUpload from './ScreenshotUpload'
import ConditionFilterPanel from '@/components/condition/ConditionFilterPanel'
import MarketContextForm from './MarketContextForm'
import PrepNotesForm from './PrepNotesForm'
import AiAnalysisCard from './AiAnalysisCard'
import DiscordDashboard from './DiscordDashboard'
import TradePlansSection from './TradePlansSection'
import SpellCheckModal from './SpellCheckModal'
import DayTypePredictor from './DayTypePredictor'
import { deleteBlob } from '@/lib/storage'
import type { TradingDay, MarketContext, PrepNotes, AiAnalysis, PlanAssessment, TradePlan } from '@/lib/supabase/types'
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
}

export default function PrepClient({ date, initialDay, initialContext, dayTypeOptions, drAdrAuto }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const isFirstRender = useRef(true)
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
      gbx_pct_adr: initialContext.gbx_pct_adr ?? undefined,
      atr_1m: initialContext.atr_1m ?? undefined,
      atr_flag: initialContext.atr_flag ?? undefined,
      price_in_pd_range: initialContext.price_in_pd_range ?? undefined,
      price_in_gbx_range: initialContext.price_in_gbx_range ?? undefined,
    } : { symbol: 'NQ' }
  )
  const [prepNotes, setPrepNotes] = useState<PrepNotes>(initialDay?.prep_notes_json ?? {})
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysis | null>(
    initialDay?.ai_analysis_json && Object.keys(initialDay.ai_analysis_json).length > 0
      ? initialDay.ai_analysis_json as AiAnalysis
      : null
  )

  // Prep timing: first-edit start time + last-edit completion time.
  // Used to track "time at desk" vs subsequent PnL.
  const [prepStartedAt, setPrepStartedAt] = useState<string | null>(initialDay?.prep_started_at ?? null)
  const [prepCompletedAt, setPrepCompletedAt] = useState<string | null>(initialDay?.prep_completed_at ?? null)
  const todayStr = format(new Date(), 'yyyy-MM-dd')
  const isToday = date === todayStr

  // Mark dirty on any field change (skip the very first render).
  // Also captures prep_started_at on the FIRST edit of today's prep.
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
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
      let image: { data: string; mediaType: string } | null = null
      if (pendingFile) {
        image = await toBase64(pendingFile)
      } else if (chartUrl && !chartUrl.startsWith('blob:')) {
        image = await toBase64(chartUrl)
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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all
          ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.type === 'success' ? '✓' : '✕'} {toast.msg}
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Daily Prep</h1>
          <div className="flex items-center gap-3 mt-1">
            <input
              type="date"
              value={date}
              onChange={e => {
                const next = e.target.value
                if (next && next !== date) {
                  if (isDirty && !confirm('You have unsaved changes. Switch days anyway?')) return
                  router.push(`/prep/${next}`)
                }
              }}
              className="bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-md px-2 py-1 font-mono focus:outline-none focus:border-blue-500"
              title="Switch to a different day's prep"
            />
            <span className="text-gray-400 text-sm">{format(new Date(date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')}</span>
          </div>
          <PrepTiming startedAt={prepStartedAt} completedAt={prepCompletedAt} isToday={isToday} />
        </div>
        <div className="flex items-center gap-3">
          <SaveStatus
            saving={saving}
            isDirty={isDirty}
            saveStatus={saveStatus}
            lastSavedAt={lastSavedAt}
          />
          <button
            onClick={runSpellCheck}
            disabled={spellCheckLoading}
            className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
            title="Run AI spell + grammar check on all prep notes"
          >
            {spellCheckLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <SpellCheck className="w-4 h-4" />}
            Spell Check
          </button>
          <button
            onClick={() => save()}
            disabled={saving}
            className={`flex items-center gap-2 font-medium px-4 py-2 rounded-lg text-sm transition-colors text-white disabled:opacity-60 ${
              isDirty ? 'bg-yellow-600 hover:bg-yellow-500' : 'bg-blue-600 hover:bg-blue-500'
            }`}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* Spell check modal */}
      <SpellCheckModal
        open={spellCheckOpen}
        loading={spellCheckLoading}
        corrections={spellCheckResults}
        labels={spellCheckLabels}
        onApply={applySpellCheck}
        onClose={() => setSpellCheckOpen(false)}
      />

      {/* Chart Screenshot */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <ScreenshotUpload
          value={chartUrl}
          onChange={handleScreenshotChange}
          label="Chart Screenshot (with MGI levels marked)"
        />
        {(pendingFile || chartUrl) && (
          <button
            onClick={extractContext}
            disabled={extracting}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            {extracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {extracting ? 'Reading chart...' : 'Auto-fill from chart'}
          </button>
        )}
      </div>

      {/* Day Type — chips sourced from trade_tags.day_type so prep + intraday
          stay in sync. Falls back to a hint when the library is empty. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <label className="block text-sm font-medium text-gray-300 mb-2">Day Type</label>
        {dayTypeOptions.length === 0 ? (
          <p className="text-xs text-gray-500">
            No day types in the library yet. Add some from <span className="font-mono">/settings/tags</span>.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {dayTypeOptions.map(t => {
              const isSelected = dayTypes.includes(t)
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleDayType(t)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors border ${
                    isSelected
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {t}
                </button>
              )
            })}
          </div>
        )}
        {dayTypes.length > 0 && (
          <button
            type="button"
            onClick={backfillDayType}
            disabled={backfilling}
            className="mt-3 flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 disabled:text-gray-600 disabled:cursor-not-allowed transition-colors"
            title={`Set day_type tag = [${dayTypes.join(', ')}] on every existing trade for ${date}`}
          >
            {backfilling
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Layers className="w-3 h-3" />}
            {backfilling
              ? 'Applying…'
              : `Apply ${dayTypes.length === 1 ? `"${dayTypes[0]}"` : `${dayTypes.length} day types`} to existing trades for this day`}
          </button>
        )}
        <DayTypePredictor
          date={date}
          currentDayType={dayType}
          // The predictor still returns a single label — append it (or replace
          // the existing one) to the multi-select rather than overwriting all.
          onAccept={label => setDayTypes(prev => prev.includes(label) ? prev : [...prev, label])}
        />
      </div>

      {/* Condition Filter (Morning Conditions) */}
      <ConditionFilterPanel
        date={date}
        marketContext={{
          rvol: context.rvol ?? null,
          ib_vs_10d_avg: context.ib_vs_10d_avg ?? null,
          atr_1m: context.atr_1m ?? null,
          dr_adr: drAdrAuto,
        }}
      />

      {/* Market Context */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-4">Market Context</h2>
        <MarketContextForm value={context} onChange={setContext} />
      </div>

      {/* Prep Notes */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-4">Prep Notes</h2>
        <PrepNotesForm
          value={prepNotes}
          onChange={setPrepNotes}
          ibh={context.ibh as number | null}
          ibl={context.ibl as number | null}
          ibSize={context.ib_size as number | null}
        />
      </div>

      {/* Trade Plans */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-4">Trade Plans / Setups</h2>
        <TradePlansSection
          plans={prepNotes.trade_plans ?? []}
          onChange={plans => setPrepNotes({ ...prepNotes, trade_plans: plans })}
          planAssessments={(aiAnalysis as AiAnalysis | null)?.plan_assessments as PlanAssessment[] | undefined}
        />
      </div>

      {/* Prep Analysis */}
      <AiAnalysisCard
        analysis={aiAnalysis as Parameters<typeof AiAnalysisCard>[0]['analysis']}
        loading={analyzing}
        onAnalyze={analyze}
        disabled={
          // Disable only when there's truly nothing to analyze:
          // no chart screenshot AND no prep text AND no trade plans
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
        }
      />

      {/* Discord Dashboard */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <DiscordDashboard
          date={date}
          marketContext={context as Partial<MarketContext>}
          prepNotes={prepNotes}
          symbol={context.symbol ?? 'NQ'}
        />
      </div>
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
    const ago = formatDistanceToNowStrict(new Date(lastSavedAt))
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-500 font-medium" title={new Date(lastSavedAt).toLocaleString()}>
        <Check className="w-3 h-3 text-green-500" />
        Saved {ago} ago
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

  if (!startedAt) {
    if (!isToday) return null
    return (
      <p className="text-xs text-gray-600 mt-1 italic">
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
      className="text-xs text-gray-500 mt-1 font-mono"
      title={`Started ${start.toLocaleString()}${completedAt ? ` · last edit ${new Date(completedAt).toLocaleString()}` : ''}`}
    >
      <span className="text-gray-600">⏱</span> Started {format(start, 'h:mm a')} · {duration}
      {!isToday && ' (final)'}
    </p>
  )
}
