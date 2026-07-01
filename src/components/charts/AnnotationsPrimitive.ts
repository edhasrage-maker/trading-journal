/**
 * lightweight-charts v5 series primitive that renders user chart annotations.
 * Phase 1: ZONES (price×time rectangles — demand/supply zones). Same extension
 * mechanism as TradeArrowsPrimitive; extend the kind switch for levels/lines/
 * arrows/text later.
 *
 * Anchors are (time, price): timeToCoordinate / priceToCoordinate map them to
 * pixels each redraw, so a zone stays pinned to its price/time when you zoom or
 * pan. A live drag-preview renders dashed until the user releases.
 */
import type {
  ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder, SeriesAttachedParameter, IChartApi,
  ISeriesApi, SeriesType, Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'

/** A zone's two opposite corners, as (epoch seconds, price). */
export interface ZoneGeom { t1: number; p1: number; t2: number; p2: number }

export interface ChartAnnotation {
  id: string
  kind: 'zone' | 'level' | 'trendline' | 'arrow' | 'text'
  geom: ZoneGeom
  note: string
  color: string
  selected?: boolean
}

class AnnotationRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _data: readonly ChartAnnotation[],
    private readonly _preview: ZoneGeom | null,
    private readonly _previewColor: string,
    private readonly _chart: IChartApi,
    private readonly _series: ISeriesApi<SeriesType>,
  ) {}

  draw(target: CanvasRenderingTarget2D) {
    const ts = this._chart.timeScale()
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const a of this._data) {
        if (a.kind === 'zone') this._drawZone(ctx, ts, a.geom, a.color, a.selected ?? false, a.note, false)
      }
      if (this._preview) this._drawZone(ctx, ts, this._preview, this._previewColor, true, '', true)
    })
  }

  private _rect(ts: IChartApi['timeScale'] extends () => infer T ? T : never, g: ZoneGeom) {
    const x1 = ts.timeToCoordinate(g.t1 as Time)
    const x2 = ts.timeToCoordinate(g.t2 as Time)
    const y1 = this._series.priceToCoordinate(g.p1)
    const y2 = this._series.priceToCoordinate(g.p2)
    if (x1 == null || x2 == null || y1 == null || y2 == null) return null
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
  }

  private _drawZone(
    ctx: CanvasRenderingContext2D,
    ts: ReturnType<IChartApi['timeScale']>,
    g: ZoneGeom, color: string, selected: boolean, note: string, preview: boolean,
  ) {
    const r = this._rect(ts, g)
    if (!r) return
    ctx.save()
    ctx.fillStyle = color + '22' // ~13% alpha fill over the candles
    ctx.fillRect(r.x, r.y, r.w, r.h)
    ctx.strokeStyle = color
    ctx.lineWidth = selected ? 2 : 1.25
    if (preview) ctx.setLineDash([5, 4])
    ctx.strokeRect(r.x, r.y, r.w, r.h)
    ctx.setLineDash([])
    if (note && !preview) {
      ctx.font = '600 11px -apple-system, system-ui, sans-serif'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = color
      ctx.fillText(note, r.x + 4, r.y - 2)
    }
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
    )
  }
}

export class AnnotationsPrimitive implements ISeriesPrimitive<Time> {
  annotations: readonly ChartAnnotation[] = []
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
  /** Live drag preview (dashed); pass null to clear. */
  setPreview(preview: ZoneGeom | null, color = '#ef4444'): void {
    this.preview = preview
    this.previewColor = color
    this._requestUpdate?.()
  }

  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this._paneViews }
}
