'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { DayStat } from './DashboardStats'

/**
 * Two stacked dashboard charts that replace the old "Today" quick-action tiles:
 *
 *   1. Equity Curve — cumulative net P&L across the selected period (line),
 *      with a hover readout of the running total at any point.
 *   2. Daily Results — per-day net P&L (green/red bars).
 *
 * Both read the same server-fetched DayStat[] that feeds DashboardStats and
 * filter client-side by a self-contained period selector (persisted to
 * localStorage, independent of the stat-card period). Only days with a
 * non-null eod_pnl (actual sessions / overrides) are plotted.
 *
 * Custom SVG (not the shared charts/LineChart) because these need crisp axis
 * labels + hover interactivity. The plot SVG uses preserveAspectRatio="none"
 * to fill its box; all text lives in HTML positioned by percentage so it stays
 * undistorted and aligned to the gridlines.
 */

type Period = 'month' | '30d' | 'ytd' | 'last_year' | 'all'
const PERIOD_KEY = 'dashboard-charts-period-v1'
const PERIOD_LABELS: Record<Period, string> = {
  month: 'This Month',
  '30d': 'Last 30 Days',
  ytd: 'Year to Date',
  last_year: 'Last Year',
  all: 'All Time',
}

function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** Inclusive [start, end] date bounds for each period. `all` returns an open
 *  lower bound so every fetched day is included. */
function periodBounds(period: Period): { start: string; end: string } {
  const now = new Date()
  const today = ymd(now)
  switch (period) {
    case 'month':
      return { start: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), end: today }
    case '30d': {
      const start = new Date(now)
      start.setDate(now.getDate() - 30)
      return { start: ymd(start), end: today }
    }
    case 'ytd':
      return { start: ymd(new Date(now.getFullYear(), 0, 1)), end: today }
    case 'last_year': {
      const year = now.getFullYear() - 1
      return { start: `${year}-01-01`, end: `${year}-12-31` }
    }
    case 'all':
      return { start: '0000-01-01', end: today }
  }
}

/** Currency formatter for axis ticks / tooltips. Always full, comma-grouped
 *  numbers ("$1,500" / "-$420" / "$0") so the axis reads uniformly. */
function fmtMoney(v: number, opts?: { signed?: boolean }): string {
  const r = Math.round(v)
  const abs = Math.abs(r).toLocaleString()
  if (r < 0) return `-$${abs}`
  return opts?.signed ? `+$${abs}` : `$${abs}`
}

/** "Nice" rounded axis bounds + ticks for a [min, max] domain. Returns the
 *  expanded niceMin/niceMax (so the plot domain lands on round numbers) and
 *  the tick values in between. */
function niceScale(min: number, max: number, count = 4): { niceMin: number; niceMax: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const base = Number.isFinite(min) ? min : 0
    const pad = Math.max(1, Math.abs(base) * 0.1)
    return { niceMin: base - pad, niceMax: base + pad, ticks: [base - pad, base, base + pad] }
  }
  const niceNum = (range: number, round: boolean) => {
    const exp = Math.floor(Math.log10(Math.abs(range)) || 0)
    const f = range / Math.pow(10, exp)
    const nf = round
      ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
      : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10)
    return nf * Math.pow(10, exp)
  }
  const step = niceNum((max - min) / count, true)
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(Math.round(v * 100) / 100)
  return { niceMin, niceMax, ticks }
}

const GREEN = '#22c55e'
const RED = '#ef4444'

/**
 * Split a cumulative line into maximal same-sign runs so it can be drawn green
 * while the running total is ≥ 0 and red while it's < 0. Edges that straddle
 * zero are cut at the interpolated zero-crossing so the color flips exactly on
 * the axis. Returns one SVG path `d` string per run.
 *
 * Module-level (not in the component) so its local mutation/accumulation isn't
 * subject to the React Compiler immutability rule. Coordinates are in the SVG's
 * 0-100 viewBox space (xAt/yAt supplied by the caller).
 */
