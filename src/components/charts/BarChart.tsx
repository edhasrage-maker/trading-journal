'use client'

/**
 * Minimal SVG bar chart. Pure presentational — no interactivity beyond a hover
 * tooltip on each bar via the native title attribute.
 */

interface BarDatum {
  label: string
  value: number
  /** Optional explicit color override; otherwise green (positive) / red (negative). */
  color?: string
  /** Optional secondary text shown below the value */
  hint?: string
}

interface Props {
  data: BarDatum[]
  height?: number
  formatValue?: (v: number) => string
  /** Show the value as a label inside / above each bar */
  showValueLabels?: boolean
  /** Diverging (negative bars hang below the axis) vs all-positive */
  diverging?: boolean
}

export default function BarChart({
  data,
  height = 240,
  formatValue = v => v.toFixed(0),
  showValueLabels = true,
  diverging = true,
}: Props) {
  if (data.length === 0) {
    return (
      <div className="text-center text-xs text-gray-600 italic py-6">No data</div>
    )
  }

  const values = data.map(d => d.value)
  const minVal = Math.min(0, ...values)
  const maxVal = Math.max(0, ...values)
  const range = Math.max(0.0001, maxVal - minVal)
  const barWidth = 100 / data.length
  const innerPad = 0.18 // fraction of slot reserved as gap on each side
  const axisY = diverging
    ? ((maxVal) / range) * 100
    : 100

  return (
    // Outer wrapper no longer constrains height — the SVG box does. Otherwise
    // the labels grid below would overflow and overlap whatever element sits
    // beneath the chart (in ConditionCard's case, the BucketTable header
    // landing on top of "-$450").
    <div className="w-full">
      <div style={{ height }}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="w-full h-full"
      >
        {/* Zero axis */}
        {diverging && (
          <line
            x1="0"
            x2="100"
            y1={axisY}
            y2={axisY}
            stroke="#374151"
            strokeWidth="0.2"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {data.map((d, i) => {
          const slotL = i * barWidth
          const x = slotL + barWidth * innerPad
          const w = barWidth * (1 - innerPad * 2)
          let y, h
          const color = d.color ?? (d.value >= 0 ? '#22c55e' : '#ef4444')
          if (diverging) {
            if (d.value >= 0) {
              y = axisY - (d.value / range) * 100
              h = (d.value / range) * 100
            } else {
              y = axisY
              h = (Math.abs(d.value) / range) * 100
            }
          } else {
            const norm = (d.value - minVal) / range
            h = norm * 100
            y = 100 - h
          }
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={w}
                height={Math.max(0.5, h)}
                fill={color}
                opacity={0.85}
              >
                {/* React 19 / Next 16 require a single string child for <title>; */}
                {/* mixing text + interpolations creates a children array which */}
                {/* triggers a hydration mismatch on the server boundary. */}
                <title>{`${d.label}: ${formatValue(d.value)}${d.hint ? ` · ${d.hint}` : ''}`}</title>
              </rect>
            </g>
          )
        })}
      </svg>
      </div>

      {/* Labels row (HTML, not SVG, so it's readable across responsive widths) */}
      <div className="grid mt-1.5 gap-px" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
        {data.map((d, i) => (
          <div key={i} className="text-center">
            <div className="text-[10px] text-gray-400 truncate" title={d.label}>{d.label}</div>
            {showValueLabels && (
              <div className={`text-[10px] font-mono ${d.value >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {formatValue(d.value)}
              </div>
            )}
            {d.hint && (
              <div className="text-[9px] text-gray-600 truncate" title={d.hint}>{d.hint}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
