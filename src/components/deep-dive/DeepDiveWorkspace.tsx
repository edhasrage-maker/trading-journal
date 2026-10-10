'use client'

/**
 * Deep Dive Review workspace (read-only, phase 2): one trade, exactly as it
 * looked at the fill.
 *
 * Everything here renders from /api/deep-dive/trade, which cuts the data on the
 * server; in blind mode nothing after the fill second ever reaches the browser.
 * The same route serves the local build (Sierra files) and the hosted site (the
 * published tick tape), so this component doesn't know or care which it is on.
 * Blind off is the same workspace as a deep chart review, run on past the exit.
 *
 * Order flow (40-trade bubbles, 1m footprint) is one switch. It starts ON only
 * when the trader's profile uses order flow; with it off this is a clean
 * price-action workspace — time chart, levels, bracket.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DeepDivePayload } from '@/lib/orderflow/server/deep-dive-payload'
import type { OfRoot } from '@/lib/orderflow/ticks'
import { toBars1m, vapPerBar, buildAgg, atr1m5m, htfToBars, SESSION_4H_OFFSET, type AggBar, type VapRow } from '@/lib/orderflow/bars'
import { volumeProfile, profileWindow, type ProfileWindow } from '@/lib/orderflow/profile'
import { vwap24h, vwapRth, emaOnTf } from '@/lib/orderflow/indicators'
import { TimeChartController, fmtDT, fmtTs, type TimeChartOpts } from './time-chart'
import { BubbleChartController } from './bubble-chart'
import Footprint1m from './Footprint1m'
import { BracketBox, LevelsNearEntry, type NearLevel } from './EntryPanels'
import { PALETTE } from './palette'
import { useTheme, applyTheme } from '@/components/ThemeToggle'

export interface PickerTrade { id: string; entryUtc: string; symbol: string; direction: 'long' | 'short' }
type Payload = DeepDivePayload & { uses_order_flow: boolean }

/** Chart timeframes, in minutes: 1m · 5m · 30m · 4h. */
const TFS = [1, 5, 30, 240] as const
type Tf = (typeof TFS)[number]
const tfLabel = (t: Tf) => (t === 240 ? '4h' : `${t}m`)
/** 30m and 4h run on the 30-minute history, not just the 1m window. */
const isHtf = (t: Tf) => t >= 30

interface Settings {
  tf: Tf; ha: boolean; view: 'both' | 'time' | 'bubble'; boff: boolean; b40: boolean
  prof: ProfileWindow | 'off'; lv: boolean; vwap: boolean; ema: boolean; poc: boolean; dv: boolean
  /** Order-flow master switch. null = follow the profile's default. */
  of: boolean | null
  bubbles: boolean; fp: boolean
  /** Bracket + levels table panel. */
  rail: boolean
  fpN: number; fpR: number
  g: Record<OfRoot, { fp: number; prof: number; min: number }>
}
const DEFAULTS: Settings = {
  tf: 1, ha: false, view: 'both', boff: true, b40: true, prof: 'session', lv: true, vwap: true, ema: true, poc: true, dv: false,
  of: null, bubbles: true, fp: true, rail: false, fpN: 10, fpR: 3,
  g: { NQ: { fp: 4, prof: 4, min: 5 }, ES: { fp: 1, prof: 1, min: 20 } },
}
const SETTINGS_KEY = 'deepdive-settings-v2'

const ptTime = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso))
const rootOf = (symbol: string) => (/^M?NQ/i.test(symbol) ? 'NQ' : /^M?ES/i.test(symbol) ? 'ES' : symbol.slice(0, 3))

const btn = (on: boolean) =>
  `px-2 py-[3px] text-[12px] border rounded-[3px] transition-colors ${on ? 'border-blue-500 text-gray-100 shadow-[inset_0_-2px_0_var(--color-blue-500)]' : 'border-gray-800 text-gray-400 hover:text-gray-100'}`
