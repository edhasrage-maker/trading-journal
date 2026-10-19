'use client'

/**
 * Replay Review workspace (was Deep Dive): one trade, exactly as it looked at
 * the fill, with the week's trades down the left.
 *
 * Everything here renders from /api/deep-dive/trade, which cuts the data on the
 * server; in blind mode nothing after the fill second ever reaches the browser.
 * The week list carries entry-time facts only; results come from
 * /api/deep-dive/results, asked for the first time the trader leaves Blind.
 * The same routes serve the local build (Sierra files) and the hosted site (the
 * published tick tape), so this component doesn't know or care which it is on.
 *
 * Layout: left column = the Chart Settings switch (on opens every option right
 * there) above the week's trades. Then one title bar per chart — Candles,
 * Bubbles, Footprint — each with its own controls and a full-size button, and
 * dividers to drag. Bubbles and footprint start ON only when the trader's
 * profile uses order flow. On a phone: one chart at a time, the trades and
 * Chart Settings as sheets.
 *
 * Play forward ("Play from the fill"): the trader's choice to leave Blind.
 * The Full review payload is fetched then and revealed up to a moving cursor
 * on this side (src/lib/orderflow/replay.ts) — a bar once its minute closed, a
 * bubble once it printed, an exit once it filled. The result (header, week
 * list, Your trade) stays hidden until the replay reaches the last exit.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'
import type { DeepDivePayload } from '@/lib/orderflow/server/deep-dive-payload'
import type { DeepDiveSnapshot } from '@/lib/orderflow/server/snapshot'
import type { OfRoot } from '@/lib/orderflow/ticks'
import { barsDone, bubblesDone, cutBars, cutBubbles } from '@/lib/orderflow/replay'
import type { TradeVerdict } from '@/lib/supabase/types'
import type { ReplayResult } from '@/app/api/deep-dive/results/route'
import { toBars1m, vapPerBar, buildAgg, atr1m5m, htfToBars, SESSION_4H_OFFSET, type AggBar, type VapRow } from '@/lib/orderflow/bars'
import { volumeProfile, profileWindow } from '@/lib/orderflow/profile'
import { vwap24h, vwapRth, emaOnTf } from '@/lib/orderflow/indicators'
import { TimeChartController, fmtDT, fmtTs, type TimeChartOpts } from './time-chart'
import { BubbleChartController } from './bubble-chart'
import Footprint1m from './Footprint1m'
import { BracketBox, LevelsNearEntry, type NearLevel } from './EntryPanels'
import { PALETTE, withCandleColors, withFpColors } from './palette'
import { useTheme } from '@/components/ThemeToggle'
import { useFootprintColors } from './useFootprintColors'
import { DEFAULTS, SETTINGS_KEY, TFS, isHtf, loadSettings, tfLabel, type ReplaySettings, type Tf } from './replay-settings'
import ChartSettingsPanel, { ChartSettingsToggle, SettingsIconButton } from './ChartSettings'
import WeekTrades, { fmtUsd, rootOf, type WeekNav, type WeekTrade } from './WeekTrades'
import CallBar from './CallBar'
import YourTrade from './YourTrade'
import ReplayControls, { PlayFromFillButton, PlayFromFillPill, type Speed } from './ReplayControls'
import type { ReplayDetails } from '@/app/api/deep-dive/details/route'

export type PickerTrade = WeekTrade
type Payload = DeepDivePayload & { uses_order_flow: boolean }
type Call = TradeVerdict['call']
/** 'yours' = the phone's "Your trade" tab (Full review only). */
type PaneKey = 'candles' | 'bubbles' | 'fp' | 'yours'
const TAB_LABEL: Record<PaneKey, string> = { candles: 'Candles', bubbles: 'Bubbles', fp: 'Footprint', yours: 'Your trade' }

const PHONE_Q = '(max-width: 767px)'
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE_Q)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const usePhone = () => useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_Q).matches, () => false)

const ptTime = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso))
const fmtR = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}R`
const fmtHeld = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`)
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))

const btn = (on: boolean) =>
  `px-[7px] py-[2px] text-[12px] rounded-[3px] transition-colors ${on ? 'bg-blue-500/15 text-gray-100 shadow-[inset_0_-2px_0_var(--color-blue-500)]' : 'text-gray-400 hover:text-gray-100'}`
const iconBtn = 'inline-flex items-center justify-center w-[26px] h-[26px] border border-gray-800 rounded-[4px] text-gray-400 hover:text-gray-100 disabled:opacity-40 disabled:hover:text-gray-400'

