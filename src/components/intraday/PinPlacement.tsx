'use client'

import { useRef, useCallback } from 'react'

export type PinType = 'entry' | 'stop' | 'tp1'
export interface Pin { x: number; y: number }

interface Props {
  imageUrl: string
  pins: Partial<Record<PinType, Pin>>
  activePin: PinType | null
  onActivate: (type: PinType) => void
  onPlace: (type: PinType, pin: Pin) => void
  onClear: (type: PinType) => void
}

const PIN_CFG: Record<PinType, { label: string; short: string; color: string; activeBg: string; placedBg: string }> = {
  entry: { label: 'Entry',  short: 'E', color: '#22c55e', activeBg: '#14532d', placedBg: '#052e16' },
  stop:  { label: 'Stop',   short: 'S', color: '#ef4444', activeBg: '#7f1d1d', placedBg: '#450a0a' },
  tp1:   { label: 'TP1',    short: 'T', color: '#eab308', activeBg: '#713f12', placedBg: '#422006' },
}

export default function PinPlacement({ imageUrl, pins, activePin, onActivate, onPlace, onClear }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!activePin || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    onPlace(activePin, { x, y })
  }, [activePin, onPlace])

  return (
    <div className="space-y-2">
      {/* Pin selector buttons */}
      <div className="flex gap-2 flex-wrap">
        {(Object.entries(PIN_CFG) as [PinType, typeof PIN_CFG[PinType]][]).map(([type, cfg]) => {
          const placed = !!pins[type]
          const active = activePin === type
          return (
            <div key={type} className="flex items-center">
              <button type="button" onClick={() => onActivate(type)}
                style={{
                  borderColor: active || placed ? cfg.color : '#374151',
                  background: active ? cfg.activeBg : placed ? cfg.placedBg : 'transparent',
                  color: active || placed ? cfg.color : '#6b7280',
                  borderRadius: placed ? '0.5rem 0 0 0.5rem' : '0.5rem',
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-2 border-r-0 transition-all"
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: active || placed ? cfg.color : '#4b5563', display: 'inline-block', flexShrink: 0 }} />
                {cfg.label}
                {placed && <span style={{ color: cfg.color }}>✓</span>}
                {active && <span className="text-gray-400 ml-1">← click chart</span>}
              </button>
              {placed && (
                <button type="button"
                  onClick={e => { e.stopPropagation(); onClear(type) }}
                  style={{ borderColor: cfg.color, background: cfg.placedBg, color: cfg.color, borderRadius: '0 0.5rem 0.5rem 0' }}
                  className="flex items-center px-1.5 py-1.5 text-xs border-2 transition-all hover:opacity-70"
                  title={`Clear ${cfg.label} pin`}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        {activePin && (
          <button type="button" onClick={() => onActivate(activePin)}
            className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1.5 transition-colors">
            Cancel
          </button>
        )}
      </div>

      {/* Image + SVG pin overlay */}
      <div
        ref={containerRef}
        onClick={handleClick}
        className={`relative rounded-xl overflow-hidden border border-gray-700 bg-gray-900 ${activePin ? 'cursor-crosshair ring-2 ring-blue-500/50' : 'cursor-default'}`}
      >
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
    </div>
  )
}
