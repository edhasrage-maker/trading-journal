'use client'

/**
 * Minimal SVG line chart with one or more series. Designed for cumulative
 * equity curves, rolling stats, etc. Y-axis scale is shared across series.
 */

export interface LineSeries {
  label: string
  color: string
  /** Y values, indexed by the same X dimension as other series. Length must match xLabels. */
  values: (number | null)[]
}

interface Props {
  xLabels: string[]
  series: LineSeries[]
  height?: number
  /** Format y-axis tick labels */
  formatY?: (v: number) => string
  /** If true, draw a horizontal zero line */
  zeroLine?: boolean
  /** Number of horizontal gridlines (excluding axes) */
  gridLines?: number
  /** Show a legend below the chart */
  showLegend?: boolean
}

export default function LineChart({
  xLabels,
  series,
  height = 220,
  formatY = v => v.toFixed(0),
  zeroLine = false,
  gridLines = 4,
  showLegend = true,
}: Props) {
  const allValues = series.flatMap(s => s.values).filter((v): v is number => v != null && Number.isFinite(v))
  if (allValues.length === 0 || xLabels.length === 0) {
    return <div className="text-center text-xs text-gray-600 italic py-6">No data</div>
  }
  const minV = Math.min(...allValues, zeroLine ? 0 : Infinity)
  const maxV = Math.max(...allValues, zeroLine ? 0 : -Infinity)
  const finiteMin = Number.isFinite(minV) ? minV : 0
  const finiteMax = Number.isFinite(maxV) ? maxV : 1
  const span = Math.max(0.0001, finiteMax - finiteMin)

  // Padding inside the 0-100 viewBox so labels have room
  const padTop = 4, padBottom = 4, padLeft = 8, padRight = 2
  const innerW = 100 - padLeft - padRight
  const innerH = 100 - padTop - padBottom

  const xAt = (i: number) => padLeft + (xLabels.length === 1 ? innerW / 2 : (i / (xLabels.length - 1)) * innerW)
  const yAt = (v: number) => padTop + innerH - ((v - finiteMin) / span) * innerH

  const gridYs: { v: number; y: number }[] = []
  for (let i = 0; i <= gridLines; i++) {
    const v = finiteMin + (span * i) / gridLines
    gridYs.push({ v, y: yAt(v) })
  }

  return (
    <div className="w-full">
      <div style={{ height }}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="w-full h-full"
        >
          {/* Gridlines */}
          {gridYs.map(({ y }, i) => (
            <line
              key={i}
              x1={padLeft} x2={100 - padRight}
              y1={y} y2={y}
              stroke="#1f2937"
              strokeWidth="0.15"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Zero line */}
          {zeroLine && finiteMin < 0 && finiteMax > 0 && (
            <line
              x1={padLeft} x2={100 - padRight}
              y1={yAt(0)} y2={yAt(0)}
              stroke="#4b5563"
              strokeWidth="0.25"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="0.6 0.6"
            />
          )}

          {/* Series */}
          {series.map(s => {
            const segments: string[] = []
            let inSegment = false
            s.values.forEach((v, i) => {
              if (v == null || !Number.isFinite(v)) {
                inSegment = false
                return
              }
              const cmd = inSegment ? 'L' : 'M'
              segments.push(`${cmd}${xAt(i).toFixed(3)},${yAt(v).toFixed(3)}`)
              inSegment = true
            })
            return (
              <path
                key={s.label}
                d={segments.join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth="0.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
      </div>

      {/* Y axis tick legend (text only, below chart) */}
      <div className="flex justify-between text-[10px] text-gray-600 mt-1 font-mono">
        <span>{formatY(finiteMin)}</span>
        <span>{formatY((finiteMin + finiteMax) / 2)}</span>
        <span>{formatY(finiteMax)}</span>
      </div>

      {/* X axis sample labels: first, middle, last */}
      {xLabels.length > 0 && (
        <div className="flex justify-between text-[10px] text-gray-600 font-mono">
          <span>{xLabels[0]}</span>
          {xLabels.length > 2 && <span>{xLabels[Math.floor(xLabels.length / 2)]}</span>}
          {xLabels.length > 1 && <span>{xLabels[xLabels.length - 1]}</span>}
        </div>
      )}

      {/* Legend */}
      {showLegend && series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]">
          {series.map(s => (
            <div key={s.label} className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: s.color }} />
              <span className="text-gray-300">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
