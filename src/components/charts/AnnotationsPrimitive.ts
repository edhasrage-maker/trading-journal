/**
 * lightweight-charts v5 series primitive that renders user chart annotations:
 * ZONES (price×time rectangles) and TEXT labels. Same extension mechanism as
 * TradeArrowsPrimitive; add levels/lines/arrows to the kind switch later.
 *
 * Anchors are (time, price): timeToCoordinate / priceToCoordinate map them to
 * pixels each redraw, so a drawing stays pinned to its price/time on zoom/pan.
 * A live drag-preview renders dashed until the user releases.
 */
import type {
  ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder, SeriesAttachedParameter, IChartApi,
  ISeriesApi, SeriesType, Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'

/** Zone = two opposite corners; text = a single anchor point. Both carry epoch
 *  seconds (t) + price (p); a loose shape keeps per-kind reads simple. */
export interface AnnGeom { t1?: number; p1?: number; t2?: number; p2?: number; t?: number; p?: number; size?: number }
export interface ZoneGeom { t1: number; p1: number; t2: number; p2: number }

export interface ChartAnnotation {
  id: string
  kind: 'zone' | 'level' | 'trendline' | 'arrow' | 'text'
  geom: AnnGeom
  note: string
  color: string
  selected?: boolean
}

/**
 * A trade "highlight" — the P&L and execution score chip pinned above a trade's
 * entry arrow. Deliberately just those two numbers: the point is a chart someone
 * ELSE can read at a glance (a screenshot, a screen-share, a shared link), and
 * anything more turns a callout into a table.
 */
export interface TradeHighlight {
  tradeId: string
  /** Anchor — the trade's entry (epoch seconds on the chart's display scale). */
  t: number
  p: number
  /** Left half of the chip, e.g. "+$248". */
  pnl: string
  /** Right half, e.g. "86%". Omitted when the day hasn't been scored per-trade. */
  score?: string
  /** Drives the chip's accent: green for a winner, red for a loser. */
  positive: boolean
}

class AnnotationRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _data: readonly ChartAnnotation[],
    private readonly _preview: ZoneGeom | null,
    private readonly _previewColor: string,
    private readonly _chart: IChartApi,
    private readonly _series: ISeriesApi<SeriesType>,
    private readonly _highlights: readonly TradeHighlight[] = [],
  ) {}

  draw(target: CanvasRenderingTarget2D) {
    const ts = this._chart.timeScale()
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const a of this._data) {
        if (a.kind === 'zone') this._drawZone(ctx, ts, a.geom, a.color, a.selected ?? false, a.note, false)
        else if (a.kind === 'text') this._drawText(ctx, ts, a.geom, a.color, a.selected ?? false, a.note)
      }
      if (this._preview) this._drawZone(ctx, ts, this._preview, this._previewColor, true, '', true)
      // Highlights last so a callout is never buried under a zone fill.
      for (const h of this._highlights) this._drawHighlight(ctx, ts, h)
    })
  }

  /** P&L (+ score) chip, centred above the trade's entry arrow. */
  private _drawHighlight(
    ctx: CanvasRenderingContext2D, ts: ReturnType<IChartApi['timeScale']>, h: TradeHighlight,
  ) {
    const anchor = this._pt(ts, h.t, h.p)
    if (!anchor) return
    const accent = h.positive ? '#22c55e' : '#ef4444'
    const FONT = '700 12px -apple-system, system-ui, "Segoe UI", sans-serif'
    const SUB = '600 12px -apple-system, system-ui, "Segoe UI", sans-serif'
    ctx.save()
    ctx.font = FONT
    const pnlW = ctx.measureText(h.pnl).width
    ctx.font = SUB
    const sepW = h.score ? ctx.measureText('  ·  ').width : 0
    const scoreW = h.score ? ctx.measureText(h.score).width : 0
    const padX = 8, boxH = 22
    const boxW = pnlW + sepW + scoreW + padX * 2
    // Sit ABOVE the arrow and centred on it, so the chip never covers the
    // candle the trade fired on — the one thing a reader wants to see next to it.
    const x = anchor.x - boxW / 2
    const y = anchor.y - boxH - 14

    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, boxW, boxH, 6)
    else ctx.rect(x, y, boxW, boxH)
    ctx.fillStyle = 'rgba(17,24,39,0.94)'
    ctx.fill()
    ctx.lineWidth = 1.25
    ctx.strokeStyle = accent
    ctx.stroke()

    ctx.textBaseline = 'middle'
    const cy = y + boxH / 2 + 0.5
    let cx = x + padX
    ctx.font = FONT
    ctx.fillStyle = accent
    ctx.fillText(h.pnl, cx, cy)
    cx += pnlW
    if (h.score) {
      ctx.font = SUB
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fillText('  ·  ', cx, cy)
      cx += sepW
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.fillText(h.score, cx, cy)
    }
    ctx.restore()
  }

  private _pt(ts: ReturnType<IChartApi['timeScale']>, t?: number, p?: number): { x: number; y: number } | null {
    if (t == null || p == null) return null
    const x = ts.timeToCoordinate(t as Time)
    const y = this._series.priceToCoordinate(p)
    if (x == null || y == null) return null
    return { x, y }
  }

  private _drawZone(
    ctx: CanvasRenderingContext2D, ts: ReturnType<IChartApi['timeScale']>,
    g: AnnGeom, color: string, selected: boolean, note: string, preview: boolean,
  ) {
    const a = this._pt(ts, g.t1, g.p1), b = this._pt(ts, g.t2, g.p2)
    if (!a || !b) return
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y)
    ctx.save()
    ctx.fillStyle = color + '22'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = color
    ctx.lineWidth = selected ? 2 : 1.25
    if (preview) ctx.setLineDash([5, 4])
    ctx.strokeRect(x, y, w, h)
    ctx.setLineDash([])
    if (note && !preview) {
      ctx.font = '600 11px -apple-system, system-ui, sans-serif'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = color
      ctx.fillText(note, x + 4, y - 2)
    }
    ctx.restore()
  }

  private _drawText(
    ctx: CanvasRenderingContext2D, ts: ReturnType<IChartApi['timeScale']>,
    g: AnnGeom, color: string, selected: boolean, note: string,
  ) {
    const anchor = this._pt(ts, g.t, g.p)
    if (!anchor) return
    const label = note || '(text)'
    const fontPx = g.size ?? 13
    ctx.save()
    ctx.font = `600 ${fontPx}px -apple-system, system-ui, "Segoe UI", sans-serif`
    ctx.textBaseline = 'middle'
    const padX = 7
    const w = ctx.measureText(label).width
    const boxW = w + padX * 2, boxH = fontPx + 8
    const x = anchor.x, y = anchor.y
    // Subtle rounded chip so the label reads over candles without a heavy pill.
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, boxW, boxH, 5)
    else ctx.rect(x, y, boxW, boxH)
    ctx.fillStyle = 'rgba(17,24,39,0.9)'
    ctx.fill()
    ctx.lineWidth = selected ? 1.5 : 1
    ctx.strokeStyle = selected ? color : 'rgba(255,255,255,0.14)'
    ctx.stroke()
    ctx.fillStyle = color
    ctx.fillText(label, x + padX, y + boxH / 2 + 0.5)
    ctx.restore()
  }
}