const Chevron = ({ left, size = 12 }: { left?: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d={left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} /></svg>
)
const MaxIcon = ({ restore }: { restore?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
    <path d={restore ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} />
  </svg>
)

/** One chart's frame: a title bar with its own controls, then the chart. */
function Pane({ title, sub, controls, maxed, onMax, children, style, label }: {
  title: string; sub?: string; controls?: React.ReactNode; maxed: boolean; onMax: () => void
  children: React.ReactNode; style?: React.CSSProperties; label: string
}) {
  return (
    <section aria-label={label} className="min-w-0 min-h-0 flex flex-col border border-gray-800 rounded overflow-hidden" style={style}>
      <div className="h-[30px] flex-none flex items-center gap-2.5 px-2 border-b text-[12px]" style={{ borderColor: 'var(--ts-hair, var(--ts-line))' }}>
        <b className="font-semibold text-[12.5px] text-gray-100">{title}</b>
        {sub && <span className="text-gray-400">{sub}</span>}
        {controls}
        <button type="button" className={cn(iconBtn, 'ml-auto')} onClick={onMax} aria-label={maxed ? `Back to all charts` : `Make the ${label.toLowerCase()} full size`}>
          <MaxIcon restore={maxed} />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">{children}</div>
    </section>
  )
}

/** Blind / Full review. While replaying neither is pressed; pressing either ends the replay. */
function BlindSwitch({ value, onChange, big }: { value: 'blind' | 'full' | null; onChange: (blind: boolean) => void; big?: boolean }) {
  const b = (on: boolean) => cn('font-semibold transition-colors', big ? 'h-11 px-3 text-[13px]' : 'px-3.5 py-1.5 text-[12.5px]',
    on ? 'bg-blue-500/15 text-gray-100 shadow-[inset_0_-2px_0_var(--color-blue-500)]' : 'text-gray-400 hover:text-gray-100')
  return (
    <span role="group" aria-label="Blind or full review" className={cn('inline-flex border border-gray-800 overflow-hidden flex-none', big ? 'rounded-lg' : 'rounded-md')}>
      <button type="button" aria-pressed={value === 'blind'} onClick={() => onChange(true)} className={b(value === 'blind')}>Blind</button>
      <button type="button" aria-pressed={value === 'full'} onClick={() => onChange(false)} className={cn(b(value === 'full'), 'border-l border-gray-800')} title="Shows what happened after the entry">Full review</button>
    </span>
  )
}

/** One replay: which trade, seconds after the fill, the furthest it has got, and whether it's running. `n` counts the starts. */
type Run = { id: string; e: number; far: number; running: boolean; n: number }

export default function DeepDiveWorkspace({
  trades, initialId, usesOrderFlow, week,
}: {
  trades: PickerTrade[]
  initialId: string | null
  usesOrderFlow: boolean
  week: WeekNav
}) {
  const router = useRouter()
  // One theme for the whole app: this follows the masthead switch.
  const theme = useTheme()
  const pal = PALETTE[theme]
  const phone = usePhone()
  const colors = useFootprintColors(theme)
  const [selectedId, setSelectedId] = useState<string | null>(initialId)
  const [mode, setMode] = useState<'blind' | 'full'>('blind')
  // Play forward: a replay belongs to one trade; picking another ends it (back to the mode it started from)
  const [run, setRun] = useState<Run | null>(null)
  const [speed, setSpeed] = useState<Speed>(5)
  const replay = run && run.id === selectedId ? run : null
  // server-cut at the fill only in Blind; a replay works from the Full review data
  const blind = !replay && mode === 'blind'
  const [settings, setSettings] = useState<ReplaySettings>(DEFAULTS)
  const [result, setResult] = useState<{ key: string; htf: boolean; payload?: Payload; error?: string } | null>(null)
  const [results, setResults] = useState<Record<string, ReplayResult> | null>(null)
  const [saved, setSaved] = useState<Record<string, { call: Call; note: string }>>({})
  const [max, setMax] = useState<PaneKey | null>(null)
  const [ptab, setPtab] = useState<PaneKey>('candles')
  const [sheet, setSheet] = useState<'trades' | 'settings' | null>(null)

  // per-browser view settings
  useEffect(() => {
    try {
      const saved = loadSettings()
      if (!saved) return
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage after mount (SSR has no storage)
      setSettings(s => ({ ...s, ...saved, g: { ...s.g, ...(saved.g ?? {}) } }))
    } catch { /* storage unavailable: defaults */ }
  }, [])
  const update = useCallback((patch: Partial<ReplaySettings>) => {
    setSettings(s => {
      const next = { ...s, ...patch }
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* not persisted */ }
      return next
    })
  }, [])
  const resetAll = () => update({ ...DEFAULTS, open: true })

  // ---- fetch the trade (server-cut when blind) ----
  // The 30m / 4h charts need 30-minute history. The hosted site always sends it;
  // the local build only when asked (it is a longer read), so a switch to 30m /
  // 4h refetches once if the payload on hand doesn't carry it.
  const key = `${selectedId}|${blind ? 1 : 0}`
  const wantHtf = isHtf(settings.tf)
  const have = result?.key === key ? result : null
  const satisfied = !!have && (!wantHtf || have.htf)
  // the last Blind snapshot: a replay starts from it (its partial fill bar) while the Full review data loads
  const [keep, setKeep] = useState<{ id: string; snap: DeepDiveSnapshot } | null>(null)
  useEffect(() => {
    if (!selectedId || satisfied) return
    let live = true
    const id = selectedId
    fetch(`/api/deep-dive/trade?id=${id}&blind=${blind ? 1 : 0}${wantHtf ? '&htf=1' : ''}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json()
        if (!live) return
        if (!r.ok) setResult({ key, htf: wantHtf, error: j.error ?? `HTTP ${r.status}` })
        else {
          setResult({ key, htf: wantHtf || !!(j as Payload).snapshot?.htf, payload: j as Payload })
          if ((j as Payload).blind) setKeep({ id, snap: (j as Payload).snapshot })
        }
      })
      .catch(e => { if (live) setResult({ key, htf: wantHtf, error: String(e) }) })
    return () => { live = false }
  }, [selectedId, blind, key, wantHtf, satisfied])

  // ---- Play forward: the Full review data, revealed up to the cursor ----
  const FP = replay && have?.payload && !have.payload.blind ? have.payload : null
  const FS = FP?.snapshot ?? null
  const blindSnap = keep && keep.id === selectedId ? keep.snap : null
  const endE = FS ? Math.max(0, Math.round((Date.parse(FS.cut.data_end_utc) - Date.parse(FS.cut.fill_utc)) / 1000)) : 0
  const exitsSorted = useMemo(() => [...(FP?.exits ?? [])].sort((a, b) => a.time - b.time), [FP?.exits])
  // the result shows once the replay has reached the last exit (the end of the data if none is recorded)
  const revealE = !FS ? Infinity : exitsSorted.length ? Math.max(0, exitsSorted[exitsSorted.length - 1].time - FS.times.entry) : endE
  const e = replay && FS ? Math.min(replay.e, endE) : 0
  const cursorT = FS ? FS.times.entry + e : 0
  const atEnd = !!FS && e >= endE
  const nBars = FS ? barsDone(FS, cursorT, atEnd) : 0
  const nBub = FS ? bubblesDone(FS.bubbles, cursorT) : 0
  const nExits = exitsSorted.filter(x => x.time <= cursorT).length
  const cutS = useMemo(() => (FS ? cutBars(FS, nBars, blindSnap) : null), [FS, nBars, blindSnap])
  const cutB = useMemo(() => (FS ? cutBubbles(FS.bubbles, nBub) : null), [FS, nBub])
  const cutExits = useMemo(() => exitsSorted.slice(0, nExits), [exitsSorted, nExits])
  const out = !!replay && !!FS && replay.far >= revealE
  // results (P&L, R, Score, screenshot, tags, an earlier call) stay hidden in Blind and in a replay until your exit
  const hide = blind || (!!replay && !out)

  const startReplay = useCallback(() => {
    if (selectedId) setRun(r => ({ id: selectedId, e: 0, far: 0, running: true, n: (r?.n ?? 0) + 1 }))
  }, [selectedId])
  const pickMode = useCallback((b: boolean) => { setRun(null); setMode(b ? 'blind' : 'full') }, [])
  /** Move the cursor (the slider keeps playing; a step pauses). */
  const goTo = (to: number, pause = false) => setRun(r => {
    if (!r) return r
    const x = clamp(to, 0, endE)
    return { ...r, e: x, far: Math.max(r.far, x), running: pause ? false : r.running && x < endE }
  })
  const togglePlay = () => setRun(r => (!r ? r : r.e >= endE ? { ...r, e: 0, running: true } : { ...r, running: !r.running }))
  // one bar = one 1-minute bar (the footprint's): back shows one fewer, on shows one more
  const stepBack = () => {
    if (!FS) return
    const t = FS.bars.t, atFill = barsDone(FS, FS.times.entry, false)
    goTo(nBars <= atFill + 1 ? 0 : t[nBars - 2] + 60 - FS.times.entry, true)
  }
  const stepOn = () => {
    if (!FS) return
    const t = FS.bars.t
    goTo(nBars >= t.length ? endE : t[nBars] + 60 - FS.times.entry, true)
  }
  // the clock: real time × speed, ten ticks a second; it waits at the fill until the Full review data is in
  const ticking = !!replay?.running && !!FS
  useEffect(() => {
    if (!ticking) return
    let last = performance.now()
    const iv = window.setInterval(() => {
      const now = performance.now(), dt = (now - last) / 1000
      last = now
      setRun(r => {
        if (!r || !r.running) return r
        const x = Math.min(endE, r.e + dt * speed)
        return { ...r, e: x, far: Math.max(r.far, x), running: x < endE }
      })
    }, 100)
    return () => window.clearInterval(iv)
  }, [ticking, speed, endE])

  // ---- results: asked for only once the trader leaves Blind (and, replaying, once out of the trade) ----
  const ids = useMemo(() => trades.map(t => t.id).join(','), [trades])
  useEffect(() => {
    if (hide || results || !ids) return
    let live = true
    fetch(`/api/deep-dive/results?ids=${ids}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (live && j?.results) setResults(j.results as Record<string, ReplayResult>) })
      .catch(() => { /* the list just shows no results */ })
    return () => { live = false }
  }, [hide, results, ids])

  // ---- your screenshot + tags: Full review only, fetched per trade as you go ----
  const [details, setDetails] = useState<Record<string, ReplayDetails | { error: string }>>({})
  const wantDetails = !hide && !!selectedId && (phone || settings.yours)
  const haveDetails = !!selectedId && !!details[selectedId]
  useEffect(() => {
    if (!wantDetails || haveDetails || !selectedId) return
    let live = true
    fetch(`/api/deep-dive/details?id=${selectedId}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (live) setDetails(m => ({ ...m, [selectedId]: r.ok ? j as ReplayDetails : { error: j.error ?? `HTTP ${r.status}` } }))
      })
      .catch(e => { if (live) setDetails(m => ({ ...m, [selectedId]: { error: String(e) } })) })
    return () => { live = false }
  }, [wantDetails, haveDetails, selectedId])
  const mine = selectedId ? details[selectedId] : undefined

  // A trade whose Entry half was never read (or was read for an older version)
  // gets it read now — the same POST /api/trades/score the Recap uses — once
  // per trade per visit, then the panel asks for its Score again.
  const [scoreRun, setScoreRun] = useState<Record<string, 'done' | 'pending' | 'error'>>({})
  const askedScore = useRef(new Set<string>())
  const needsScore = !!mine && !('error' in mine) && mine.needsScore
  useEffect(() => {
    if (!wantDetails || !selectedId || !needsScore || askedScore.current.has(selectedId)) return
    const id = selectedId
    askedScore.current.add(id)
    void (async () => {
      let outcome: 'done' | 'pending' | 'error' = 'done'
      try {
        const r = await fetch('/api/trades/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) })
        const j = await r.json().catch(() => ({}))
        const s = j?.results?.[id]?.status, c = j?.entry?.[id]?.status
        outcome = !r.ok || s === 'error' || c === 'error' ? 'error' : s === 'pending' || c === 'pending' ? 'pending' : 'done'
        const d = await fetch(`/api/deep-dive/details?id=${id}`, { cache: 'no-store' })
        if (d.ok) { const dj = await d.json() as ReplayDetails; setDetails(m => ({ ...m, [id]: dj })) }
      } catch { outcome = 'error' }
      setScoreRun(m => ({ ...m, [id]: outcome }))
    })()
  }, [wantDetails, selectedId, needsScore])
  const ran = selectedId ? scoreRun[selectedId] : undefined
  const scoring = needsScore && !ran ? 'running' : ran === 'pending' || ran === 'error' ? ran : null

  const yoursBody = (big: boolean) => (
    <YourTrade
      details={mine && !('error' in mine) ? mine : null}
      error={mine && 'error' in mine ? mine.error : null}
      scoring={scoring}
      big={big}
    />
  )

  const select = useCallback((id: string) => {
    setSelectedId(id)
    setRun(null)
    setSheet(null)
    router.replace(`/review/replay?id=${id}`, { scroll: false })
  }, [router])
  const goWeek = (monday: string) => router.push(`/review/replay?week=${monday}`)
  const idx = trades.findIndex(t => t.id === selectedId)
  const prevId = idx > 0 ? trades[idx - 1].id : null
  const nextId = idx >= 0 && idx < trades.length - 1 ? trades[idx + 1].id : null

  const P = have?.payload
  // what the charts show: the payload as sent, or in a replay the Full review data cut at the cursor
  // (Blind's own snapshot, i.e. the moment of the fill, while that data is on its way)
  const S: DeepDiveSnapshot | undefined = replay ? (cutS ?? blindSnap ?? undefined) : P?.snapshot
  /** The chart ends at the fill: Blind, or a replay still waiting for its data. */
  const cutAtFill = replay ? !cutS : !!P?.blind
  const BUB = replay ? (cutS ? cutB : blindSnap?.bubbles ?? null) : S?.bubbles ?? null
  const EXITS = replay ? cutExits : P?.exits
  const inst = (S?.row.inst ?? P?.trade.inst ?? 'NQ') as OfRoot
  const G = settings.g[inst]
  const htfChart = isHtf(settings.tf)
  const fpPal = useMemo(() => withFpColors(pal.footprint, colors.mine, theme), [pal.footprint, colors.mine, theme])
  // the candle chart's palette: the theme with the trader's Up / Down candles
  const candlePal = useMemo(() => withCandleColors(pal, colors.mine), [pal, colors.mine])

  // ---- what's on screen ----
  const bubblesOn = settings.bubbles ?? usesOrderFlow
  const fpOn = settings.fp ?? usesOrderFlow
  const candlesOn = settings.candles || !bubblesOn
  const tabs = ([['candles', candlesOn], ['bubbles', bubblesOn], ['fp', fpOn], ['yours', !hide]] as [PaneKey, boolean][]).filter(([, on]) => on).map(([k]) => k)
  const tab: PaneKey = tabs.includes(ptab) ? ptab : tabs[0]
  const maxed = max && tabs.includes(max) ? max : null
  const showTime = phone ? tab === 'candles' : candlesOn && (!maxed || maxed === 'candles')
  const showBubbles = phone ? tab === 'bubbles' : bubblesOn && (!maxed || maxed === 'bubbles')
  const showFp = phone ? tab === 'fp' : fpOn && (!maxed || maxed === 'fp')
  const layoutKey = `${phone ? 'p' : 'd'}|${maxed ?? ''}|${tab}`
  const toggleMax = (k: PaneKey) => setMax(m => (m === k ? null : k))

  // ---- derived data ----
  const D = useMemo(() => {
    if (!S) return null
    const m1 = toBars1m(S.bars, S.has_partial)
    const vap = vapPerBar(S.vap, m1.length)
    const entry = S.times.entry
    // the last 1m bar the trader could see: the partial bar (blind), or the last completed bar before the fill
    let fillIdx = m1.length - 1
    if (!cutAtFill) { fillIdx = -1; for (let i = 0; i < m1.length && m1[i].t + 60 <= entry; i++) fillIdx = i }
    const asOf = m1.slice(0, fillIdx + 1)
    return {
      m1, vap, fillIdx, asOf,
      hist: S.htf ? htfToBars(S.htf) : [],
      vwap: vwap24h(m1), rvwap: vwapRth(m1), ema9: emaOnTf(m1, 9), ema20: emaOnTf(m1, 20),
      atr: atr1m5m(asOf, entry),
    }
  }, [S, cutAtFill])

  // 1m / 5m: the 1-minute window. 30m / 4h: the 30-minute history, continued by the window.
  const { agg, fillAt } = useMemo((): { agg: AggBar[]; fillAt: number } => {
    if (!D) return { agg: [], fillAt: 0 }
    if (!htfChart) return { agg: buildAgg(D.m1, D.vap, settings.tf), fillAt: D.fillIdx }
    const empty: VapRow[][] = D.hist.map(() => [])
    return {
      agg: buildAgg([...D.hist, ...D.m1], [...empty, ...D.vap], settings.tf, settings.tf === 240 ? SESSION_4H_OFFSET : 0),
      fillAt: D.hist.length + D.fillIdx,
    }
  }, [D, settings.tf, htfChart])

  // the footprint's entry and bracket, kept as the same objects while a replay moves on (its model re-reads on change)
  const ePx = S?.row.price ?? 0, eSec = S ? +S.row.time.slice(6, 8) : 0
  const fpEntry = useMemo(() => ({ price: ePx, entrySec: eSec }), [ePx, eSec])
  const bStop = S?.bracket.stop ?? null, bTp = S?.bracket.tp ?? null
  const fpBracket = useMemo(() => ({ stop: bStop, tp: bTp }), [bStop, bTp])

  const profile = useMemo(() => {
    if (!D || !S || settings.prof === 'off') return null
    const [t0, t1] = profileWindow(settings.prof, S.times)
    return volumeProfile(D.m1, D.vap, t0, t1, G.prof)
  }, [D, S, settings.prof, G.prof])

  const nearLevels: NearLevel[] = useMemo(() => {
    if (!D || !S) return []
    const i = D.fillIdx
    const items: NearLevel[] = S.levels.map(l => ({ name: l.name + (l.dev ? ' (dev)' : ''), price: l.price }))
    const v = D.vwap[i], rv = D.rvwap[i]
    if (v != null) items.push({ name: 'VWAP 24h', price: v })
    if (rv != null) items.push({ name: 'VWAP RTH', price: rv })
    if (i >= 0) items.push({ name: '9 EMA (5m)', price: D.ema9[i] }, { name: '20 EMA (5m)', price: D.ema20[i] })
    const sp = volumeProfile(D.asOf, D.vap, S.times.profile_anchor, Infinity, G.prof)
    if (sp) items.push({ name: 'dev POC', price: sp.pocPx }, { name: 'dev VAH', price: sp.vahPx }, { name: 'dev VAL', price: sp.valPx })
    return items
  }, [D, S, G.prof])

  // ---- charts ----
  const timeEl = useRef<HTMLDivElement>(null)
  const bubEl = useRef<HTMLDivElement>(null)
  const timeCtl = useRef<TimeChartController | null>(null)
  const bubCtl = useRef<BubbleChartController | null>(null)
  const [legendIdx, setLegendIdx] = useState<number | null>(null)
  const [bubLegendSlot, setBubLegendSlot] = useState<number | null>(null)
  const lastKey = useRef<string>('')
  // a chart view starts at the fill per trade and mode, and again at each Play from the fill
  const viewOf = `${selectedId}|${replay ? `play${replay.n}` : blind ? 'blind' : 'full'}`
  const following = !!replay

  // VWAP, the 5m EMAs and bar POC are intraday reads; they don't belong on a 30m / 4h chart
  const timeOpts: Omit<TimeChartOpts, 'palette'> = useMemo(() => ({
    ha: settings.ha, levels: settings.lv, vwap: settings.vwap && !htfChart, ema: settings.ema && !htfChart,
    poc: settings.poc && !htfChart, deltaVol: settings.dv,
  }), [settings.ha, settings.lv, settings.vwap, settings.ema, settings.poc, settings.dv, htfChart])

  useEffect(() => {
    if (!showTime || !timeEl.current || !D || !S) return
    // the container remounts while the next trade loads, or the layout changes: rebuild on the new element
    if (timeCtl.current && timeCtl.current.el !== timeEl.current) { timeCtl.current.destroy(); timeCtl.current = null }
    if (!timeCtl.current) {
      timeCtl.current = new TimeChartController(timeEl.current, { ...timeOpts, palette: candlePal })
      timeCtl.current.onCrosshair = i => setLegendIdx(i)
    }
    const none = agg.map(() => null)
    const at = (vals: (number | null)[]) => (htfChart ? none : agg.map(b => vals[b.mins[b.mins.length - 1]] ?? null))
    // The 5m EMAs on the 1m chart: one point per completed 5m bar (its last minute) plus the newest bar, live —
    // a smooth line through the 5m closes, not the forming 5m bar re-read every minute (that drew a sawtooth)
    const ema5 = (vals: (number | null)[]) => {
      const v = at(vals)
      if (settings.tf !== 1) return v
      return v.map((x, i) => (i === agg.length - 1 || Math.floor(agg[i].t / 300) !== Math.floor(agg[i + 1].t / 300) ? x : null))
    }
    const entryIndex = Math.max(0, agg.findIndex(b => b.mins.includes(Math.max(0, fillAt))))
    const viewKey = `${viewOf}|${settings.tf}|${D.hist.length}`
    const resetView = timeCtl.current.bars.length === 0 || lastKey.current !== viewKey
    lastKey.current = viewKey
    timeCtl.current.render({
      agg, vwap: at(D.vwap), rvwap: at(D.rvwap), ema9: ema5(D.ema9), ema20: ema5(D.ema20), profile,
      levels: S.levels, bracket: S.bracket,
      entry: { price: S.row.price, direction: S.row.direction, time: S.times.entry, label: `fill ${S.row.time}` },
      exits: EXITS ?? [], entryIndex,
    }, { ...timeOpts, palette: candlePal }, resetView, following)
  }, [D, S, EXITS, agg, fillAt, htfChart, profile, timeOpts, candlePal, showTime, viewOf, following, settings.tf, layoutKey])

  useEffect(() => () => { timeCtl.current?.destroy(); timeCtl.current = null }, [showTime])

  // Play forward: the last trade price, drawn as a dashed "now" line
  const nowPx = replay && BUB && BUB.c.length ? BUB.c[BUB.c.length - 1] : null
  useEffect(() => {
    timeCtl.current?.setNow(showTime ? nowPx : null, pal.legend.text)
  }, [nowPx, showTime, pal.legend.text, D, agg, layoutKey])

  const bubKey = useRef('')
  useEffect(() => {
    if (!showBubbles || !bubEl.current || !S || !BUB) return
    if (bubCtl.current && bubCtl.current.el !== bubEl.current) { bubCtl.current.destroy(); bubCtl.current = null }
    if (!bubCtl.current) {
      bubCtl.current = new BubbleChartController(bubEl.current)
      bubCtl.current.onCrosshair = s => setBubLegendSlot(s)
    }
    const reset = bubKey.current !== viewOf
    bubKey.current = viewOf
    // the forming bubble is previewed only when the chart ends at the fill
    bubCtl.current.render(BUB, { offset: settings.boff, bars40: settings.b40, levels: settings.lv }, S.levels, S.bracket,
      { price: S.row.price, direction: S.row.direction, time: S.times.entry }, cutAtFill, reset, pal, following)
  }, [S, BUB, cutAtFill, showBubbles, settings.boff, settings.b40, settings.lv, viewOf, following, pal, layoutKey])

  useEffect(() => () => { bubCtl.current?.destroy(); bubCtl.current = null }, [showBubbles])

  // keyboard: ← → or [ ] previous / next trade · B Blind / Full · Space play / pause · 1 / 5 / 3 / 4 timeframe · H Heiken-Ashi
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement, tag = el?.tagName
      const onSlider = tag === 'INPUT' && (el as HTMLInputElement).type === 'range'
      if ((tag === 'INPUT' && !(onSlider && e.key === ' ')) || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.altKey || e.metaKey) return
      const tfMap: Record<string, Tf> = { '1': 1, '5': 5, '3': 30, '4': 240 }
      if (tfMap[e.key]) update({ tf: tfMap[e.key] })
      else if (e.key === 'h' || e.key === 'H') update({ ha: !settings.ha })
      else if (e.key === 'b' || e.key === 'B') pickMode(!blind)
      else if (e.key === ' ' && tag !== 'BUTTON' && selectedId) { e.preventDefault(); if (replay) togglePlay(); else startReplay() }
      else if ((e.key === '[' || e.key === 'ArrowLeft') && prevId) { e.preventDefault(); select(prevId) }
      else if ((e.key === ']' || e.key === 'ArrowRight') && nextId) { e.preventDefault(); select(nextId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- dividers ----
  const rowRef = useRef<HTMLDivElement>(null)
  const colRef = useRef<HTMLDivElement>(null)
  const startDrag = (axis: 'x' | 'y') => (e: React.PointerEvent) => {
    const el = axis === 'x' ? rowRef.current : colRef.current
    if (!el) return
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      if (axis === 'x') update({ split: clamp((ev.clientX - rect.left) / rect.width, 0.2, 0.8) })
      else update({ fpH: Math.round(clamp(rect.bottom - ev.clientY, 120, rect.height - 200)) })
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const nudge = (axis: 'x' | 'y') => (e: React.KeyboardEvent) => {
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
    if (!d) return
    e.preventDefault(); e.stopPropagation()
    if (axis === 'x') update({ split: clamp(settings.split + d * 0.05, 0.2, 0.8) })
    else update({ fpH: Math.round(clamp(settings.fpH - d * 20, 120, 600)) })
  }

  // ---- words on screen ----
  const legend = (() => {
    if (!agg.length) return ''
    const b = legendIdx != null && agg[legendIdx] ? agg[legendIdx] : agg[agg.length - 1]
    const f = (x: number) => x.toFixed(2)
    return `${fmtDT(b.t)}${b.partial ? `  (partial → fill ${S?.row.time})` : ''}  ${tfLabel(settings.tf)}\nO ${f(b.o)}  H ${f(b.h)}  L ${f(b.l)}  C ${f(b.c)}  V ${b.v}` +
      (htfChart ? `\nΔ ${b.d}  bid ${b.bv}  ask ${b.av}` : `\nΔ ${b.d}  (min ${b.dmin}  max ${b.dmax})  bid ${b.bv}  ask ${b.av}`)
  })()
  const bubLegend = (() => {
    const B = BUB; if (!B) return ''
    const n = B.lvl.length
    let x = bubLegendSlot ?? n - 1; if (x < 0 || x >= n) x = n - 1
    const gi = settings.boff ? Math.min(x + 1, n - 1) : x, isLive = gi === n - 1
    const lv = isLive && settings.boff && x === n - 1 ? B.live_lvl : B.lvl[gi]
    return `${fmtTs(B.t[x])}  40T bar  O ${B.o[x].toFixed(2)} H ${B.h[x].toFixed(2)} L ${B.l[x].toFixed(2)} C ${B.c[x].toFixed(2)}\n` +
      `bubble: ${B.dir[gi] > 0 ? 'BUY' : 'SELL'} ${B.vol[gi]} @ ${B.px[gi].toFixed(2)} · ${['small', 'medium', 'large'][lv]}` +
      (isLive && cutAtFill ? `  (forming: ${B.live_trades}/40 trades at the fill)` : '')
  })()
  const showLegend = settings.details || legendIdx != null
  const showBubLegend = settings.details || bubLegendSlot != null

  const cur = idx >= 0 ? trades[idx] : null
  const r = S?.row
  const B = S?.bracket
  const dirWord = (d: 'long' | 'short') => (d === 'long' ? 'Long' : 'Short')
  const day = r ? `${r.weekday} ${format(parseISO(r.date), 'MMM d')}` : cur ? format(parseISO(cur.date), 'EEE MMM d') : ''
  const time = r ? r.time : cur ? ptTime(cur.entryUtc) : ''
  const what = r ? `${r.inst} · ${dirWord(r.direction)} @ ${r.price.toFixed(2)}` : cur ? `${rootOf(cur.symbol)} · ${dirWord(cur.direction)}` : ''
  const rr = B && B.stop != null && B.tp != null && r ? Math.abs(B.tp - r.price) / Math.abs(r.price - B.stop) : null
  const res = !hide && selectedId ? results?.[selectedId] : undefined
  // the replay's clock: HH:MM:SS PT at the cursor and how long after the fill
  const sinceSec = Math.floor(e)
  const since = `${Math.floor(sinceSec / 60)}m ${String(sinceSec % 60).padStart(2, '0')}s`
  const clock = fmtTs(S ? S.times.entry + sinceSec : 0)
  // the replay chip is grey on purpose: green or red could be read as how the trade went
  const chip = replay
    ? { text: phone ? `Replay · ${clock} · ${since} in` : out ? 'Replay · past your exit' : 'Replay · the result shows at your exit', bg: theme === 'light' ? '#ECEEF3' : 'rgba(160,170,190,.16)', ink: theme === 'light' ? '#3A4257' : '#C9D0DE' }
    : cutAtFill
    ? { text: phone ? `Blind · stops at ${S?.cutoff_label}` : `Blind · chart stops at ${S?.cutoff_label}, one second before your fill`, bg: theme === 'light' ? '#FFF1DC' : 'rgba(255,159,26,.16)', ink: theme === 'light' ? '#7A4A00' : '#FFC266' }
    : { text: phone ? 'Full review' : 'Full review · runs 30 minutes past your exit', bg: theme === 'light' ? '#E3ECF7' : 'rgba(79,151,206,.18)', ink: theme === 'light' ? '#1F4E7A' : '#9CC8EA' }
  const htfNote = htfChart && !satisfied ? `loading ${tfLabel(settings.tf)} history…` : htfChart && D && D.hist.length === 0 ? 'no earlier history available for this date' : null
  const callsMap = useMemo(() => Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, v.call])), [saved])
  const savedCall = selectedId ? saved[selectedId] ?? (results?.[selectedId] ? { call: results[selectedId].call, note: results[selectedId].note } : null) : null
  const onSaved = (id: string, v: { call: Call; note: string }) => setSaved(m => ({ ...m, [id]: v }))

  const planLine = B && (B.stop != null || B.tp != null) && (
    <span className="font-mono text-[12px] tabular-nums text-gray-400 whitespace-nowrap">
      {B.stop != null && <>Stop <span className="text-red-400">{B.stop.toFixed(2)}</span>{B.stop_src === 'assumed' ? ' (assumed)' : ''}</>}
      {B.stop != null && B.tp != null && ' · '}
      {B.tp != null && <>Target <span className="text-green-400">{B.tp.toFixed(2)}</span>{B.tp_src === 'assumed' ? ' (assumed)' : ''}</>}
      {rr != null && <> · {rr.toFixed(1)}R</>}
    </span>
  )
  const resultLine = res && res.pnl != null && (
    <span className="font-mono text-[12px] tabular-nums text-gray-100 whitespace-nowrap">
      Result <span className={cn('font-semibold', res.pnl > 0 ? 'text-green-400' : res.pnl < 0 ? 'text-red-400' : 'text-gray-400')}>
        {res.r != null ? `${fmtR(res.r)} · ` : ''}{fmtUsd(res.pnl)}
      </span>{res.held_sec != null ? ` · held ${fmtHeld(res.held_sec)}` : ''}
    </span>
  )

  // ---- the charts, shared by both layouts ----
  const chipEl = <span className="px-2 py-[3px] rounded-full text-[11.5px] font-medium" style={{ background: chip.bg, color: chip.ink }}>{chip.text}</span>
  const candleBody = (
    <>
      <div ref={timeEl} className="absolute inset-0" />
      <div className="absolute left-2 top-1.5 z-10 pointer-events-none flex flex-col items-start gap-1 max-w-[calc(100%-96px)]">
        {S && chipEl}
        {htfNote && <span className="text-[11px]" style={{ color: pal.legend.text }}>{htfNote}</span>}
        {showLegend && legend && (
          <pre className="m-0 px-1.5 py-0.5 rounded-[3px] font-mono text-[12px] leading-snug overflow-hidden" style={{ background: pal.legend.bg, color: pal.legend.text }}>{legend}</pre>
        )}
      </div>
    </>
  )
  const bubbleBody = S && (
    BUB ? (
      <>
        <div ref={bubEl} className="absolute inset-0" />
        {showBubLegend && (
          <pre className={cn('absolute left-2 z-10 pointer-events-none m-0 px-1.5 py-0.5 rounded-[3px] font-mono text-[12px] leading-snug max-w-[calc(100%-96px)] overflow-hidden', phone && replay ? 'top-8' : 'top-1.5')}
            style={{ background: pal.legend.bg, color: pal.legend.text }}>{bubLegend}</pre>
        )}
        {settings.details && (
          <div className="absolute left-2 bottom-7 z-10 pointer-events-none font-mono text-[11px]" style={{ color: pal.bubbles.caption }}>
            40-trade bubbles · lookback {BUB.cfg.lookback} · medium ≥ {BUB.cfg.medium_pct}th pct · large &gt; {BUB.cfg.large_pct}th{BUB.cfg.floor ? ` · ES floor ${BUB.cfg.floor}` : ''} · prints ≥ {BUB.lpt}{settings.boff ? ' · -1 offset' : ''}
          </div>
        )}
      </>
    ) : <p className="p-4 text-[12.5px] text-gray-400">No bubble data for this trade.</p>
  )
  const footprintBody = D && S && (
    <Footprint1m
      // Blind and a replay: every bar up to the moment; Full review: the fill and the five bars after it
      m1={cutAtFill || replay ? D.m1 : D.m1.slice(0, Math.min(D.m1.length, D.fillIdx + 6))}
      vap={D.vap}
      entry={fpEntry}
      fillT={Math.floor(S.times.entry / 60) * 60}
      bracket={fpBracket}
      bars={phone ? Math.min(5, settings.fpN) : settings.fpN} g={G.fp} ratio={settings.fpR} minVol={G.min} palette={fpPal}
    />
  )
  const status = (!S && !!selectedId)
    ? (have?.error ? <p className="p-6 text-[13px] text-red-400">{have.error}</p> : <p className="p-6 text-[13px] text-gray-400">Building the chart as of the fill…</p>)
    : have?.error ? <p className="p-6 text-[13px] text-red-400">{have.error}</p> : null

  const settingsPanel = (compact: boolean) => (
    <ChartSettingsPanel s={settings} update={update} inst={inst} ofDefault={usesOrderFlow} colors={colors} onResetAll={resetAll} compact={compact} />
  )
  const weekList = (big: boolean) => (
    <WeekTrades trades={trades} selectedId={selectedId} onSelect={select} blind={hide} results={hide ? null : results} calls={callsMap} week={week} onWeek={goWeek} big={big} />
  )
  const callBar = (compact: boolean) => selectedId && (
    <CallBar key={`${selectedId}|${hide ? 'b' : 'f'}|${results ? 1 : 0}`} tradeId={selectedId} blind={hide}
      initial={hide ? null : savedCall} onSaved={onSaved} onNext={!compact && nextId ? () => select(nextId) : undefined} compact={compact} />
  )
  const controls = (compact: boolean) => replay && (
    <ReplayControls running={replay.running} ready={!!FS} atStart={e <= 0} atEnd={atEnd} e={e} end={endE} speed={speed}
      onToggle={togglePlay} onBack={stepBack} onOn={stepOn} onSpeed={setSpeed} onScrub={goTo} clock={clock} since={since} compact={compact} />
  )

  // ---------------- phone ----------------
  if (phone) {
    return (
      <div className="flex flex-col -mx-3" style={{ height: 'calc(100dvh - 224px - var(--tabbar-bottom, 0px))', minHeight: 520 }}>
        <div className="h-[60px] flex-none flex items-center gap-2">
          <button type="button" className={cn(iconBtn, 'w-11 h-11 rounded-lg text-gray-100')} aria-label="Previous trade" disabled={!prevId} onClick={() => prevId && select(prevId)}><Chevron left size={16} /></button>
          <div className="flex-1 min-w-0 text-center leading-tight">
            <div className="font-semibold text-[14.5px] tabular-nums text-gray-100 truncate">{day}{time ? ` · ${time}` : ''}</div>
            <div className="font-mono text-[12px] text-gray-400 truncate">{what}{res?.pnl != null ? ` · ${fmtUsd(res.pnl)}` : idx >= 0 ? ` · ${idx + 1} of ${trades.length}` : ''}</div>
          </div>
          <button type="button" className={cn(iconBtn, 'w-11 h-11 rounded-lg text-gray-100')} aria-label="Next trade" disabled={!nextId} onClick={() => nextId && select(nextId)}><Chevron size={16} /></button>
        </div>
        <div className="h-12 flex-none flex items-center gap-2">
          <BlindSwitch value={replay ? null : mode} onChange={pickMode} big />
          <button type="button" onClick={() => setSheet('trades')} className="h-11 px-3 border border-gray-800 rounded-lg text-[13px] text-gray-100">Trades</button>
          <span className="ml-auto"><SettingsIconButton onClick={() => setSheet('settings')} /></span>
        </div>
        {tabs.length > 1 && (
          <div role="tablist" aria-label="Chart" className="h-10 flex-none grid border border-gray-800 rounded-lg overflow-hidden" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map(k => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setPtab(k)}
                className={cn('text-[13px]', tab === k ? 'bg-blue-500/15 text-gray-100 font-semibold shadow-[inset_0_-2px_0_var(--color-blue-500)]' : 'text-gray-400')}>
                {TAB_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        <section aria-label={TAB_LABEL[tab]} className="flex-1 min-h-0 mt-2 relative border border-gray-800 rounded-md overflow-hidden" style={{ background: pal.chart.bg }}>
          {trades.length === 0 ? <p className="p-4 text-[13px] text-gray-400">No trades this week.</p>
            : tab === 'yours' ? <div className="absolute inset-0 overflow-y-auto p-3">{yoursBody(true)}</div>
            : status ?? (D && S && (
              tab === 'candles' ? candleBody : tab === 'bubbles' ? bubbleBody
                // replaying, the clock chip sits over the strip's top: make room for it
                : replay ? <div className="absolute inset-0 pt-7">{footprintBody}</div> : footprintBody
            ))}
          {/* replaying: the clock on every chart (the candles carry it already) */}
          {replay && S && (tab === 'bubbles' || tab === 'fp') && <div className="absolute left-2 top-1.5 z-10 pointer-events-none">{chipEl}</div>}
          {!replay && D && S && tab !== 'yours' && trades.length > 0 && <PlayFromFillPill onClick={startReplay} />}
        </section>
        {controls(true)}
        {callBar(true)}
        {sheet && (
          <div className="fixed inset-0 z-50">
            <button type="button" aria-label="Close" className="absolute inset-0 bg-black/45" onClick={() => setSheet(null)} />
            <div className="absolute inset-x-0 bottom-0 h-[75vh] flex flex-col rounded-t-2xl shadow-2xl" style={{ background: 'var(--color-surface-1)' }}>
              <div className="flex justify-center pt-2"><span className="w-10 h-1 rounded-full" style={{ background: 'var(--ts-line)' }} /></div>
              <div className="h-12 flex-none flex items-center pl-4 pr-2 border-b border-gray-800">
                <span className="font-semibold text-[15px] text-gray-100">{sheet === 'settings' ? 'Chart Settings' : `${week.title} · ${week.range}`}</span>
                <button type="button" onClick={() => setSheet(null)} className="ml-auto h-11 px-3 text-[14px] text-blue-400">Done</button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4" style={{ paddingBottom: 'calc(1rem + var(--tabbar-bottom, 0px))' }}>
                {sheet === 'settings' ? settingsPanel(true) : weekList(true)}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ---------------- desktop ----------------
  const both = showTime && showBubbles
  return (
    <div className="flex -mt-2" style={{ height: 'calc(100vh - 150px)', minHeight: 640 }}>
      {/* left column: Chart Settings on top, then the week's trades */}
      <aside aria-label="Chart Settings and this week's trades" className="w-[248px] flex-none overflow-y-auto pr-3.5 py-3 border-r" style={{ borderColor: 'var(--ts-line)' }}>
        <ChartSettingsToggle open={settings.open} onChange={open => update({ open })} />
        {settings.open && settingsPanel(false)}
        {weekList(false)}
      </aside>

      <div className="flex-1 min-w-0 flex flex-col pl-3.5">
        {/* trade header: entry-time facts; the result only in Full review, or once a replay reaches your exit */}
        <div className="h-[50px] flex-none flex items-center gap-3.5 border-b min-w-0" style={{ borderColor: 'var(--ts-line)' }}>
          <span className="flex gap-1 flex-none">
            <button type="button" className={iconBtn} aria-label="Previous trade" disabled={!prevId} onClick={() => prevId && select(prevId)}><Chevron left /></button>
            <button type="button" className={iconBtn} aria-label="Next trade" disabled={!nextId} onClick={() => nextId && select(nextId)}><Chevron /></button>
          </span>
          {day && <span className="min-w-0 text-[15px] font-semibold tabular-nums text-gray-100 whitespace-nowrap truncate">{day} · {time} PT · {what}</span>}
          {planLine}
          {resultLine}
          <span className="ml-auto text-[12px] text-gray-400 whitespace-nowrap">{idx >= 0 ? `${idx + 1} of ${trades.length}` : ''}</span>
          <BlindSwitch value={replay ? null : mode} onChange={pickMode} />
          {selectedId && <PlayFromFillButton on={!!replay} onClick={startReplay} />}
        </div>
        {controls(false)}

        {trades.length === 0 ? (
          <p className="p-6 text-[13px] text-gray-400">No trades this week. Use the arrows by the week to find another.</p>
        ) : (
          <>
            <div ref={colRef} className="flex-1 min-h-0 flex flex-col pt-2">
              {status}
              {D && S && (
                <>
                  {(showTime || showBubbles) && (
                    <div ref={rowRef} className="flex min-h-[180px]" style={{ flex: '1 1 0' }}>
                      {showTime && (
                        <Pane
                          label="Candles" title="Candles" maxed={maxed === 'candles'} onMax={() => toggleMax('candles')}
                          style={{ flex: both ? `0 0 calc(${settings.split * 100}% - 5px)` : '1 1 0', background: pal.chart.bg }}
                          controls={(
                            <>
                              <span role="group" aria-label="Timeframe" className="inline-flex gap-0.5">
                                {TFS.map(t => <button key={t} type="button" className={btn(settings.tf === t)} aria-pressed={settings.tf === t} onClick={() => update({ tf: t })}>{tfLabel(t)}</button>)}
                              </span>
                              <button type="button" onClick={() => timeCtl.current?.focusFill()} className="ml-auto px-2 py-[2px] border border-gray-800 rounded-[4px] text-[12px] text-gray-400 hover:text-gray-100">Back to the fill</button>
                            </>
                          )}
                        >{candleBody}</Pane>
                      )}
                      {both && (
                        <div role="separator" aria-orientation="vertical" aria-label="Drag to resize the two charts" tabIndex={0}
                          onPointerDown={startDrag('x')} onKeyDown={nudge('x')}
                          className="flex-none w-2.5 flex items-center justify-center cursor-col-resize group focus:outline-none">
                          <span className="w-[3px] h-[34px] rounded-sm group-hover:bg-blue-500 group-focus:bg-blue-500" style={{ background: 'var(--ts-line)' }} />
                        </div>
                      )}
                      {showBubbles && (
                        <Pane label="Bubbles" title="Bubbles" sub="40 trades each" maxed={maxed === 'bubbles'} onMax={() => toggleMax('bubbles')}
                          style={{ flex: '1 1 0', background: pal.chart.bg }}>{bubbleBody}</Pane>
                      )}
                    </div>
                  )}
                  {showFp && (
                    <>
                      {(showTime || showBubbles) && (
                        <div role="separator" aria-orientation="horizontal" aria-label="Drag to resize the footprint" tabIndex={0}
                          onPointerDown={startDrag('y')} onKeyDown={nudge('y')}
                          className="flex-none h-2.5 flex items-center justify-center cursor-row-resize group focus:outline-none">
                          <span className="w-[34px] h-[3px] rounded-sm group-hover:bg-blue-500 group-focus:bg-blue-500" style={{ background: 'var(--ts-line)' }} />
                        </div>
                      )}
                      <Pane label="Footprint" title="Footprint" sub={`1 minute · last ${settings.fpN} bars`} maxed={maxed === 'fp'} onMax={() => toggleMax('fp')}
                        style={(showTime || showBubbles) ? { height: settings.fpH, flex: 'none', background: fpPal.bg } : { flex: '1 1 0', background: fpPal.bg }}>
                        {footprintBody}
                      </Pane>
                    </>
                  )}
                </>
              )}
            </div>
            {callBar(false)}
          </>
        )}
      </div>

      {/* Full review, or a replay past your exit: your Score, screenshot and tags */}
      {!hide && settings.yours && selectedId && (
        <aside aria-label="Your trade" className="w-[290px] flex-none border-l overflow-y-auto pl-3.5 py-3 ml-3.5" style={{ borderColor: 'var(--ts-line)' }}>
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-[13.5px] font-semibold text-gray-100">Your trade</span>
            <span className="text-[11.5px] text-gray-400">{replay ? 'shown at your exit' : 'Full review only'}</span>
          </div>
          {yoursBody(false)}
        </aside>
      )}

      {settings.rail && D && S && (
        <aside className="w-[380px] flex-none border-l overflow-y-auto pl-3 py-3 ml-3.5 space-y-4" style={{ borderColor: 'var(--ts-line)' }}>
          <div>
            <h3 className="text-[12px] mb-1.5" style={{ color: 'var(--ts-mut)' }}>Planned bracket at entry</h3>
            <BracketBox bracket={S.bracket} entryPrice={S.row.price} />
          </div>
          <div>
            <h3 className="text-[12px] mb-1.5" style={{ color: 'var(--ts-mut)' }}>
              Levels near entry · ATR 1m {S.bracket.atr?.toFixed(2) ?? D.atr.atr1?.toFixed(2) ?? '—'} · 5m {D.atr.atr5?.toFixed(2) ?? '—'} pts
            </h3>
            <LevelsNearEntry items={nearLevels} entryPrice={S.row.price} atr={S.bracket.atr ?? D.atr.atr1} />
          </div>
        </aside>
      )}
    </div>
  )
}