function signedLineSegments(
  values: number[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): { color: string; d: string }[] {
  const colorFor = (v: number) => (v >= 0 ? GREEN : RED)
  const runs: { color: string; pts: [number, number][] }[] = []
  let cur: [number, number][] = []
  let curColor = ''
  const flush = () => { if (cur.length >= 2) runs.push({ color: curColor, pts: cur }); cur = [] }
  const add = (color: string, p0: [number, number], p1: [number, number]) => {
    if (color !== curColor) { flush(); curColor = color; cur = [p0, p1] }
    else cur.push(p1)
  }
  for (let i = 0; i < values.length - 1; i++) {
    const av = values[i], bv = values[i + 1]
    const a: [number, number] = [xAt(i), yAt(av)]
    const b: [number, number] = [xAt(i + 1), yAt(bv)]
    if ((av >= 0) === (bv >= 0)) {
      add(colorFor(av), a, b)
    } else {
      const t = av / (av - bv) // fraction from a→b where value crosses 0
      const cross: [number, number] = [a[0] + t * (b[0] - a[0]), yAt(0)]
      add(colorFor(av), a, cross)
      add(colorFor(bv), cross, b)
    }
  }
  flush()
  return runs.map(r => ({
    color: r.color,
    d: r.pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' '),
  }))
}

interface Props {
  days: DayStat[]
}

