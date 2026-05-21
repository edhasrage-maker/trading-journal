'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import type { Trade } from '@/lib/supabase/types'

interface Props {
  trade: Trade | null
  cursor: { clientX: number; clientY: number } | null
}

const POPUP_WIDTH = 380
const OFFSET = 16

export default function HoverPopup({ trade, cursor }: Props) {
  const popupRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!cursor || !popupRef.current) {
      setPos(null)
      return
    }
    const rect = popupRef.current.getBoundingClientRect()
    const w = rect.width || POPUP_WIDTH
    const h = rect.height || 200
    let left = cursor.clientX + OFFSET
    let top = cursor.clientY + OFFSET
    if (left + w > window.innerWidth - 8) left = cursor.clientX - OFFSET - w
    if (top + h > window.innerHeight - 8) top = cursor.clientY - OFFSET - h
    if (left < 8) left = 8
    if (top < 8) top = 8
    setPos({ left, top })
  }, [cursor, trade])

  if (!trade || !cursor) return null

  const direction = trade.direction
  const pnl = trade.pnl ?? 0

  return (
    <div
      ref={popupRef}
      className="fixed bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 pointer-events-none"
      style={{
        zIndex: 100,
        width: POPUP_WIDTH,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: pos ? 1 : 0,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-400 font-mono">
            {trade.entry_time ? format(new Date(trade.entry_time), 'HH:mm:ss') : '--:--:--'}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded text-xs font-bold ${
              direction === 'long'
                ? 'bg-green-900/50 text-green-300'
                : 'bg-red-900/50 text-red-300'
            }`}
          >
            {direction?.toUpperCase() ?? '--'}
          </span>
          <span className="text-gray-300 font-mono text-xs">
            @ {trade.entry_price ?? '--'} × {trade.quantity ?? '--'}
          </span>
        </div>
        <span
          className={`font-mono text-sm font-bold ${
            pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400'
          }`}
        >
          {pnl >= 0 ? '+' : ''}
          {pnl.toFixed(2)}
        </span>
      </div>

      {trade.screenshot_url ? (
        <div className="relative rounded-lg overflow-hidden border border-gray-700 bg-gray-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={trade.screenshot_url}
            alt="Trade entry"
            className="w-full object-contain max-h-60 block"
          />
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {(
              [
                { key: 'entry', x: trade.entry_pin_x, y: trade.entry_pin_y, color: '#22c55e', short: 'E' },
                { key: 'stop', x: trade.stop_pin_x, y: trade.stop_pin_y, color: '#ef4444', short: 'S' },
                { key: 'tp1', x: trade.tp1_pin_x, y: trade.tp1_pin_y, color: '#eab308', short: 'T' },
              ] as const
            ).map(p =>
              p.x != null && p.y != null ? (
                <g key={p.key}>
                  <circle
                    cx={`${p.x}%`}
                    cy={`${p.y}%`}
                    r="9"
                    fill={p.color}
                    fillOpacity="0.85"
                    stroke="white"
                    strokeWidth="1.5"
                  />
                  <text
                    x={`${p.x}%`}
                    y={`${p.y}%`}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="white"
                    fontSize="8"
                    fontWeight="bold"
                  >
                    {p.short}
                  </text>
                </g>
              ) : null,
            )}
          </svg>
        </div>
      ) : (
        <div className="text-xs text-gray-500 bg-gray-950 rounded-lg border border-gray-800 p-3 space-y-1">
          <div className="flex justify-between">
            <span>Stop</span>
            <span className="font-mono">{trade.stop_price ?? '--'}</span>
          </div>
          <div className="flex justify-between">
            <span>TP1</span>
            <span className="font-mono">{trade.tp1_price ?? '--'}</span>
          </div>
          <div className="text-gray-600 italic mt-2">No screenshot for this trade</div>
        </div>
      )}

      {trade.notes && (
        <div className="mt-2 text-xs text-gray-300 bg-gray-950 rounded px-2 py-1.5 border border-gray-800 line-clamp-3">
          {trade.notes}
        </div>
      )}
    </div>
  )
}
