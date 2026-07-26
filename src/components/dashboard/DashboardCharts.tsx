'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { tapeScoreBand } from '@/lib/tapescore'
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
// The trader's saved chart range sticks across visits (reverted a v2 bump that
// force-reset it — persisting a preference means keeping it).
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
/** The score that counts as "par" for the process curve. 50 is the midpoint of
 *  the 0-100 scale and the bottom of the amber band — a session at 50 neither
 *  builds nor erodes the curve. */
const PROC_NEUTRAL = 50
/** The process curve's colour — brand accent, never green/red. It is a score,
 *  not money, and must never be read as a second P&L. */
const PROC_BLUE = '#79B4E6'

/**
 * The process curve: cumulative (TapeScore − 50) over the scored sessions.
 *
 * The equity curve is cumulative, so a DAILY score can never be compared to it
 * — one trends, the other oscillates, and no smoothing fixes that mismatch.
 * Compounding the score puts both series in the same form, and then the thing
 * that matters is the same for both: the SLOPE. Sessions above par build the
 * curve, sessions below erode it, so a stretch of good decisions shows up as a
 * climb whatever the money did.
 *
 * Unscored sessions carry the value forward (no data, no movement) and the
 * curve is only drawn from the first scored session, so the flat run before
 * scoring began can't be misread as "par process".
 *
 * Module-level so the running accumulation isn't subject to the React Compiler
 * immutability rule (same reason as signedLineSegments).
 */
function processCurve(scores: (number | null)[]): { values: number[]; firstIdx: number } {
  let running = 0
  let firstIdx = -1
  const values = scores.map((s, i) => {
    if (s != null) {
      running += s - PROC_NEUTRAL
      if (firstIdx < 0) firstIdx = i
    }
    return running
  })
  return { values, firstIdx }
}

/** Band fills for the score strip — the SAME green/amber/red the TapeScore ring
 *  and the Recent Days badges use, so one session reads the same colour
 *  everywhere it appears. Thresholds come from tapeScoreBand rather than being
 *  re-declared here, so a re-band can't drift between surfaces. */
const BAND_FILL: Record<'high' | 'mid' | 'low', string> = {
  high: '#4ade80',
  mid: '#fbbf24',
  low: '#f87171',
}

/**
 * Session-by-session TapeScore as a slim band beneath the equity curve.
 *
 * Deliberately NOT a second line on the plot. A score series crossing the curve
 * was unreadable at every treatment tried (raw = noise, smoothed = a flat dead
 * line, dots = clutter), and it forced a second scale onto a chart that already
 * has one. As a strip it answers the question the pairing is actually for —
 * does the curve climb through well-traded stretches? — by putting process
 * directly under the money on a shared x-axis, with nothing overlapping.
 *
 * Unscored sessions render as a GAP, never a neutral fill: "no analysis" must
 * not be mistakable for "an average day".
 */
function ScoreStrip({ scores }: { scores: (number | null)[] }) {
  const n = scores.length
  if (n === 0) return null
  const w = 100 / n
  return (
    <svg viewBox="0 0 100 1" preserveAspectRatio="none" className="w-full h-full">
      {scores.map((s, i) => s == null ? null : (
        <rect
          key={i}
          x={i * w + w * 0.08} y={0}
          width={w * 0.84} height={1}
          fill={BAND_FILL[tapeScoreBand(s)]}
          opacity={0.9}
        />
      ))}
    </svg>
  )
}

/**
 * Split a cumulative line into maximal same-sign runs so it can be drawn green
 * while the running total is ≥ 0 and red while it's < 0. Edges that straddle
 * zero are cut at the interpolated zero-crossing so the color flips exactly on
 * the axis. Returns one SVG path `d` string per run.
 *
 * Module-level (not in the component) so its local mutation/accumulation isn't
 * subject to the React Compiler immutability rule. Coordinates are in the SVG's
 * 0-100 viewBox space (xAt/yAt supplied by the caller).
 *
 * Each run also returns `area` — the same path closed down to the zero axis, so
 * the curve can be shaded under (green above zero, red below) without the fill
 * ever crossing the axis into the wrong colour.
 */
