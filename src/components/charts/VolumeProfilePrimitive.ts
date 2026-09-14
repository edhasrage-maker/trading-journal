/**
 * Session volume profile as a chart UNDERLAY — lightweight-charts v5 primitive.
 *
 * Drawn the way Sierra draws it: a horizontal histogram anchored to the pane's
 * right edge, reaching a configurable share of the pane's width, on the BOTTOM
 * layer. Candles, levels and drawings all paint over it, so dragging the candles
 * rightward slides them across the histogram instead of hiding them behind it.
 * The anchor is the pane edge, not a time, so the profile stays put while the
 * candles move.
 *
 *   value area  → darker grey
 *   outside it  → lighter grey
 *   POC row     → accent colour
 *
 * Price → pixel goes through the series itself, so rows stay locked to price
 * through zoom, pan and timeframe changes. The profile is a session fact, not a
 * per-timeframe one; it never changes with the candle interval.
 *
 * When the price scale compresses a tick to under a pixel, adjacent rows are
 * summed into one bar per pixel rather than overdrawn — otherwise a zoomed-out
 * chart paints hundreds of sub-pixel rects on top of each other and the shape
 * turns to mush.
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
import type { ProfileRowTuple } from '@/lib/volume-profile'

export interface ProfileDrawData {
  /** [price, volume, ask, bid], ascending by price. */
  rows: readonly ProfileRowTuple[]
  tick: number
  poc: number
  vah: number
  val: number
}

/** Share of the pane width the widest row reaches. Clamped on the way in. */
export const PROFILE_WIDTH_MIN = 0.1
export const PROFILE_WIDTH_MAX = 0.6
export const PROFILE_WIDTH_DEFAULT = 0.34

class ProfileRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _data: ProfileDrawData,
    private readonly _widthFrac: number,
    private readonly _chart: IChartApi,
    private readonly _series: ISeriesApi<SeriesType>,
  ) {}

  draw(target: CanvasRenderingTarget2D) {
    const { rows, tick, poc, vah, val } = this._data
    if (rows.length === 0) return
    const series = this._series
    const pal = palette(this._backgroundColor())

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const paneW = mediaSize.width
      const paneH = mediaSize.height
      const maxW = paneW * this._widthFrac

      const y0 = series.priceToCoordinate(rows[0][0])
      const y1 = series.priceToCoordinate(rows[0][0] + tick)
      if (y0 == null || y1 == null) return
      const rowPx = Math.abs(y0 - y1)
      // Rows per bar: 1 while a tick is at least a pixel tall, else as many as
      // it takes to fill one pixel.
      const group = rowPx >= 1 ? 1 : Math.ceil(1 / Math.max(rowPx, 1e-6))

      type Bucket = { lo: number; hi: number; vol: number; isPoc: boolean; inVa: boolean }
      const buckets: Bucket[] = []
      let maxVol = 0
      for (let i = 0; i < rows.length; i += group) {
        const end = Math.min(rows.length, i + group)
        let vol = 0
        let isPoc = false
        for (let k = i; k < end; k++) {
          vol += rows[k][1]
          if (rows[k][0] === poc) isPoc = true
        }
        const lo = rows[i][0]
        const hi = rows[end - 1][0]
        const mid = (lo + hi) / 2
        buckets.push({ lo, hi, vol, isPoc, inVa: mid >= val && mid <= vah })
        if (vol > maxVol) maxVol = vol
      }
      if (maxVol <= 0) return

      // Leave a hairline between rows only when there is room for one; at a
      // few pixels per row a gap reads as texture, below that it eats the bar.
      const gap = rowPx * group >= 4 ? 1 : 0
      let pocBar: { x: number; top: number; h: number; w: number } | null = null

      for (const b of buckets) {
        const yTop = series.priceToCoordinate(b.hi + tick)
        const yBot = series.priceToCoordinate(b.lo)
        if (yTop == null || yBot == null) continue
        if (yBot < 0 || yTop > paneH) continue          // off-screen
        const top = Math.min(yTop, yBot)
        const h = Math.max(1, Math.abs(yBot - yTop) - gap)
        const w = (b.vol / maxVol) * maxW
        if (w < 0.5) continue
        const x = paneW - w
        if (b.isPoc) { pocBar = { x, top, h, w }; continue }   // drawn last, on top
        ctx.fillStyle = b.inVa ? pal.inVa : pal.outVa
        ctx.fillRect(x, top, w, h)
      }
      if (pocBar) {
        // At least 2px tall, or a single-tick POC vanishes on a zoomed-out chart.
        const h = Math.max(2, pocBar.h)
        ctx.fillStyle = pal.poc
        ctx.fillRect(pocBar.x, pocBar.top + (pocBar.h - h) / 2, pocBar.w, h)
      }
    })
  }

  private _backgroundColor(): string {
    const bg = this._chart.options().layout?.background
    if (bg && 'color' in bg && typeof bg.color === 'string') return bg.color
    return '#030712'
  }
}

/** Greys tuned per ground. Translucent, so candles and grid read through them —
 *  a solid fill would sit on the chart like a wall even beneath the candles. */
function palette(bg: string): { inVa: string; outVa: string; poc: string } {
  return isLight(bg)
    ? { inVa: 'rgba(92, 100, 124, 0.42)', outVa: 'rgba(92, 100, 124, 0.20)', poc: 'rgba(37, 99, 205, 0.90)' }
    : { inVa: 'rgba(170, 180, 204, 0.34)', outVa: 'rgba(170, 180, 204, 0.15)', poc: 'rgba(96, 165, 250, 0.90)' }
}

function isLight(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return false
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140
}

class ProfilePaneView implements IPrimitivePaneView {
  constructor(private readonly _source: VolumeProfilePrimitive) {}
  // The whole point: beneath the candle series, not over it.
  zOrder(): PrimitivePaneViewZOrder { return 'bottom' }
  renderer(): IPrimitivePaneRenderer | null {
    const { chartApi, seriesApi, data } = this._source
    if (!chartApi || !seriesApi || !data) return null
    return new ProfileRenderer(data, this._source.widthFrac, chartApi, seriesApi)
  }
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  data: ProfileDrawData | null = null
  widthFrac = PROFILE_WIDTH_DEFAULT
  chartApi: IChartApi | null = null
  seriesApi: ISeriesApi<SeriesType> | null = null
  private _requestUpdate?: () => void
  private readonly _paneViews = [new ProfilePaneView(this)]

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

  /** Replace the profile (null hides it) and its width, then redraw. */
  setData(data: ProfileDrawData | null, widthFrac: number = this.widthFrac): void {
    this.data = data
    this.widthFrac = Math.min(PROFILE_WIDTH_MAX, Math.max(PROFILE_WIDTH_MIN, widthFrac))
    this._requestUpdate?.()
  }

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews
  }
}
