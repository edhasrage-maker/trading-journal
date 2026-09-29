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
 * The overnight (ETH) profile is the other anchor: pinned to a TIME, the 06:30
 * session boundary, with its bars reaching left over the overnight candles —
 * Sierra's left profile. It pans with the candles, because it belongs to them.
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
  Logical,
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
  /** Absent: the base is the pane's right edge (RTH). Present: the base is this
   *  instant on the time axis and bars grow leftward from it (ETH, at 06:30).
   *  `barSec` is the chart's candle interval, so an instant inside a candle
   *  (06:30 in an hourly 06:00 bar) lands part-way across it. */
  anchor?: { timeSec: number; barSec: number }
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
    private readonly _barTimes: () => readonly number[],
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
      const baseX = this._data.anchor ? anchorX(this._chart, this._barTimes(), this._data.anchor) : paneW
      // Bars grow leftward from the base, so a base left of the pane draws nothing.
      if (baseX == null || baseX <= 0) return

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
      let spanTop = Infinity
      let spanBot = -Infinity

      for (const b of buckets) {
        const yTop = series.priceToCoordinate(b.hi + tick)
        const yBot = series.priceToCoordinate(b.lo)
        if (yTop == null || yBot == null) continue
        if (yBot < 0 || yTop > paneH) continue          // off-screen
        const top = Math.min(yTop, yBot)
        const h = Math.max(1, Math.abs(yBot - yTop) - gap)
        if (top < spanTop) spanTop = top
        if (top + h > spanBot) spanBot = top + h
        const w = (b.vol / maxVol) * maxW
        if (w < 0.5) continue
        const x = baseX - w
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
      // A time-anchored profile gets a hairline along its base, top to bottom of
      // its range, so the session boundary reads even where the rows are short.
      if (this._data.anchor && baseX < paneW && spanBot > spanTop) {
        ctx.fillStyle = pal.inVa
        ctx.fillRect(Math.round(baseX) - 1, spanTop, 1, spanBot - spanTop)
      }
    })
  }

  private _backgroundColor(): string {
    const bg = this._chart.options().layout?.background
    if (bg && 'color' in bg && typeof bg.color === 'string') return bg.color
    return '#030712'
  }
}

/**
 * X pixel of an instant on the time axis, or null with no candles.
 *
 * logicalToCoordinate() only honours whole indices — lightweight-charts returns
 * 0 for a fractional one — so this finds the candle holding the instant, maps
 * its whole index, and adds the fraction in pixels. A candle's slot spans index
 * ±0.5, so an instant at a candle's open is that slot's left edge. An instant
 * that falls in a gap between candles snaps to the next candle's left edge;
 * one past the last candle (06:30 while the overnight is still trading) is
 * extrapolated along the axis into the empty space on the right.
 */
function anchorX(chart: IChartApi, times: readonly number[], anchor: { timeSec: number; barSec: number }): number | null {
  const slot = anchorSlot(times, anchor.timeSec, anchor.barSec)
  if (!slot) return null
  const ts = chart.timeScale()
  const idx = ts.timeToIndex(times[slot.i] as Time, false)
  if (idx == null) return null
  const x0 = ts.logicalToCoordinate(idx as unknown as Logical)
  const x1 = ts.logicalToCoordinate((idx + 1) as unknown as Logical)
  if (x0 == null || x1 == null) return null
  return x0 + (slot.frac - 0.5) * (x1 - x0)
}

/**
 * Which candle an instant falls in, and how far across it (0 = the candle's
 * open, its slot's left edge). Pure, for the tests. `frac` runs past 1 only
 * beyond the last candle and below 0 only before the first — both extrapolate.
 */
export function anchorSlot(times: readonly number[], timeSec: number, barSec: number): { i: number; frac: number } | null {
  if (times.length === 0 || !(barSec > 0)) return null
  // Last candle opening at or before the instant (the first, if it precedes them all).
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= timeSec) lo = mid + 1
    else hi = mid
  }
  const i = Math.max(0, lo - 1)
  const frac = (timeSec - times[i]) / barSec
  // Past the end of candle i with a later candle waiting: the instant is in a
  // gap, so the boundary is that later candle's left edge.
  if (frac > 1 && i + 1 < times.length) return { i: i + 1, frac: 0 }
  return { i, frac }
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
    return new ProfileRenderer(data, this._source.widthFrac, chartApi, seriesApi, this._source.barTimes)
  }
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  data: ProfileDrawData | null = null
  widthFrac = PROFILE_WIDTH_DEFAULT
  chartApi: IChartApi | null = null
  seriesApi: ISeriesApi<SeriesType> | null = null
  private _requestUpdate?: () => void
  private readonly _paneViews = [new ProfilePaneView(this)]
  // Candle open times, for placing a time anchor. series.data() rebuilds every
  // row on each call, and a pan redraws every frame, so keep one copy and drop
  // it only when the candles change.
  private _times: number[] | null = null
  private readonly _onDataChanged = () => { this._times = null }

  /** Candle open times (UTC seconds), ascending. */
  readonly barTimes = (): readonly number[] => {
    if (!this._times) this._times = this.seriesApi ? this.seriesApi.data().map(d => d.time as number) : []
    return this._times
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chartApi = param.chart
    this.seriesApi = param.series
    this._requestUpdate = param.requestUpdate
    this._times = null
    param.series.subscribeDataChanged(this._onDataChanged)
  }

  detached(): void {
    this.seriesApi?.unsubscribeDataChanged(this._onDataChanged)
    this.chartApi = null
    this.seriesApi = null
    this._requestUpdate = undefined
    this._times = null
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
