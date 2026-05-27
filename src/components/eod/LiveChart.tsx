'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle, Database } from 'lucide-react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import { calcEMA, calcVWAP, type IndicatorBar } from '@/lib/indicators'
import type { Trade } from '@/lib/supabase/types'

interface Props {
  date: string
  symbol: string | null
  trades: Trade[]
  height?: number
}

interface ApiBar {
  ts: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

/**
 * Native chart for the EOD page using TradingView's lightweight-charts.
 * Renders the day's 1m bars with VWAP + EMA(9) + EMA(20) overlays, and
 * trade entry markers via series.setMarkers(). Replaces the screenshot +
 * calibration flow for days where bars have been imported.
 *
 * Empty states:
 *   - No symbol on trades → "Import trades first" message
 *   - Bars not found for that symbol+date → "Import bars" hint with link
 *     to /settings/bars
 */
export default function LiveChart({ date, symbol, trades, height = 480 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null)

  const [bars, setBars] = useState<ApiBar[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch bars when symbol/date change
  useEffect(() => {
    if (!symbol) {
      setError('no-symbol')
      setLoading(false)
      setBars(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/bars?symbol=${encodeURIComponent(symbol)}&date=${date}`)
      .then(async r => {
        const data = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setError(data.error ?? 'Failed to fetch bars')
          setBars(null)
        } else {
          setBars(data.bars ?? [])
        }
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Network error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [symbol, date])

  // Initialize chart once
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { color: '#030712' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#374151',
      },
      rightPriceScale: {
        borderColor: '#374151',
      },
      crosshair: {
        mode: 1,
      },
    })
    chartRef.current = chart
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
    })
    vwapRef.current = chart.addSeries(LineSeries, {
      color: '#3b82f6',
      lineWidth: 2,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
    })
    ema9Ref.current = chart.addSeries(LineSeries, {
      color: '#eab308',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    ema20Ref.current = chart.addSeries(LineSeries, {
      color: '#a855f7',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    })

    const obs = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: entry.contentRect.width })
    })
    obs.observe(containerRef.current)

    return () => {
      obs.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      vwapRef.current = null
      ema9Ref.current = null
      ema20Ref.current = null
    }
  }, [height])

  // Push data + markers whenever bars or trades change
  useEffect(() => {
    if (!candleRef.current || !vwapRef.current || !ema9Ref.current || !ema20Ref.current) return
    if (!bars || bars.length === 0) {
      candleRef.current.setData([])
      vwapRef.current.setData([])
      ema9Ref.current.setData([])
      ema20Ref.current.setData([])
      return
    }

    const candleData = bars.map(b => ({
      time: (new Date(b.ts).getTime() / 1000) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
    candleRef.current.setData(candleData)

    // Indicators — computed client-side so units stay in sync
    const indBars: IndicatorBar[] = bars
    const closes = bars.map(b => b.close)
    const vwap = calcVWAP(indBars)
    const ema9 = calcEMA(closes, 9)
    const ema20 = calcEMA(closes, 20)

    vwapRef.current.setData(bars.map((b, i) => ({
      time: (new Date(b.ts).getTime() / 1000) as Time,
      value: vwap[i],
    })))
    ema9Ref.current.setData(
      bars
        .map((b, i) => ema9[i] != null ? { time: (new Date(b.ts).getTime() / 1000) as Time, value: ema9[i]! } : null)
        .filter((p): p is { time: Time; value: number } => p !== null),
    )
    ema20Ref.current.setData(
      bars
        .map((b, i) => ema20[i] != null ? { time: (new Date(b.ts).getTime() / 1000) as Time, value: ema20[i]! } : null)
        .filter((p): p is { time: Time; value: number } => p !== null),
    )

    // Trade markers — entries are direction-shaped arrows, exits are circles
    // on the opposite side. Both color-graded by PnL so the eye can pair
    // them up at a glance. Sorted by time because lightweight-charts requires
    // markers in ascending order.
    type Marker = {
      time: Time
      position: 'belowBar' | 'aboveBar'
      color: string
      shape: 'arrowUp' | 'arrowDown' | 'circle'
      text: string
    }
    const markers: Marker[] = []
    for (const t of trades) {
      if (!t.entry_time || !t.direction) continue
      const isLong = t.direction === 'long'
      const pnl = t.pnl ?? 0
      const color = pnl > 0 ? '#22c55e' : pnl < 0 ? '#ef4444' : '#6b7280'
      // Entry marker
      markers.push({
        time: (new Date(t.entry_time).getTime() / 1000) as Time,
        position: isLong ? 'belowBar' : 'aboveBar',
        color,
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: `${t.direction.toUpperCase()} ${t.quantity ?? ''}@${t.entry_price ?? '?'}`,
      })
      // Exit marker (hollow circle on opposite side of bar)
      if (t.exit_time && t.exit_price != null) {
        markers.push({
          time: (new Date(t.exit_time).getTime() / 1000) as Time,
          position: isLong ? 'aboveBar' : 'belowBar',
          color,
          shape: 'circle',
          text: `Exit @ ${t.exit_price}${pnl !== 0 ? ` (${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)})` : ''}`,
        })
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number))
    candleRef.current.setMarkers(markers)

    chartRef.current?.timeScale().fitContent()
  }, [bars, trades])

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-2">
      {/* Header: legend + symbol + bar count */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-3 text-gray-400">
          <span className="font-mono">{symbol ?? '—'}</span>
          {bars && bars.length > 0 && (
            <span className="text-gray-600">· {bars.length.toLocaleString()} bars</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-500" />VWAP</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-yellow-500" />EMA 9</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-purple-500" />EMA 20</span>
        </div>
      </div>

      {/* Chart container — always rendered so the chart instance can mount */}
      <div className="relative">
        <div ref={containerRef} style={{ height, width: '100%' }} className={loading || error ? 'opacity-30' : ''} />

        {/* Overlay states */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
          </div>
        )}

        {!loading && error === 'no-symbol' && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-6">
            <div>
              <AlertCircle className="w-6 h-6 text-gray-500 mx-auto mb-2" />
              <p className="text-sm text-gray-300">No symbol on trades for this day.</p>
              <p className="text-xs text-gray-500 mt-1">Import a Sierra Chart log to populate trade symbols.</p>
            </div>
          </div>
        )}

        {!loading && error && error !== 'no-symbol' && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-6">
            <div>
              <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
              <p className="text-sm text-red-300">Failed to load bars</p>
              <p className="text-xs text-gray-500 mt-1">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && bars && bars.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-6">
            <div>
              <Database className="w-6 h-6 text-gray-500 mx-auto mb-2" />
              <p className="text-sm text-gray-300">No bars imported for {symbol} on {date}</p>
              <p className="text-xs text-gray-500 mt-1">
                Go to <a href="/settings/bars" className="text-blue-400 hover:underline">Settings → Bar Data</a> and upload a CSV for this symbol + date range.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
