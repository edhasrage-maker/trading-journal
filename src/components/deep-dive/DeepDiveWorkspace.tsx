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
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'
import type { DeepDivePayload } from '@/lib/orderflow/server/deep-dive-payload'
import type { OfRoot } from '@/lib/orderflow/ticks'
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

function BlindSwitch({ blind, onChange, big }: { blind: boolean; onChange: (blind: boolean) => void; big?: boolean }) {
  const b = (on: boolean) => cn('font-semibold transition-colors', big ? 'h-11 px-3 text-[13px]' : 'px-3.5 py-1.5 text-[12.5px]',
    on ? 'bg-blue-500/15 text-gray-100 shadow-[inset_0_-2px_0_var(--color-blue-500)]' : 'text-gray-400 hover:text-gray-100')
  return (
    <span role="group" aria-label="Blind or full review" className={cn('inline-flex border border-gray-800 overflow-hidden flex-none', big ? 'rounded-lg' : 'rounded-md')}>
      <button type="button" aria-pressed={blind} onClick={() => onChange(true)} className={b(blind)}>Blind</button>
      <button type="button" aria-pressed={!blind} onClick={() => onChange(false)} className={cn(b(!blind), 'border-l border-gray-800')} title="Shows what happened after the entry">Full review</button>
    </span>
  )
}

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
  const [blind, setBlind] = useState(true)
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
  useEffect(() => {
    if (!selectedId || satisfied) return
    let live = true
    fetch(`/api/deep-dive/trade?id=${selectedId}&blind=${blind ? 1 : 0}${wantHtf ? '&htf=1' : ''}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json()
        if (!live) return
        if (!r.ok) setResult({ key, htf: wantHtf, error: j.error ?? `HTTP ${r.status}` })
        else setResult({ key, htf: wantHtf || !!(j as Payload).snapshot?.htf, payload: j as Payload })
      })
      .catch(e => { if (live) setResult({ key, htf: wantHtf, error: String(e) }) })
    return () => { live = false }
  }, [selectedId, blind, key, wantHtf, satisfied])

  // ---- results: asked for only once the trader leaves Blind ----
  const ids = useMemo(() => trades.map(t => t.id).join(','), [trades])
  useEffect(() => {
    if (blind || results || !ids) return
    let live = true
    fetch(`/api/deep-dive/results?ids=${ids}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (live && j?.results) setResults(j.results as Record<string, ReplayResult>) })
      .catch(() => { /* the list just shows no results */ })
    return () => { live = false }
  }, [blind, results, ids])

  // ---- your screenshot + tags: Full review only, fetched per trade as you go ----
  const [details, setDetails] = useState<Record<string, ReplayDetails | { error: string }>>({})
  const wantDetails = !blind && !!selectedId && (phone || settings.yours)
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
  const yoursBody = (big: boolean) => (
    <YourTrade
      details={mine && !('error' in mine) ? mine : null}
      error={mine && 'error' in mine ? mine.error : null}
      big={big}
    />
  )

  const select = useCallback((id: string) => {
    setSelectedId(id)
    setSheet(null)
    router.replace(`/review/replay?id=${id}`, { scroll: false })
  }, [router])
  const goWeek = (monday: string) => router.push(`/review/replay?week=${monday}`)
  const idx = trades.findIndex(t => t.id === selectedId)
  const prevId = idx > 0 ? trades[idx - 1].id : null
  const nextId = idx >= 0 && idx < trades.length - 1 ? trades[idx + 1].id : null

  const P = have?.payload
  const S = P?.snapshot
  const inst = (P?.trade.inst ?? 'NQ') as OfRoot
  const G = settings.g[inst]
  const htfChart = isHtf(settings.tf)
  const fpPal = useMemo(() => withFpColors(pal.footprint, colors.mine, theme), [pal.footprint, colors.mine, theme])
  // the candle chart's palette: the theme with the trader's Up / Down candles
  const candlePal = useMemo(() => withCandleColors(pal, colors.mine), [pal, colors.mine])

  // ---- what's on screen ----
  const bubblesOn = settings.bubbles ?? usesOrderFlow
  const fpOn = settings.fp ?? usesOrderFlow
  const candlesOn = settings.candles || !bubblesOn
  const tabs = ([['candles', candlesOn], ['bubbles', bubblesOn], ['fp', fpOn], ['yours', !blind]] as [PaneKey, boolean][]).filter(([, on]) => on).map(([k]) => k)
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
    if (!P?.blind) { fillIdx = -1; for (let i = 0; i < m1.length && m1[i].t + 60 <= entry; i++) fillIdx = i }
    const asOf = m1.slice(0, fillIdx + 1)
    return {
      m1, vap, fillIdx, asOf,
      hist: S.htf ? htfToBars(S.htf) : [],
      vwap: vwap24h(m1), rvwap: vwapRth(m1), ema9: emaOnTf(m1, 9), ema20: emaOnTf(m1, 20),
      atr: atr1m5m(asOf, entry),
    }
  }, [S, P?.blind])

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
    const entryIndex = Math.max(0, agg.findIndex(b => b.mins.includes(Math.max(0, fillAt))))
    const viewKey = `${key}|${settings.tf}|${D.hist.length}`
    const resetView = timeCtl.current.bars.length === 0 || lastKey.current !== viewKey
    lastKey.current = viewKey
    timeCtl.current.render({
      agg, vwap: at(D.vwap), rvwap: at(D.rvwap), ema9: at(D.ema9), ema20: at(D.ema20), profile,
      levels: S.levels, bracket: S.bracket,
      entry: { price: S.row.price, direction: S.row.direction, time: S.times.entry, label: `fill ${S.row.time}` },
      exits: P?.exits ?? [], entryIndex,
    }, { ...timeOpts, palette: candlePal }, resetView)
  }, [D, S, P?.exits, agg, fillAt, htfChart, profile, timeOpts, candlePal, showTime, key, settings.tf, layoutKey])

  useEffect(() => () => { timeCtl.current?.destroy(); timeCtl.current = null }, [showTime])

  const bubKey = useRef('')
  useEffect(() => {
    if (!showBubbles || !bubEl.current || !S?.bubbles) return
    if (bubCtl.current && bubCtl.current.el !== bubEl.current) { bubCtl.current.destroy(); bubCtl.current = null }
    if (!bubCtl.current) {
      bubCtl.current = new BubbleChartController(bubEl.current)
      bubCtl.current.onCrosshair = s => setBubLegendSlot(s)
    }
    const reset = bubKey.current !== key
    bubKey.current = key
    bubCtl.current.render(S.bubbles, { offset: settings.boff, bars40: settings.b40, levels: settings.lv }, S.levels, S.bracket,
      { price: S.row.price, direction: S.row.direction, time: S.times.entry }, !!P?.blind, reset, pal)
  }, [S, P?.blind, showBubbles, settings.boff, settings.b40, settings.lv, key, pal, layoutKey])

  useEffect(() => () => { bubCtl.current?.destroy(); bubCtl.current = null }, [showBubbles])

  // keyboard: ← → or [ ] previous / next trade · B Blind / Full · 1 / 5 / 3 / 4 timeframe · H Heiken-Ashi
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.altKey || e.metaKey) return
      const tfMap: Record<string, Tf> = { '1': 1, '5': 5, '3': 30, '4': 240 }
      if (tfMap[e.key]) update({ tf: tfMap[e.key] })
      else if (e.key === 'h' || e.key === 'H') update({ ha: !settings.ha })
      else if (e.key === 'b' || e.key === 'B') setBlind(b => !b)
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
    const B = S?.bubbles; if (!B) return ''
    const n = B.lvl.length
    let x = bubLegendSlot ?? n - 1; if (x < 0 || x >= n) x = n - 1
    const gi = settings.boff ? Math.min(x + 1, n - 1) : x, isLive = gi === n - 1
    const lv = isLive && settings.boff && x === n - 1 ? B.live_lvl : B.lvl[gi]
    return `${fmtTs(B.t[x])}  40T bar  O ${B.o[x].toFixed(2)} H ${B.h[x].toFixed(2)} L ${B.l[x].toFixed(2)} C ${B.c[x].toFixed(2)}\n` +
      `bubble: ${B.dir[gi] > 0 ? 'BUY' : 'SELL'} ${B.vol[gi]} @ ${B.px[gi].toFixed(2)} · ${['small', 'medium', 'large'][lv]}` +
      (isLive && P?.blind ? `  (forming: ${B.live_trades}/40 trades at the fill)` : '')
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
  const res = !blind && selectedId ? results?.[selectedId] : undefined
  const chip = P?.blind
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
  const candleBody = (
    <>
      <div ref={timeEl} className="absolute inset-0" />
      <div className="absolute left-2 top-1.5 z-10 pointer-events-none flex flex-col items-start gap-1 max-w-[calc(100%-96px)]">
        {S && <span className="px-2 py-[3px] rounded-full text-[11.5px] font-medium" style={{ background: chip.bg, color: chip.ink }}>{chip.text}</span>}
        {htfNote && <span className="text-[11px]" style={{ color: pal.legend.text }}>{htfNote}</span>}
        {showLegend && legend && (
          <pre className="m-0 px-1.5 py-0.5 rounded-[3px] font-mono text-[12px] leading-snug overflow-hidden" style={{ background: pal.legend.bg, color: pal.legend.text }}>{legend}</pre>
        )}
      </div>
    </>
  )
  const bubbleBody = S && (
    S.bubbles ? (
      <>
        <div ref={bubEl} className="absolute inset-0" />
        {showBubLegend && (
          <pre className="absolute left-2 top-1.5 z-10 pointer-events-none m-0 px-1.5 py-0.5 rounded-[3px] font-mono text-[12px] leading-snug max-w-[calc(100%-96px)] overflow-hidden" style={{ background: pal.legend.bg, color: pal.legend.text }}>{bubLegend}</pre>
        )}
        {settings.details && (
          <div className="absolute left-2 bottom-7 z-10 pointer-events-none font-mono text-[11px]" style={{ color: pal.bubbles.caption }}>
            40-trade bubbles · lookback {S.bubbles.cfg.lookback} · medium ≥ {S.bubbles.cfg.medium_pct}th pct · large &gt; {S.bubbles.cfg.large_pct}th{S.bubbles.cfg.floor ? ` · ES floor ${S.bubbles.cfg.floor}` : ''} · prints ≥ {S.bubbles.lpt}{settings.boff ? ' · -1 offset' : ''}
          </div>
        )}
      </>
    ) : <p className="p-4 text-[12.5px] text-gray-400">No bubble data for this trade.</p>
  )
  const footprintBody = D && S && (
    <Footprint1m
      m1={P?.blind ? D.m1 : D.m1.slice(0, Math.min(D.m1.length, D.fillIdx + 6))}
      vap={D.vap}
      entry={{ price: S.row.price, entrySec: +S.row.time.slice(6, 8) }}
      fillT={Math.floor(S.times.entry / 60) * 60}
      bracket={{ stop: S.bracket.stop, tp: S.bracket.tp }}
      bars={phone ? Math.min(5, settings.fpN) : settings.fpN} g={G.fp} ratio={settings.fpR} minVol={G.min} palette={fpPal}
    />
  )
  const status = (!have && !!selectedId)
    ? <p className="p-6 text-[13px] text-gray-400">Building the chart as of the fill…</p>
    : have?.error ? <p className="p-6 text-[13px] text-red-400">{have.error}</p> : null

  const settingsPanel = (compact: boolean) => (
    <ChartSettingsPanel s={settings} update={update} inst={inst} ofDefault={usesOrderFlow} colors={colors} onResetAll={resetAll} compact={compact} />
  )
  const weekList = (big: boolean) => (
    <WeekTrades trades={trades} selectedId={selectedId} onSelect={select} blind={blind} results={blind ? null : results} calls={callsMap} week={week} onWeek={goWeek} big={big} />
  )

  // ---------------- phone ----------------
  if (phone) {
    return (
      <div className="flex flex-col -mx-3" style={{ height: 'calc(100dvh - 224px - var(--tabbar-bottom, 0px))', minHeight: 520 }}>
        <div className="h-[60px] flex-none flex items-center gap-2">
          <button type="button" className={cn(iconBtn, 'w-11 h-11 rounded-lg text-gray-100')} aria-label="Previous trade" disabled={!prevId} onClick={() => prevId && select(prevId)}><Chevron left size={16} /></button>
          <div className="flex-1 min-w-0 text-center leading-tight">
            <div className="font-semibold text-[14.5px] tabular-nums text-gray-100 truncate">{day}{time ? ` · ${time}` : ''}</div>
            <div className="font-mono text-[12px] text-gray-400 truncate">{what}{idx >= 0 ? ` · ${idx + 1} of ${trades.length}` : ''}</div>
          </div>
          <button type="button" className={cn(iconBtn, 'w-11 h-11 rounded-lg text-gray-100')} aria-label="Next trade" disabled={!nextId} onClick={() => nextId && select(nextId)}><Chevron size={16} /></button>
        </div>
        <div className="h-12 flex-none flex items-center gap-2">
          <BlindSwitch blind={blind} onChange={setBlind} big />
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
              tab === 'candles' ? candleBody : tab === 'bubbles' ? bubbleBody : footprintBody
            ))}
        </section>
        {selectedId && (
          <CallBar key={`${selectedId}|${blind ? 'b' : 'f'}|${results ? 1 : 0}`} tradeId={selectedId} blind={blind}
            initial={blind ? null : savedCall} onSaved={onSaved} compact />
        )}
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
        {/* trade header: entry-time facts; the result only in Full review */}
        <div className="h-[50px] flex-none flex items-center gap-3.5 border-b min-w-0" style={{ borderColor: 'var(--ts-line)' }}>
          <span className="flex gap-1 flex-none">
            <button type="button" className={iconBtn} aria-label="Previous trade" disabled={!prevId} onClick={() => prevId && select(prevId)}><Chevron left /></button>
            <button type="button" className={iconBtn} aria-label="Next trade" disabled={!nextId} onClick={() => nextId && select(nextId)}><Chevron /></button>
          </span>
          {day && <span className="text-[15px] font-semibold tabular-nums text-gray-100 whitespace-nowrap truncate">{day} · {time} PT · {what}</span>}
          {planLine}
          {resultLine}
          <span className="ml-auto text-[12px] text-gray-400 whitespace-nowrap">{idx >= 0 ? `${idx + 1} of ${trades.length}` : ''}</span>
          <BlindSwitch blind={blind} onChange={setBlind} />
        </div>

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
            {selectedId && (
              <CallBar key={`${selectedId}|${blind ? 'b' : 'f'}|${results ? 1 : 0}`} tradeId={selectedId} blind={blind}
                initial={blind ? null : savedCall} onSaved={onSaved} onNext={nextId ? () => select(nextId) : undefined} />
            )}
          </>
        )}
      </div>

      {/* Full review only: your screenshot and tags */}
      {!blind && settings.yours && selectedId && (
        <aside aria-label="Your trade" className="w-[290px] flex-none border-l overflow-y-auto pl-3.5 py-3 ml-3.5" style={{ borderColor: 'var(--ts-line)' }}>
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-[13.5px] font-semibold text-gray-100">Your trade</span>
            <span className="text-[11.5px] text-gray-400">Full review only</span>
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