export default function DashboardCharts({ days }: Props) {
  const [period, setPeriod] = useState<Period>('ytd')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PERIOD_KEY) as Period | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- load-from-localStorage hydration shim
      if (raw && raw in PERIOD_LABELS) setPeriod(raw)
    } catch { /* ignore */ }
    setHydrated(true)
  }, [])
  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(PERIOD_KEY, period) } catch { /* ignore */ }
  }, [period, hydrated])

  const { points, equity, daily } = useMemo(() => {
    const { start, end } = periodBounds(period)
    const inPeriod = days
      .filter(d => d.eod_pnl != null && d.date >= start && d.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date))

    // Running cumulative sum without a mutable closure variable (the React
    // Compiler immutability rule rejects `acc += …` inside .map). n ≤ ~365 so
    // the O(n²) prefix sum is cheap and stays purely functional.
    const equity = inPeriod.map((_, i) =>
      inPeriod.slice(0, i + 1).reduce((s, d) => s + (d.eod_pnl ?? 0), 0),
    )
    const daily = inPeriod.map(d => ({ date: d.date, pnl: d.eod_pnl ?? 0 }))
    const points = inPeriod.map(d => d.date)
    return { points, equity, daily }
  }, [days, period])

  const hasData = points.length > 0

  return (
    <div className="mb-6">
      {/* Period selector — independent of the stat-card period below. */}
      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-gray-500">Chart range:</label>
        <div className="relative">
          <select
            value={period}
            onChange={e => setPeriod(e.target.value as Period)}
            className="appearance-none bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-md pl-2 pr-7 py-1 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            {Object.entries(PERIOD_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500 pointer-events-none" />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Equity Curve (cumulative) */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold text-white text-sm">Equity Curve</h2>
            {hasData && (
              <span className={`text-xs font-mono ${equity[equity.length - 1] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {fmtMoney(equity[equity.length - 1], { signed: true })}
              </span>
            )}
          </div>
          {hasData ? (
            <EquityChart dates={points} values={equity} height={210} />
          ) : (
            <div className="text-center text-xs text-gray-600 italic py-16">No closed sessions in this range</div>
          )}
        </div>

        {/* Daily Results (per-day net P&L bars) */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold text-white text-sm">Daily Results</h2>
            {hasData && (
              <span className="text-xs text-gray-500">{daily.length} day{daily.length === 1 ? '' : 's'}</span>
            )}
          </div>
          {hasData ? (
            <BarsChart bars={daily} height={210} />
          ) : (
            <div className="text-center text-xs text-gray-600 italic py-16">No closed sessions in this range</div>
          )}
        </div>
      </div>
    </div>
  )
}

// Shared plot margins (px). Left gutter holds $ ticks; bottom holds date ticks.
// Left is wide enough for full comma-grouped values (e.g. "-$10,000").
const M = { left: 60, right: 10, top: 8, bottom: 20 }

/**
 * Axis frame shared by both charts: a fixed-height box with a left Y-axis
 * (currency ticks) and bottom X-axis (date ticks). The plot area is inset by
 * the margins; `children` receives that inner box (position:relative) to draw
 * its SVG + overlays into. Tick labels are HTML positioned by CSS calc so they
 * align to the SVG gridlines without distortion.
 */
function ChartFrame({
  height, yMin, yMax, yTicks, xLabels, children,
}: {
  height: number
  yMin: number
  yMax: number
  yTicks: number[]
  xLabels: string[]
  children: React.ReactNode
}) {
  const span = yMax - yMin || 1
  const fracY = (v: number) => (v - yMin) / span
  const n = xLabels.length
  // X tick indices: first, middle, last (clean — avoids clutter on dense ranges).
  const xIdx = n <= 1 ? [0] : n === 2 ? [0, n - 1] : [0, Math.floor(n / 2), n - 1]

  return (
    <div className="relative w-full" style={{ height }}>
      {/* Y axis tick labels — aligned to gridlines inside the plot area. */}
      {yTicks.map((v, i) => (
        <div
          key={i}
          className="absolute text-[10px] text-gray-500 font-mono text-right pr-1.5 leading-none"
          style={{
            left: 0,
            width: M.left,
            top: `calc(${M.top}px + ${(1 - fracY(v)).toFixed(4)} * (100% - ${M.top + M.bottom}px))`,
            transform: 'translateY(-50%)',
          }}
        >
          {fmtMoney(v)}
        </div>
      ))}

      {/* Plot area */}
      <div
        className="absolute"
        style={{ left: M.left, right: M.right, top: M.top, bottom: M.bottom }}
      >
        {children}
      </div>

      {/* X axis tick labels */}
      <div className="absolute" style={{ left: M.left, right: M.right, bottom: 0, height: M.bottom }}>
        {xIdx.map((idx, k) => {
          const frac = n <= 1 ? 0.5 : idx / (n - 1)
          // First label hugs left, last hugs right, middle centers — keeps the
          // text inside the plot box instead of clipping at the edges.
          const transform = k === 0 ? 'none' : k === xIdx.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)'
          return (
            <span
              key={idx}
              className="absolute top-1 text-[10px] text-gray-600 font-mono whitespace-nowrap"
              style={{ left: `${(frac * 100).toFixed(2)}%`, transform }}
            >
              {xLabels[idx]?.slice(5)}
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** Horizontal gridlines (one per Y tick) + an emphasized zero line. Drawn in
 *  the plot SVG so they sit behind the data and align with the Y labels. */
function Gridlines({ yMin, yMax, yTicks }: { yMin: number; yMax: number; yTicks: number[] }) {
  const span = yMax - yMin || 1
  const yAt = (v: number) => (1 - (v - yMin) / span) * 100
  return (
    <>
      {yTicks.map((v, i) => (
        <line
          key={i}
          x1={0} x2={100} y1={yAt(v)} y2={yAt(v)}
          stroke="#1f2937" strokeWidth="0.15" vectorEffect="non-scaling-stroke"
        />
      ))}
      {yMin < 0 && yMax > 0 && (
        <line
          x1={0} x2={100} y1={yAt(0)} y2={yAt(0)}
          stroke="#4b5563" strokeWidth="0.25" vectorEffect="non-scaling-stroke" strokeDasharray="0.6 0.6"
        />
      )}
    </>
  )
}

/** Cumulative equity line with hover readout. */
function EquityChart({ dates, values, height }: { dates: string[]; values: number[]; height: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const { niceMin, niceMax, ticks } = niceScale(lo, hi, 4)
  const span = niceMax - niceMin || 1

  const n = values.length
  const xAt = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const yAt = (v: number) => (1 - (v - niceMin) / span) * 100

  const segments = signedLineSegments(values, xAt, yAt)

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const w = e.currentTarget.clientWidth
    if (w <= 0 || n === 0) return
    const frac = Math.min(1, Math.max(0, e.nativeEvent.offsetX / w))
    setHoverIdx(n <= 1 ? 0 : Math.round(frac * (n - 1)))
  }

  return (
    <ChartFrame height={height} yMin={niceMin} yMax={niceMax} yTicks={ticks} xLabels={dates}>
      <div className="relative w-full h-full">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full" style={{ pointerEvents: 'none' }}>
          <Gridlines yMin={niceMin} yMax={niceMax} yTicks={ticks} />
          {segments.map((s, i) => (
            <path key={i} d={s.d} fill="none" stroke={s.color} strokeWidth="0.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          ))}
          {hoverIdx != null && (
            <>
              <line
                x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={0} y2={100}
                stroke="#6b7280" strokeWidth="0.25" vectorEffect="non-scaling-stroke"
              />
              <circle cx={xAt(hoverIdx)} cy={yAt(values[hoverIdx])} r="1.1" fill={values[hoverIdx] >= 0 ? GREEN : RED} stroke="#0b0f17" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>

        {/* Hover capture + tooltip */}
        <div className="absolute inset-0" onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)} />
        {hoverIdx != null && (
          <div
            className="absolute z-10 pointer-events-none bg-gray-950/95 border border-gray-700 rounded px-2 py-1 shadow-lg whitespace-nowrap"
            style={{
              left: `${xAt(hoverIdx)}%`,
              top: `${yAt(values[hoverIdx])}%`,
              transform: `translate(${hoverIdx > n / 2 ? '-100%' : '0%'}, -130%)`,
            }}
          >
            <div className="text-[10px] text-gray-400 font-mono">{dates[hoverIdx]}</div>
            <div className={`text-xs font-mono font-semibold ${values[hoverIdx] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {fmtMoney(values[hoverIdx], { signed: true })}
            </div>
          </div>
        )}
      </div>
    </ChartFrame>
  )
}

/** Per-day net P&L bars (green up / red down) with a hover tooltip showing the
 *  day + P&L (the native <title> was slow and unreliable). */
function BarsChart({ bars, height }: { bars: { date: string; pnl: number }[]; height: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const vals = bars.map(b => b.pnl)
  const lo = Math.min(0, ...vals)
  const hi = Math.max(0, ...vals)
  const { niceMin, niceMax, ticks } = niceScale(lo, hi, 4)
  const span = niceMax - niceMin || 1
  const yAt = (v: number) => (1 - (v - niceMin) / span) * 100
  const zeroY = yAt(0)

  const n = bars.length
  const slot = 100 / n
  const barW = slot * 0.7
  const gap = (slot - barW) / 2

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const w = e.currentTarget.clientWidth
    if (w <= 0 || n === 0) return
    const frac = Math.min(0.9999, Math.max(0, e.nativeEvent.offsetX / w))
    setHoverIdx(Math.min(n - 1, Math.floor(frac * n)))
  }

  return (
    <ChartFrame height={height} yMin={niceMin} yMax={niceMax} yTicks={ticks} xLabels={bars.map(b => b.date)}>
      <div className="relative w-full h-full">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full" style={{ pointerEvents: 'none' }}>
          <Gridlines yMin={niceMin} yMax={niceMax} yTicks={ticks} />
          {bars.map((b, i) => {
            const x = i * slot + gap
            const y = b.pnl >= 0 ? yAt(b.pnl) : zeroY
            const h = Math.abs(yAt(b.pnl) - zeroY)
            const hovered = i === hoverIdx
            const fill = b.pnl >= 0 ? (hovered ? '#4ade80' : GREEN) : (hovered ? '#f87171' : RED)
            return <rect key={b.date} x={x} y={y} width={barW} height={Math.max(0.3, h)} fill={fill} />
          })}
        </svg>

        {/* Hover capture + tooltip */}
        <div className="absolute inset-0" onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)} />
        {hoverIdx != null && (() => {
          const b = bars[hoverIdx]
          const cx = hoverIdx * slot + slot / 2
          const top = b.pnl >= 0 ? yAt(b.pnl) : zeroY // top edge of the bar
          return (
            <div
              className="absolute z-10 pointer-events-none bg-gray-950/95 border border-gray-700 rounded px-2 py-1 shadow-lg whitespace-nowrap"
              style={{
                left: `${cx}%`,
                top: `${top}%`,
                transform: `translate(${hoverIdx > n / 2 ? '-100%' : '0%'}, -115%)`,
              }}
            >
              <div className="text-[10px] text-gray-400 font-mono">{b.date}</div>
              <div className={`text-xs font-mono font-semibold ${b.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {fmtMoney(b.pnl, { signed: true })}
              </div>
            </div>
          )
        })()}
      </div>
    </ChartFrame>
  )
}