function signedLineSegments(
  values: number[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): { color: string; d: string; area: string }[] {
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
  const zeroY = yAt(0).toFixed(3)
  return runs.map(r => {
    const d = r.pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ')
    const first = r.pts[0], last = r.pts[r.pts.length - 1]
    return {
      color: r.color,
      d,
      area: `${d} L${last[0].toFixed(3)},${zeroY} L${first[0].toFixed(3)},${zeroY} Z`,
    }
  })
}

interface Props {
  days: DayStat[]
  /** Starting range before the user's saved preference loads. The Dashboard
   *  passes 'all' so the equity curve matches the all-time stat total. */
  defaultPeriod?: Period
}

export default function DashboardCharts({ days, defaultPeriod = 'ytd' }: Props) {
  const [period, setPeriod] = useState<Period>(defaultPeriod)
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

  const { points, equity, daily, scores } = useMemo(() => {
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
    // TapeScore per day, aligned index-for-index with the equity series. Null on
    // days with no EOD analysis — the overlay breaks rather than interpolating.
    const scores = inPeriod.map(d => d.tapescore?.score ?? null)
    return { points, equity, daily, scores }
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
        {/* Equity Curve (cumulative). Container matches the stat tiles —
            no fill, hairline rule, squared corner. */}
        <div className="border border-gray-800 rounded-[3px] p-5">
          <div className="flex items-baseline justify-between mb-3 gap-3">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <h2 className="font-semibold text-white text-sm">Equity Curve</h2>
              {/* Legend only when there's actually a score series to explain. */}
              {scores.some(s => s != null) && (
                <span
                  className="flex items-center gap-1.5 text-[10px] text-gray-500 whitespace-nowrap"
                  title="Process curve: each scored session adds its TapeScore minus 50, so sessions above par build the curve and sessions below erode it — an equity curve for your decisions. Compare SLOPES, not heights: when the dashed line climbs, you were trading well, and the money should follow. The band underneath is each session's raw score (red under 50, amber 50-69, green 70+); a gap there means that session was never analysed."
                >
                  <span className="inline-block w-3.5 border-t border-dashed" style={{ borderColor: PROC_BLUE }} />
                  Process curve
                </span>
              )}
            </div>
            {hasData && (
              <span className={`text-xs font-mono ${equity[equity.length - 1] >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {fmtMoney(equity[equity.length - 1], { signed: true })}
              </span>
            )}
          </div>
          {hasData ? (
            <EquityChart dates={points} values={equity} scores={scores} height={210} />
          ) : (
            <div className="text-center text-xs text-gray-600 italic py-16">No closed sessions in this range</div>
          )}
        </div>

        {/* Daily Results (per-day net P&L bars) */}
        <div className="border border-gray-800 rounded-[3px] p-5">
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
  height, yMin, yMax, yTicks, xLabels, strip, children,
}: {
  height: number
  yMin: number
  yMax: number
  yTicks: number[]
  xLabels: string[]
  /** Optional band rendered between the plot and the X labels, sharing the
   *  plot's exact horizontal extent (so column i lines up with point i). */
  strip?: React.ReactNode
  children: React.ReactNode
}) {
  const span = yMax - yMin || 1
  const fracY = (v: number) => (v - yMin) / span
  const n = xLabels.length
  // Reserve height only when a strip is present, so the chart without one
  // (Daily Results) keeps its exact previous geometry.
  const STRIP_H = 7
  const STRIP_GAP = 5
  const bottomTotal = M.bottom + (strip ? STRIP_H + STRIP_GAP : 0)
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
            top: `calc(${M.top}px + ${(1 - fracY(v)).toFixed(4)} * (100% - ${M.top + bottomTotal}px))`,
            transform: 'translateY(-50%)',
          }}
        >
          {fmtMoney(v)}
        </div>
      ))}

      {/* Plot area */}
      <div
        className="absolute"
        style={{ left: M.left, right: M.right, top: M.top, bottom: bottomTotal }}
      >
        {children}
      </div>

      {/* Score strip — same left/right insets as the plot, so a column sits
          directly under the session it belongs to. */}
      {strip && (
        <div
          className="absolute rounded-[1px] overflow-hidden"
          style={{ left: M.left, right: M.right, bottom: M.bottom + STRIP_GAP - 2, height: STRIP_H }}
        >
          {strip}
        </div>
      )}

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
function EquityChart({ dates, values, scores = [], height }: {
  dates: string[]
  values: number[]
  /** TapeScore per day, index-aligned with `values`; null = unscored day. */
  scores?: (number | null)[]
  height: number
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const { niceMin, niceMax, ticks } = niceScale(lo, hi, 4)
  const span = niceMax - niceMin || 1

  const n = values.length
  const xAt = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100)
  const yAt = (v: number) => (1 - (v - niceMin) / span) * 100

  const segments = signedLineSegments(values, xAt, yAt)

  const hasScores = scores.some(s => s != null)

  // Process curve, fitted to the plot box. Fitting is safe here in a way it
  // wasn't for the daily line: both series are cumulative from zero, so scaling
  // changes the amplitude but never the DIRECTION of a slope — and direction is
  // the entire claim ("good process, curve climbs"). No numeric axis is drawn,
  // because the comparison is of shape, not level; the running value is in the
  // hover readout instead.
  const proc = hasScores ? processCurve(scores) : null
  const procPts = proc && proc.firstIdx >= 0 ? proc.values.slice(proc.firstIdx) : []
  const procLo = procPts.length ? Math.min(...procPts) : 0
  const procHi = procPts.length ? Math.max(...procPts) : 0
  const procSpan = procHi - procLo || 1
  // Inset 6% top and bottom so the curve can't collide with the plot edges.
  const yProc = (v: number) => 94 - ((v - procLo) / procSpan) * 88
  const procPath = procPts.length >= 2
    ? procPts.map((v, k) => `${k === 0 ? 'M' : 'L'}${xAt(k + (proc?.firstIdx ?? 0)).toFixed(3)},${yProc(v).toFixed(3)}`).join(' ')
    : null

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const w = e.currentTarget.clientWidth
    if (w <= 0 || n === 0) return
    const frac = Math.min(1, Math.max(0, e.nativeEvent.offsetX / w))
    setHoverIdx(n <= 1 ? 0 : Math.round(frac * (n - 1)))
  }

  return (
    <ChartFrame
      height={height} yMin={niceMin} yMax={niceMax} yTicks={ticks} xLabels={dates}
      strip={hasScores ? <ScoreStrip scores={scores} /> : undefined}
    >
      <div className="relative w-full h-full">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full" style={{ pointerEvents: 'none' }}>
          <defs>
            {/* Per-path bounding-box gradients: the fill is densest AT the line
                and fades toward the axis. The red stops are reversed because a
                below-zero area hangs downward from the axis. */}
            <linearGradient id="eqFillPos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={GREEN} stopOpacity="0.15" />
              <stop offset="1" stopColor={GREEN} stopOpacity="0.015" />
            </linearGradient>
            <linearGradient id="eqFillNeg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={RED} stopOpacity="0.015" />
              <stop offset="1" stopColor={RED} stopOpacity="0.15" />
            </linearGradient>
          </defs>
          <Gridlines yMin={niceMin} yMax={niceMax} yTicks={ticks} />
          {segments.map((s, i) => (
            <path key={`a${i}`} d={s.area} fill={s.color === GREEN ? 'url(#eqFillPos)' : 'url(#eqFillNeg)'} stroke="none" />
          ))}
          {/* Process curve — dashed and thinner than the equity stroke so money
              stays the primary read and the two are never confused. */}
          {procPath && (
            <path
              d={procPath} fill="none" stroke={PROC_BLUE}
              strokeWidth="0.5" strokeDasharray="2 1.6" strokeLinecap="round" strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
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
            {scores[hoverIdx] != null && (
              // Banded like the strip below and the score ring, so the number
              // and its colour agree wherever the session shows up.
              <div className="text-[10px] font-mono" style={{ color: BAND_FILL[tapeScoreBand(scores[hoverIdx] as number)] }}>
                TapeScore {scores[hoverIdx]}
              </div>
            )}
            {/* The process curve has no axis, so its running total is given
                here — otherwise the dashed line's height means nothing. */}
            {proc && proc.firstIdx >= 0 && hoverIdx >= proc.firstIdx && (
              <div className="text-[10px] font-mono" style={{ color: PROC_BLUE }}>
                Process {proc.values[hoverIdx] >= 0 ? '+' : ''}{Math.round(proc.values[hoverIdx])}
              </div>
            )}
          </div>
        )}
      </div>
    </ChartFrame>
  )
}

/** Per-day net P&L bars (green up / red down) with a hover tooltip showing the
 *  day + P&L (the native <title> was slow and unreliable). */
function BarsChart({ bars, height }: { bars: { date: string; pnl: number }[]; height: number }) {
  const router = useRouter()
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

  const idxFromEvent = (e: React.MouseEvent<HTMLDivElement>): number | null => {
    const w = e.currentTarget.clientWidth
    if (w <= 0 || n === 0) return null
    const frac = Math.min(0.9999, Math.max(0, e.nativeEvent.offsetX / w))
    return Math.min(n - 1, Math.floor(frac * n))
  }
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const i = idxFromEvent(e)
    if (i != null) setHoverIdx(i)
  }
  // Click a bar → jump to that day's EOD Recap to study it.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const i = idxFromEvent(e)
    if (i != null) router.push(`/review/today/${bars[i].date}`)
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

        {/* Hover capture + tooltip. Click a bar to open that day's EOD Recap. */}
        <div className="absolute inset-0 cursor-pointer" onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)} onClick={onClick} />
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
              <div className="text-[9px] text-gray-500 mt-0.5">Click to open day →</div>
            </div>
          )
        })()}
      </div>
    </ChartFrame>
  )
}
