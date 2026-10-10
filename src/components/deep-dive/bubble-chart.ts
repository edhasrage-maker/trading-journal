/**
 * 40-trade bubble chart panel — port of the blind re-tag viewer's
 * BubbleOverlay / buildBubbleChart(), drawing the founder's Sierra Delta Heat
 * Map study. Light theme = Sierra's white panel with the study's exact colours;
 * dark theme = carbon with re-toned bubbles (palette.ts).
 *
 * Each 40T bar is one logical slot; bubble j is drawn at slot j-1 when the -1
 * offset is on (the study's Historical Horizontal Offset Bars = -1), and the
 * live bubble is previewed at the last slot. Large prints are hollow rings the
 * size of that bar's bubble with the volume on a white label (newest 300).
 */
import {
  createChart, createSeriesMarkers, CandlestickSeries, CrosshairMode,
  type IChartApi, type ISeriesApi, type ISeriesPrimitive, type SeriesAttachedParameter, type Time,
  type UTCTimestamp, type Logical, type IPrimitivePaneView, type IPrimitivePaneRenderer, type IPriceLine,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { BubbleChart } from '@/lib/orderflow/bubbles40t'
import type { Level } from '@/lib/orderflow/levels'
import type { PlannedBracket } from '@/lib/orderflow/bracket'
import { addPriceLines, fmtT, fmtTs } from './time-chart'
import { PALETTE, type DeepDivePalette } from './palette'
const T0 = 1e9
const slotTime = (j: number) => (T0 + j * 60) as UTCTimestamp
const slotOf = (t: number) => Math.round((t - T0) / 60)

class BubbleOverlay implements ISeriesPrimitive<Time> {
  B: BubbleChart | null = null
  offset = true
  /** Draw the live (forming) bubble preview at the last slot. */
  live = true
  colors: DeepDivePalette['bubbles'] = PALETTE.light.bubbles
  private requestUpdate: (() => void) | null = null
  constructor(private chart: IChartApi, private series: ISeriesApi<'Candlestick'>) {}
  attached(p: SeriesAttachedParameter<Time>) { this.requestUpdate = p.requestUpdate }
  detached() { this.requestUpdate = null }
  updateAllViews() {}
  update() { this.requestUpdate?.() }
  paneViews(): readonly IPrimitivePaneView[] {
    const renderer: IPrimitivePaneRenderer = { draw: t => this.draw(t) }
    return [{ zOrder: () => 'top', renderer: () => renderer }]
  }
  private draw(target: CanvasRenderingTarget2D) {
    const B = this.B; if (!B) return
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(); if (!r) return
      const n = B.lvl.length, off = this.offset ? -1 : 0, i0 = Math.floor(r.from) - 2, i1 = Math.ceil(r.to) + 2
      const C = this.colors
      const dots: [number, number, number, 1 | -1][] = []
      for (let j = 0; j < n; j++) { const x = j + off; if (x < 0 || x < i0 || x > i1) continue; dots.push([x, B.px[j], B.lvl[j], B.dir[j]]) }
      if (off !== 0 && this.live) dots.push([n - 1, B.px[n - 1], B.live_lvl, B.dir[n - 1]])
      for (const [x, p, lv, dr] of dots) {
        const X = ts.logicalToCoordinate(x as Logical), Y = this.series.priceToCoordinate(p)
        if (X == null || Y == null) continue
        ctx.beginPath(); ctx.arc(X, Y, B.sizes[lv] / 2, 0, 2 * Math.PI); ctx.fillStyle = (dr > 0 ? C.buy : C.sell)[lv]; ctx.fill()
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 12px Consolas, monospace'
      for (const m of B.marks.slice(-300)) {
        const j = m.g - B.first, x = j + off
        if (x < 0 || x < i0 || x > i1) continue
        const X = ts.logicalToCoordinate(x as Logical), Y = this.series.priceToCoordinate(m.px)
        if (X == null || Y == null) continue
        const size = j >= 0 && j < n ? B.sizes[B.lvl[j]] : 12
        ctx.beginPath(); ctx.arc(X, Y, size / 2, 0, 2 * Math.PI); ctx.lineWidth = 2
        ctx.strokeStyle = m.side > 0 ? C.ringBuy : C.ringSell; ctx.stroke()
        const txt = String(m.vol), w = ctx.measureText(txt).width
        ctx.fillStyle = C.labelBg; ctx.fillRect(X - w / 2 - 3, Y - 8, w + 6, 16)
        ctx.fillStyle = m.side > 0 ? C.labelBuy : C.labelSell; ctx.fillText(txt, X, Y)
      }
    })
  }
}

