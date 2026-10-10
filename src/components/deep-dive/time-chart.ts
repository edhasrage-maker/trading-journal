/**
 * Deep Dive time chart — lightweight-charts v5, imperative. Port of the blind
 * re-tag viewer's chart (buildChart / setSeries / makeLines / Overlay):
 * candles or Heiken-Ashi on 1/2/3/5/15m, TapeScore VWAP + 9/20 EMA, levels as
 * of the fill, the planned bracket, a session / overnight / prior-RTH volume
 * profile on the right edge, per-bar POC ticks and session separators.
 *
 * Times are PT-clock epoch seconds (PT wall clock "as if UTC"), so the axis
 * reads Pacific time with no timezone work here.
 */
import {
  createChart, createSeriesMarkers, CandlestickSeries, LineSeries, HistogramSeries, CrosshairMode,
  type IChartApi, type ISeriesApi, type SeriesType, type ISeriesPrimitive, type SeriesAttachedParameter,
  type Time, type UTCTimestamp, type IPriceLine, type ISeriesMarkersPluginApi, type Logical,
  type IPrimitivePaneView, type IPrimitivePaneRenderer, type SeriesMarker,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { AggBar } from '@/lib/orderflow/bars'
import type { VolumeProfile } from '@/lib/orderflow/profile'
import type { Level } from '@/lib/orderflow/levels'
import type { PlannedBracket } from '@/lib/orderflow/bracket'
import type { DeepDivePalette } from './palette'

const pad = (n: number) => String(n).padStart(2, '0')
export const fmtT = (t: number) => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` }
export const fmtTs = (t: number) => { const d = new Date(t * 1000); return `${fmtT(t)}:${pad(d.getUTCSeconds())}` }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const fmtDT = (t: number) => { const d = new Date(t * 1000); return `${DOW[d.getUTCDay()]} ${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${fmtT(t)}` }

export const LEVEL_COLORS: Record<string, { dark: string; light: string }> = {
  pd: { dark: '#5c9cff', light: '#2f6fd6' }, on: { dark: '#b39ddb', light: '#7e57c2' },
  open: { dark: '#f5f5f5', light: '#555555' }, ib: { dark: '#ffd54f', light: '#c79a00' },
  ibx: { dark: 'rgba(255,213,79,.5)', light: 'rgba(199,154,0,.5)' }, wk: { dark: '#26a6b8', light: '#1f8a99' },
  pw: { dark: '#7986cb', light: '#5c6bc0' }, pva: { dark: '#e05a90', light: '#c2185b' },
}

export function bracketLabel(src: 'recorded' | 'assumed', leg: 'stop' | 'tp', b: PlannedBracket) {
  if (src === 'recorded') return leg === 'stop' ? 'STOP' : 'TP'
  return leg === 'stop' ? `STOP (assumed ${b.atr_stop_mult} ATR)` : `TP (assumed ${b.tp_r_mult}R)`
}

/** Price lines shared by the time chart and the bubble chart. */
export function addPriceLines(
  ser: ISeriesApi<SeriesType>, levels: Level[], showLevels: boolean, bracket: PlannedBracket,
  entry: { price: number; direction: 'long' | 'short' }, light: boolean,
): IPriceLine[] {
  const out: IPriceLine[] = []
  if (showLevels) for (const l of levels) {
    const c = LEVEL_COLORS[l.group] ?? { dark: '#999', light: '#777' }
    out.push(ser.createPriceLine({
      price: l.price, color: light ? c.light : c.dark, lineWidth: 1, lineStyle: l.dev || l.group === 'ibx' ? 1 : 2,
      axisLabelVisible: true, title: l.name + (l.dev ? ' dev' : ''),
    }))
  }
  if (bracket.stop != null) out.push(ser.createPriceLine({
    price: bracket.stop, color: '#ef5350', lineWidth: 2, lineStyle: bracket.stop_src === 'recorded' ? 0 : 2,
    axisLabelVisible: true, title: bracketLabel(bracket.stop_src, 'stop', bracket),
  }))
  if (bracket.tp != null) out.push(ser.createPriceLine({
    price: bracket.tp, color: '#26a69a', lineWidth: 2, lineStyle: bracket.tp_src === 'recorded' ? 0 : 2,
    axisLabelVisible: true, title: bracketLabel(bracket.tp_src, 'tp', bracket),
  }))
  out.push(ser.createPriceLine({
    price: entry.price, color: '#ff9f1a', lineWidth: 1, lineStyle: 0, axisLabelVisible: true,
    title: `ENTRY ${entry.direction === 'long' ? 'L' : 'S'}`,
  }))
  return out
}

class TimeOverlay implements ISeriesPrimitive<Time> {
  agg: AggBar[] = []
  profile: VolumeProfile | null = null
  showPoc = true
  pocColor = '#ffd23f'
  private requestUpdate: (() => void) | null = null
  constructor(private chart: IChartApi, private series: ISeriesApi<SeriesType>) {}
  attached(p: SeriesAttachedParameter<Time>) { this.requestUpdate = p.requestUpdate }
  detached() { this.requestUpdate = null }
  updateAllViews() {}
  update() { this.requestUpdate?.() }
  paneViews(): readonly IPrimitivePaneView[] {
    const renderer: IPrimitivePaneRenderer = {
      draw: t => this.drawTop(t),
      drawBackground: t => this.drawBackground(t),
    }
    return [{ zOrder: () => 'top', renderer: () => renderer }]
  }
  private spacing() {
    const ts = this.chart.timeScale()
    return Math.abs((ts.logicalToCoordinate(1 as Logical) ?? 0) - (ts.logicalToCoordinate(0 as Logical) ?? 0)) || 6
  }
  private drawBackground(target: CanvasRenderingTarget2D) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: sz }) => {
      const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(); if (!r) return
      const sp = this.spacing()
      ctx.save(); ctx.setLineDash([3, 4]); ctx.lineWidth = 1
      for (let i = Math.max(1, Math.floor(r.from)); i <= Math.min(this.agg.length - 1, Math.ceil(r.to)); i++) {
        const b = this.agg[i]; if (!b.mark) continue
        const x = (ts.logicalToCoordinate(i as Logical) ?? 0) - sp / 2
        ctx.strokeStyle = b.mark === 'rth' ? 'rgba(61,123,224,.55)' : 'rgba(140,150,165,.35)'
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, sz.height); ctx.stroke()
      }
      ctx.restore()
      const P = this.profile; if (!P) return
      const W = Math.min(150, sz.width * 0.2), xR = sz.width - 2
      for (let j = 0; j < P.keys.length; j++) {
        if (!P.vols[j]) continue
        const yTop = this.series.priceToCoordinate((P.keys[j] + P.g) / 4), yBot = this.series.priceToCoordinate(P.keys[j] / 4)
        if (yTop == null || yBot == null) continue
        const h = Math.max(1, yBot - yTop - (yBot - yTop > 3 ? 1 : 0)), len = P.vols[j] / P.max * W
        ctx.fillStyle = j === P.poc ? 'rgba(255,170,60,.75)' : (j >= P.lo && j <= P.hi ? 'rgba(120,140,165,.42)' : 'rgba(120,140,165,.2)')
        ctx.fillRect(xR - len, yTop, len, h)
      }
    })
  }
  private drawTop(target: CanvasRenderingTarget2D) {
    if (!this.showPoc) return
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(); if (!r) return
      const sp = this.spacing(), w = Math.max(3, sp * 0.9)
      ctx.strokeStyle = this.pocColor; ctx.lineWidth = 1.5
      for (let i = Math.max(0, Math.floor(r.from)); i <= Math.min(this.agg.length - 1, Math.ceil(r.to)); i++) {
        const b = this.agg[i]; if (b.poc == null) continue
        const x = ts.logicalToCoordinate(i as Logical), y = this.series.priceToCoordinate(b.poc)
        if (x == null || y == null) continue
        ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x + w / 2, y); ctx.stroke()
      }
    })
  }
}

export interface TimeChartData {
  agg: AggBar[]
  /** Per-agg-bar line values (null = no point). */
  vwap: (number | null)[]; rvwap: (number | null)[]; ema9: (number | null)[]; ema20: (number | null)[]
  profile: VolumeProfile | null
  levels: Level[]
  bracket: PlannedBracket
  entry: { price: number; direction: 'long' | 'short'; time: number; label: string }
  exits: { time: number; price: number }[]
  /** Index of the agg bar holding the fill. */
  entryIndex: number
}

export interface TimeChartOpts {
  ha: boolean; levels: boolean; vwap: boolean; ema: boolean; poc: boolean; deltaVol: boolean
  palette: DeepDivePalette
}

export class TimeChartController {
  private chart: IChartApi
  private candles: ISeriesApi<'Candlestick'>
  private lines: Record<'vwap' | 'rvwap' | 'ema9' | 'ema20', ISeriesApi<'Line'>>
  private delta: ISeriesApi<'Histogram'> | null = null
  private vol: ISeriesApi<'Histogram'> | null = null
  private overlay: TimeOverlay
  private markers: ISeriesMarkersPluginApi<Time>
  private priceLines: IPriceLine[] = []
  private data: TimeChartData | null = null
  onCrosshair: ((i: number | null) => void) | null = null

  constructor(readonly el: HTMLElement, private opts: TimeChartOpts) {
    this.chart = createChart(el, {
      autoSize: true,
      layout: { fontSize: 11 },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 18 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: (t: Time) => fmtDT(t as number), priceFormatter: (p: number) => p.toFixed(2) },
    })
    const pf = { type: 'price' as const, precision: 2, minMove: 0.25 }
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      priceFormat: pf, priceLineVisible: false,
    })
    const line = (color: string, lineWidth: 1 | 2 = 1, lineStyle = 0) => this.chart.addSeries(LineSeries, {
      color, lineWidth, lineStyle, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => null, priceFormat: pf,
    })
    const P = opts.palette
    this.lines = { vwap: line(P.vwap, 2), rvwap: line(P.rvwap, 1, 2), ema9: line(P.ema9), ema20: line(P.ema20) }
    this.overlay = new TimeOverlay(this.chart, this.candles)
    this.candles.attachPrimitive(this.overlay)
    this.markers = createSeriesMarkers(this.candles, [])
    this.chart.subscribeCrosshairMove(p => this.onCrosshair?.(p && p.logical != null ? Math.round(p.logical) : null))
    this.setPanes(opts.deltaVol)
    this.applyPalette(opts.palette)
  }

  /** Theme colours — applied in place, so a theme switch repaints without a rebuild. */
  private applyPalette(P: DeepDivePalette) {
    const c = P.chart
    this.chart.applyOptions({
      layout: { background: { color: c.bg }, textColor: c.text, panes: { separatorColor: c.border } },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    })
    this.lines.vwap.applyOptions({ color: P.vwap }); this.lines.rvwap.applyOptions({ color: P.rvwap })
    this.lines.ema9.applyOptions({ color: P.ema9 }); this.lines.ema20.applyOptions({ color: P.ema20 })
    this.overlay.pocColor = P.barPoc
  }

  private setPanes(on: boolean) {
    if (on && !this.delta) {
      this.delta = this.chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, base: 0 }, 1)
      this.vol = this.chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, color: 'rgba(120,140,165,.55)' }, 2)
      try { const ps = this.chart.panes(); ps[1]?.setHeight(110); ps[2]?.setHeight(64) } catch { /* pane sizing is cosmetic */ }
    } else if (!on && this.delta) {
      this.chart.removeSeries(this.delta); if (this.vol) this.chart.removeSeries(this.vol)
      this.delta = this.vol = null
      try { while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1) } catch { /* already gone */ }
    }
  }

  render(data: TimeChartData, opts: TimeChartOpts, resetView: boolean) {
    this.data = data; this.opts = opts
    this.setPanes(opts.deltaVol)
    this.applyPalette(opts.palette)
    const A = data.agg, ts = (t: number) => t as UTCTimestamp
    this.candles.setData(A.map(b => (opts.ha
      ? { time: ts(b.t), open: b.ho, high: b.hh, low: b.hl, close: b.hc }
      : { time: ts(b.t), open: b.o, high: b.h, low: b.l, close: b.c })))
    const series = (vals: (number | null)[], on: boolean) => (on ? A.flatMap((b, i) => (vals[i] == null ? [] : [{ time: ts(b.t), value: vals[i] as number }])) : [])
    this.lines.vwap.setData(series(data.vwap, opts.vwap))
    this.lines.rvwap.setData(series(data.rvwap, opts.vwap))
    this.lines.ema9.setData(series(data.ema9, opts.ema))
    this.lines.ema20.setData(series(data.ema20, opts.ema))
    this.delta?.setData(A.map(b => ({ time: ts(b.t), value: b.d, color: b.partial ? (b.d >= 0 ? 'rgba(47,191,143,.5)' : 'rgba(239,91,91,.5)') : (b.d >= 0 ? '#2fbf8f' : '#ef5b5b') })))
    this.vol?.setData(A.map(b => ({ time: ts(b.t), value: b.v, color: b.partial ? 'rgba(255,159,26,.6)' : 'rgba(120,140,165,.55)' })))
    this.priceLines.forEach(l => this.candles.removePriceLine(l))
    this.priceLines = addPriceLines(this.candles, data.levels, opts.levels, data.bracket, data.entry, opts.palette.levels === 'light')
    const long = data.entry.direction === 'long'
    const mk: SeriesMarker<Time>[] = []
    const eb = A[data.entryIndex]
    if (eb) mk.push({ time: ts(eb.t), position: long ? 'belowBar' : 'aboveBar', color: '#ff9f1a', shape: long ? 'arrowUp' : 'arrowDown', text: data.entry.label })
    for (const x of data.exits) {
      const k = A.findIndex((b, i) => b.t <= x.time && (i === A.length - 1 || A[i + 1].t > x.time))
      if (k >= 0) mk.push({ time: ts(A[k].t), position: long ? 'aboveBar' : 'belowBar', color: opts.palette.exitMarker, shape: long ? 'arrowDown' : 'arrowUp', text: `exit ${x.price.toFixed(2)}` })
    }
    mk.sort((a, b) => (a.time as number) - (b.time as number))
    this.markers.setMarkers(mk)
    this.overlay.agg = A
    this.overlay.profile = data.profile
    this.overlay.showPoc = opts.poc
    this.overlay.update()
    if (resetView) {
      // blind: the fill bar is the last bar; full review: keep the fill in view with the aftermath to its right
      const n = A.length, focus = Math.min(n - 1, data.entryIndex + 60), show = Math.min(n, 150)
      const apply = () => this.chart.timeScale().setVisibleLogicalRange({ from: focus - show + 1, to: focus + 18 })
      // after the library's own first-frame auto-fit, or it gets clobbered
      apply(); requestAnimationFrame(() => requestAnimationFrame(apply))
    }
  }

  get bars() { return this.data?.agg ?? [] }
  destroy() { this.chart.remove() }
}