class AnnotationPaneView implements IPrimitivePaneView {
  constructor(private readonly _source: AnnotationsPrimitive) {}
  zOrder(): PrimitivePaneViewZOrder { return 'top' }
  renderer(): IPrimitivePaneRenderer | null {
    const chart = this._source.chartApi
    const series = this._source.seriesApi
    if (!chart || !series) return null
    return new AnnotationRenderer(
      this._source.annotations, this._source.preview, this._source.previewColor, chart, series,
      this._source.highlights,
    )
  }
}

export class AnnotationsPrimitive implements ISeriesPrimitive<Time> {
  annotations: readonly ChartAnnotation[] = []
  highlights: readonly TradeHighlight[] = []
  preview: ZoneGeom | null = null
  previewColor = '#ef4444'
  chartApi: IChartApi | null = null
  seriesApi: ISeriesApi<SeriesType> | null = null
  private _requestUpdate?: () => void
  private readonly _paneViews: AnnotationPaneView[]

  constructor() { this._paneViews = [new AnnotationPaneView(this)] }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chartApi = param.chart
    this.seriesApi = param.series
    this._requestUpdate = param.requestUpdate
  }
  detached(): void {
    this.chartApi = null
    this.seriesApi = null
    this._requestUpdate = undefined
  }

  setData(annotations: readonly ChartAnnotation[]): void {
    this.annotations = annotations
    this._requestUpdate?.()
  }
  setHighlights(highlights: readonly TradeHighlight[]): void {
    this.highlights = highlights
    this._requestUpdate?.()
  }
  setPreview(preview: ZoneGeom | null, color = '#ef4444'): void {
    this.preview = preview
    this.previewColor = color
    this._requestUpdate?.()
  }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._paneViews }
}
