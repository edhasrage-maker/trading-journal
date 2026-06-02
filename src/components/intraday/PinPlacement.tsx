'use client'

export type PinType = 'entry' | 'stop' | 'tp1'
export interface Pin { x: number; y: number }

interface Props {
  imageUrl: string
  pins: Partial<Record<PinType, Pin>>
}

const PIN_CFG: Record<PinType, { color: string; short: string }> = {
  entry: { color: '#22c55e', short: 'E' },
  stop:  { color: '#ef4444', short: 'S' },
  tp1:   { color: '#eab308', short: 'T' },
}

/**
 * Display-only trade screenshot with pin overlay. The interactive
 * "click-to-place a pin" UI was removed once /api/extract-trade started
 * auto-detecting entry/stop/TP1 prices from the screenshot — manual visual
 * marking became redundant. Legacy trades with saved entry_pin_x/y etc.
 * still render here so historical journal data isn't lost.
 */
export default function PinPlacement({ imageUrl, pins }: Props) {
  return (
    <div className="relative rounded-xl overflow-hidden border border-gray-700 bg-gray-900">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl} alt="Trade screenshot" className="w-full object-contain max-h-[480px]" />
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
        {(Object.entries(pins) as [PinType, Pin][]).map(([type, pin]) => {
          const cfg = PIN_CFG[type]
          return (
            <g key={type}>
              <circle cx={`${pin.x}%`} cy={`${pin.y}%`} r="10" fill={cfg.color} fillOpacity="0.85" stroke="white" strokeWidth="2" />
              <text x={`${pin.x}%`} y={`${pin.y}%`} textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize="9" fontWeight="bold">{cfg.short}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