export interface BubbleChartOpts { offset: boolean; bars40: boolean; levels: boolean }

export class BubbleChartController {
  private chart: IChartApi
  private bars: ISeriesApi<'Candlestick'>
  private overlay: BubbleOverlay
  private priceLines: IPriceLine[] = []
  private markers
  B: BubbleChart | null = null
  onCrosshair: ((slot: number | null) => void) | null = null

  constructor(readonly el: HTMLElement) {
    this.chart = createChart(el, {
      autoSize: true,
      layout: { fontSize: 11 },
      timeScale: {
        rightOffset: 8,
        tickMarkFormatter: (t: Time) => { const j = slotOf(t as number); return this.B && j >= 0 && j < this.B.t.length ? fmtT(this.B.t[j]) : '' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (t: Time) => { const j = slotOf(t as number); return this.B && j >= 0 && j < this.B.t.length ? fmtTs(this.B.t[j]) : '' },
        priceFormatter: (p: number) => p.toFixed(2),
      },
    })
    this.bars = this.chart.addSeries(CandlestickSeries, {
      borderVisible: false, priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
    })
    this.overlay = new BubbleOverlay(this.chart, this.bars)
    this.bars.attachPrimitive(this.overlay)
    this.markers = createSeriesMarkers(this.bars, [])
    this.chart.subscribeCrosshairMove(p => this.onCrosshair?.(p && p.logical != null ? Math.round(p.logical) : null))
  }

  render(
    B: BubbleChart, opts: BubbleChartOpts, levels: Level[], bracket: PlannedBracket,
    entry: { price: number; direction: 'long' | 'short'; time: number }, live: boolean, resetView: boolean,
    palette: DeepDivePalette,
  ) {
    this.B = B
    const c = palette.chart
    this.chart.applyOptions({
      layout: { background: { color: c.bg }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    })
    this.overlay.colors = palette.bubbles
    const fade = opts.bars40 ? palette.bubbles.bars40 : 'rgba(0,0,0,0)'
    this.bars.applyOptions({ upColor: fade, downColor: fade, wickUpColor: fade, wickDownColor: fade })
    this.bars.setData(B.o.map((o, j) => ({ time: slotTime(j), open: o, high: B.h[j], low: B.l[j], close: B.c[j] })))
    this.priceLines.forEach(l => this.bars.removePriceLine(l))
    this.priceLines = addPriceLines(this.bars, levels, opts.levels, bracket, entry, palette.levels === 'light')
    // the fill: the first 40T bar that ends at/after it (the live bar when blind)
    let k = B.t.findIndex(t => t >= entry.time)
    if (k < 0) k = B.t.length - 1
    const long = entry.direction === 'long'
    this.markers.setMarkers([{ time: slotTime(k), position: long ? 'belowBar' : 'aboveBar', color: '#ff7a00', shape: long ? 'arrowUp' : 'arrowDown', text: 'fill' }])
    this.overlay.B = B; this.overlay.offset = opts.offset; this.overlay.live = live
    this.overlay.update()
    if (resetView) {
      const n = B.t.length, focus = Math.min(n - 1, k + 60)
      const apply = () => this.chart.timeScale().setVisibleLogicalRange({ from: focus - 200, to: focus + 8 })
      apply(); requestAnimationFrame(() => requestAnimationFrame(apply))
    }
  }
  destroy() { this.chart.remove() }
}