const sel = 'bg-transparent border border-gray-800 rounded-[3px] px-1 py-[2px]'

export default function DeepDiveWorkspace({
  date, trades, initialId, usesOrderFlow,
}: {
  date: string
  trades: PickerTrade[]
  initialId: string | null
  usesOrderFlow: boolean
}) {
  const router = useRouter()
  // One theme for the whole app: this follows the masthead switch, and the
  // toolbar switch below flips the same setting.
  const theme = useTheme()
  const pal = PALETTE[theme]
  const [selectedId, setSelectedId] = useState<string | null>(initialId)
  const [blind, setBlind] = useState(true)
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [result, setResult] = useState<{ key: string; htf: boolean; payload?: Payload; error?: string; ms?: number } | null>(null)

  // per-browser view settings
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<Settings>
      if (!TFS.includes(saved.tf as Tf)) delete saved.tf
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from localStorage after mount (SSR has no storage)
      setSettings(s => ({ ...s, ...saved, g: { ...s.g, ...(saved.g ?? {}) } }))
    } catch { /* storage unavailable: defaults */ }
  }, [])
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings(s => {
      const next = { ...s, ...patch }
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* not persisted */ }
      return next
    })
  }, [])

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
    const t0 = performance.now()
    fetch(`/api/deep-dive/trade?id=${selectedId}&blind=${blind ? 1 : 0}${wantHtf ? '&htf=1' : ''}`, { cache: 'no-store' })
      .then(async r => {
        const j = await r.json()
        if (!live) return
        if (!r.ok) setResult({ key, htf: wantHtf, error: j.error ?? `HTTP ${r.status}` })
        else setResult({ key, htf: wantHtf || !!(j as Payload).snapshot?.htf, payload: j as Payload, ms: Math.round(performance.now() - t0) })
      })
      .catch(e => { if (live) setResult({ key, htf: wantHtf, error: String(e) }) })
    return () => { live = false }
  }, [selectedId, blind, key, wantHtf, satisfied])

  const select = (id: string) => {
    setSelectedId(id)
    router.replace(`/review/deep-dive?id=${id}`, { scroll: false })
  }
  const idx = trades.findIndex(t => t.id === selectedId)

  const P = have?.payload
  const S = P?.snapshot
  const inst = (P?.trade.inst ?? 'NQ') as OfRoot
  const G = settings.g[inst]
  const ofOn = settings.of ?? usesOrderFlow
  const bubblesOn = ofOn && settings.bubbles
  const showBubbles = bubblesOn && settings.view !== 'time'
  const showTime = !(bubblesOn && settings.view === 'bubble')
  const showFp = ofOn && settings.fp
  const htfChart = isHtf(settings.tf)

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
    // the container remounts while the next trade loads: rebuild on a new element
    if (timeCtl.current && timeCtl.current.el !== timeEl.current) { timeCtl.current.destroy(); timeCtl.current = null }
    if (!timeCtl.current) {
      timeCtl.current = new TimeChartController(timeEl.current, { ...timeOpts, palette: pal })
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
    }, { ...timeOpts, palette: pal }, resetView)
  }, [D, S, P?.exits, agg, fillAt, htfChart, profile, timeOpts, pal, showTime, key, settings.tf])

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
  }, [S, P?.blind, showBubbles, settings.boff, settings.b40, settings.lv, key, pal])

  useEffect(() => () => { bubCtl.current?.destroy(); bubCtl.current = null }, [showBubbles])

  // keyboard: 1 = 1m · 5 = 5m · 3 = 30m · 4 = 4h · H Heiken-Ashi · [ ] previous / next trade
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.altKey || e.metaKey) return
      const tfMap: Record<string, Tf> = { '1': 1, '5': 5, '3': 30, '4': 240 }
      if (tfMap[e.key]) update({ tf: tfMap[e.key] })
      else if (e.key === 'h' || e.key === 'H') update({ ha: !settings.ha })
      else if (e.key === '[' && idx > 0) select(trades[idx - 1].id)
      else if (e.key === ']' && idx >= 0 && idx < trades.length - 1) select(trades[idx + 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- legends ----
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

  // ---- render ----
  const r = S?.row
  const B = S?.bracket
  const rr = B && B.stop != null && B.tp != null && r ? Math.abs(B.tp - r.price) / Math.abs(r.price - B.stop) : null
  return (
    <div className="flex flex-col -mt-2" style={{ height: 'calc(100vh - 150px)', minHeight: 640 }}>
      {/* header: picker + trade facts (entry-time facts only) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-2 border-b" style={{ borderColor: 'var(--ts-line)' }}>
        <input
          type="date" defaultValue={date} aria-label="session date"
          className="bg-transparent border rounded-[3px] px-2 py-[3px] text-[12px] text-gray-300 border-gray-800"
          onChange={e => e.target.value && router.push(`/review/deep-dive?date=${e.target.value}`)}
        />
        <div className="flex flex-wrap gap-1 max-w-[46%]">
          {trades.length === 0 && <span className="text-[12px] text-gray-500">No trades on this day.</span>}
          {trades.map(t => (
            <button key={t.id} onClick={() => select(t.id)} className={btn(t.id === selectedId)} title={t.symbol}>
              <span className="tabular-nums">{ptTime(t.entryUtc)}</span> {rootOf(t.symbol)} {t.direction === 'long' ? 'L' : 'S'}
            </button>
          ))}
        </div>
        {r && (
          <div className="text-[15px] font-semibold tabular-nums text-gray-100">
            {r.weekday} {r.date} · {r.time} PT · {r.inst} ·{' '}
            <span className={r.direction === 'long' ? 'text-green-400' : 'text-red-400'}>{r.direction === 'long' ? 'LONG' : 'SHORT'}</span>
            {' '}@ {r.price.toFixed(2)}
          </div>
        )}
        {/* the planned bracket in one line; the full breakdown is in the Levels panel */}
        {B && (B.stop != null || B.tp != null) && (
          <div className="text-[12px] tabular-nums text-gray-400">
            {B.stop != null && <>stop <span className="text-red-400">{B.stop.toFixed(2)}</span>{B.stop_src === 'assumed' ? ' (assumed)' : ''}</>}
            {B.stop != null && B.tp != null && ' · '}
            {B.tp != null && <>TP <span className="text-green-400">{B.tp.toFixed(2)}</span>{B.tp_src === 'assumed' ? ' (assumed)' : ''}</>}
            {rr != null && <> · {rr.toFixed(2)}R</>}
          </div>
        )}
        {S && (
          <div className="text-[12px] tabular-nums" style={{ color: '#ff9f1a' }}>
            {P?.blind
              ? (S.has_partial ? `chart ends ${S.cutoff_label} (last bar is partial, up to the fill)` : `chart ends ${S.cutoff_label} (fill at the start of the next minute)`)
              : 'full review: data runs past the exit'}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {P && <span className="text-[11px] tabular-nums" style={{ color: 'var(--ts-faint)' }}>loaded {have?.ms} ms · built {P.build_ms} ms</span>}
          <span className="flex items-center gap-1 pr-2 mr-1 border-r" style={{ borderColor: 'var(--ts-line)' }}>
            <button className={btn(theme === 'light')} onClick={() => applyTheme('light')}>Light</button>
            <button className={btn(theme === 'dark')} onClick={() => applyTheme('dark')}>Dark</button>
          </span>
          <button className={btn(blind)} onClick={() => setBlind(true)}>Blind</button>
          <button className={btn(!blind)} onClick={() => setBlind(false)} title="Shows what happened after the entry">Full review</button>
        </div>
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 border-b text-[12px] text-gray-400" style={{ borderColor: 'var(--ts-line)' }}>
        <span className="flex items-center gap-1">TF {TFS.map(t => <button key={t} className={btn(settings.tf === t)} onClick={() => update({ tf: t })}>{tfLabel(t)}</button>)}</span>
        <button className={btn(settings.ha)} onClick={() => update({ ha: !settings.ha })}>Heiken-Ashi</button>
        <span className="flex items-center gap-1">
          <button className={btn(settings.lv)} onClick={() => update({ lv: !settings.lv })}>Levels</button>
          {!htfChart && <>
            <button className={btn(settings.vwap)} onClick={() => update({ vwap: !settings.vwap })}>VWAP</button>
            <button className={btn(settings.ema)} onClick={() => update({ ema: !settings.ema })}>EMA 9/20 (5m)</button>
            <button className={btn(settings.poc)} onClick={() => update({ poc: !settings.poc })}>Bar POC</button>
          </>}
          <button className={btn(settings.dv)} onClick={() => update({ dv: !settings.dv })}>Delta / Vol panes</button>
        </span>
        <span className="flex items-center gap-1">Profile
          <select className={sel} value={settings.prof} onChange={e => update({ prof: e.target.value as Settings['prof'] })}>
            <option value="session">session (dev)</option><option value="on">overnight</option><option value="prior">prior RTH</option><option value="off">off</option>
          </select>
          <select className={sel} value={G.prof} title="profile row size (ticks)"
            onChange={e => update({ g: { ...settings.g, [inst]: { ...G, prof: +e.target.value } } })}>
            {[1, 2, 4, 8, 16].map(x => <option key={x} value={x}>{x}t</option>)}
          </select>
        </span>
        <span className="flex items-center gap-1 pl-2 border-l" style={{ borderColor: 'var(--ts-line)' }}>
          <button className={btn(ofOn)} onClick={() => update({ of: !ofOn })} title="Bubble chart and footprint. Turn off for a price-action-only workspace.">Order flow</button>
          {ofOn && <>
            <button className={btn(settings.bubbles)} onClick={() => update({ bubbles: !settings.bubbles })}>40T bubbles</button>
            <button className={btn(settings.fp)} onClick={() => update({ fp: !settings.fp })}>Footprint</button>
            {bubblesOn && <>
              <select className={sel} value={settings.view} onChange={e => update({ view: e.target.value as Settings['view'] })}>
                <option value="both">time + bubbles</option><option value="time">time only</option><option value="bubble">bubbles only</option>
              </select>
              <button className={btn(settings.boff)} onClick={() => update({ boff: !settings.boff })} title="Your study draws each bubble one bar to the left (Historical Horizontal Offset = -1)">-1 offset</button>
              <button className={btn(settings.b40)} onClick={() => update({ b40: !settings.b40 })} title="Show the 40-trade bars behind the bubbles">40T bars</button>
            </>}
          </>}
        </span>
        <button className={`${btn(settings.rail)} ml-auto`} onClick={() => update({ rail: !settings.rail })} title="Planned bracket detail and every level near the entry, sorted by distance">
          Levels panel
        </button>
      </div>

      {!have && !!selectedId && <p className="p-6 text-[13px] text-gray-400">Building the chart as of the fill…</p>}
      {have?.error && <p className="p-6 text-[13px] text-red-400">{have.error}</p>}

      {D && S && (
        <div className="flex flex-1 min-h-0">
          <section className="flex-1 min-w-0 flex flex-col">
            <div className="flex flex-1 min-h-[220px]">
              {showTime && (
                <div className="relative flex-1 min-w-0">
                  <div ref={timeEl} className="absolute inset-0" />
                  <pre className="absolute left-2 top-1.5 z-10 pointer-events-none m-0 px-1.5 py-0.5 rounded-[3px] font-mono text-[12px] leading-snug" style={{ background: pal.legend.bg, color: pal.legend.text }}>
                    {legend}{htfChart && !satisfied ? `\nloading ${tfLabel(settings.tf)} history…` : htfChart && D.hist.length === 0 ? '\nno earlier history available for this date' : ''}
                  </pre>
                </div>
              )}
              {showBubbles && S.bubbles && (
                <div className="relative flex-1 min-w-0 border-l" style={{ borderColor: pal.chart.border, background: pal.chart.bg }}>
                  <div ref={bubEl} className="absolute inset-0" />
                  <pre className="absolute left-2 top-1.5 z-10 pointer-events-none m-0 px-1.5 py-0.5 rounded-[3px] font-mono text-[12px] leading-snug" style={{ background: pal.legend.bg, color: pal.legend.text }}>{bubLegend}</pre>
                  <div className="absolute left-2 bottom-7 z-10 pointer-events-none font-mono text-[11px]" style={{ color: pal.bubbles.caption }}>
                    40-trade bubbles · lookback {S.bubbles.cfg.lookback} · medium ≥ {S.bubbles.cfg.medium_pct}th pct · large &gt; {S.bubbles.cfg.large_pct}th{S.bubbles.cfg.floor ? ` · ES floor ${S.bubbles.cfg.floor}` : ''} · prints ≥ {S.bubbles.lpt}{settings.boff ? ' · -1 offset' : ''}
                  </div>
                </div>
              )}
            </div>
            {showFp && (
              <div className="flex flex-col border-t" style={{ height: '38%', minHeight: 170, borderColor: 'var(--ts-line)' }}>
                <div className="flex flex-wrap items-center gap-2 px-2 py-1 border-b text-[12px] text-gray-400" style={{ borderColor: 'var(--ts-line)' }}>
                  <span>Footprint 1m · last</span>
                  <select className={sel} value={settings.fpN} onChange={e => update({ fpN: +e.target.value })}>{[4, 6, 8, 10, 12, 15].map(x => <option key={x}>{x}</option>)}</select>
                  <span>bars · rows</span>
                  <select className={sel} value={G.fp} onChange={e => update({ g: { ...settings.g, [inst]: { ...G, fp: +e.target.value } } })}>{[1, 2, 4, 8].map(x => <option key={x}>{x}</option>)}</select>
                  <span>ticks · imbalance</span>
                  <select className={sel} value={settings.fpR} onChange={e => update({ fpR: +e.target.value })}>{[2, 2.5, 3, 4].map(x => <option key={x} value={x}>{x * 100}%</option>)}</select>
                  <span>min vol</span>
                  <select className={sel} value={G.min} onChange={e => update({ g: { ...settings.g, [inst]: { ...G, min: +e.target.value } } })}>{[1, 3, 5, 10, 20, 40].map(x => <option key={x}>{x}</option>)}</select>
                  <span className="text-[11px]" style={{ color: 'var(--ts-faint)' }}>side bars = 3+ stacked imbalances · yellow = bar POC · orange = entry · dashed = stop / TP · VPS bold at 2×/3×/4× the prior-10 median</span>
                </div>
                <div className="flex-1 min-h-0" style={{ background: pal.chart.bg }}>
                  <Footprint1m
                    m1={P?.blind ? D.m1 : D.m1.slice(0, Math.min(D.m1.length, D.fillIdx + 6))}
                    vap={D.vap}
                    entry={{ price: S.row.price, entrySec: +S.row.time.slice(6, 8) }}
                    bracket={{ stop: S.bracket.stop, tp: S.bracket.tp }}
                    bars={settings.fpN} g={G.fp} ratio={settings.fpR} minVol={G.min} palette={pal.footprint}
                  />
                </div>
              </div>
            )}
          </section>
          {settings.rail && (
            <aside className="w-[380px] flex-none border-l overflow-y-auto px-3 py-3 space-y-4" style={{ borderColor: 'var(--ts-line)' }}>
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
      )}
    </div>
  )
}
