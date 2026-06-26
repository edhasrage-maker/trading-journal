/**
 * Custom lightweight-charts v5 series primitive that draws trade fills as real
 * left/right triangle arrows — something the built-in marker API can't do (its
 * only shapes are circle/square/arrowUp/arrowDown).
 *
 * Encoding:
 *   - COLOR  = direction: green = long, red = short (entry AND exit alike).
 *   - ARROW  = leg: ▶ (points right) = ENTRY; ◀ (points left) = EXIT.
 * Each arrow sits ON the candle, centered at its FILL POINT (x = time, y =
 * price), so price relationships read true (a long's lower exit draws below its
 * entry). Arrows are BLANK by default with a bold border in a darker shade of
 * the direction color (dark green long / dark red short) so they stand out
 * against the candles; on hover they enlarge and reveal a label (direction /
 * size / fill price), background-haloed so the text beats the candles.
 *
 * The chart owns one instance per candle series (attachPrimitive); call
 * setData() whenever trades/hover change and the chart redraws.
 */
import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  IChartApi,
  ISeriesApi,
  SeriesType,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'

export interface TradeArrow {
  time: Time
  /** The fill price — drives the arrow's vertical position so price
   *  relationships (e.g. a long's lower exit) read correctly. */
  price: number
  /** entry = ▶ (points right, sits left of bar); exit = ◀ (points left, right of bar) */
  leg: 'entry' | 'exit'
  /** green (long) / red (short) — direction, not P&L */
  color: string
  /** Arrow border — a darker shade of `color` (dark green long / dark red short). */
  outline: string
  /** Label drawn next to the arrow (qty, or a richer string on hover). */
  label: string
  /** Hovered trades render larger so the full ribbon pops out of a cluster. */
  hovered: boolean
}

class ArrowRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _data: readonly TradeArrow[],
    private readonly _chart: IChartApi,
    private readonly _series: ISeriesApi<SeriesType>,
  ) {}

  draw(target: CanvasRenderingTarget2D) {
    const timeScale = this._chart.timeScale()
    const bg = this._backgroundColor()
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const a of this._data) {
        const x = timeScale.timeToCoordinate(a.time)
        const y = this._series.priceToCoordinate(a.price)
        if (x == null || y == null) continue
        this._drawArrow(ctx, x, y, a, bg)
      }
    })
  }

  /** The chart's solid background color — used as the arrow/label outline so
   *  they read against the candles. Falls back to the dark default. */
  private _backgroundColor(): string {
    const bg = this._chart.options().layout?.background
    if (bg && 'color' in bg && typeof bg.color === 'string') return bg.color
    return '#030712'
  }

  private _drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, a: TradeArrow, bg: string) {
    const scale = a.hovered ? 1.55 : 1
    const len = 10 * scale      // horizontal tip-to-base length
    const half = 5 * scale      // half the base height
    const entry = a.leg === 'entry'

    // Sit ON the candle, centered at the fill point (x = time, y = price), so
    // price relationships read true. ▶ entry points right, ◀ exit points left.
    const tipX = entry ? x + len / 2 : x - len / 2
    const baseX = entry ? x - len / 2 : x + len / 2

    ctx.save()
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(tipX, y)
    ctx.lineTo(baseX, y - half)
    ctx.lineTo(baseX, y + half)
    ctx.closePath()
    // Bold border in a darker shade of the direction color (dark green long /
    // dark red short), painted under the fill so it reads as a clean outline.
    ctx.lineWidth = a.hovered ? 4 : 3
    ctx.strokeStyle = a.outline
    ctx.stroke()
    ctx.fillStyle = a.color
    ctx.fill()

    // Label (entry price + size) — hover only; blank otherwise. Pointed OUTWARD
    // from the trade's time span (entry label trails LEFT, exit labels trail
    // RIGHT) so an entry and a nearby exit don't stack their text. Haloed in the
    // background color so the text stays legible over the candles.
    if (a.label) {
      ctx.font = `600 ${a.hovered ? 12 : 11}px -apple-system, system-ui, sans-serif`
      ctx.textBaseline = 'middle'
      ctx.textAlign = entry ? 'right' : 'left'
      const lx = entry ? baseX - 4 : baseX + 4
      ctx.lineWidth = 3
      ctx.strokeStyle = bg
      ctx.strokeText(a.label, lx, y)
      ctx.fillStyle = a.color
      ctx.fillText(a.label, lx, y)
    }
    ctx.restore()
  }
}

class ArrowPaneView implements IPrimitivePaneView {
  constructor(private readonly _source: TradeArrowsPrimitive) {}
  zOrder(): PrimitivePaneViewZOrder { return 'top' }
  renderer(): IPrimitivePaneRenderer | null {
    const chart = this._source.chartApi
    const series = this._source.seriesApi
    if (!chart || !series) return null
    return new ArrowRenderer(this._source.arrows, chart, series)
  }
}

export class TradeArrowsPrimitive implements ISeriesPrimitive<Time> {
  arrows: readonly TradeArrow[] = []
  chartApi: IChartApi | null = null
  seriesApi: ISeriesApi<SeriesType> | null = null
  private _requestUpdate?: () => void
  private readonly _paneViews: ArrowPaneView[]

  constructor() {
    this._paneViews = [new ArrowPaneView(this)]
  }

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

  /** Replace the arrow set and trigger a redraw. */
  setData(arrows: readonly TradeArrow[]): void {
    this.arrows = arrows
    this._requestUpdate?.()
  }

  // Views read live state off `this`, so no per-view cache to invalidate.
  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews
  }
}
