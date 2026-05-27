'use client'

import { useMemo } from 'react'
import { tradeToPixelPct, tradeExitToPixelPct } from '@/lib/eod-transforms'
import type { ChartCalibration, Trade } from '@/lib/supabase/types'

interface Props {
  trades: Trade[]
  calibration: ChartCalibration
  hoveredTradeId: string | null
  onHoverEnter: (tradeId: string, e: React.MouseEvent) => void
  onHoverLeave: () => void
  onClick?: (tradeId: string) => void
}

interface PlacedTrade {
  trade: Trade
  entry: { x_pct: number; y_pct: number }
  exit: { x_pct: number; y_pct: number } | null
}

const ARROW_SIZE = 16
const EXIT_R = 5 // exit-marker radius in px

const inBounds = (p: { x_pct: number; y_pct: number }) =>
  p.x_pct >= 0 && p.x_pct <= 100 && p.y_pct >= 0 && p.y_pct <= 100

export default function TradeArrowOverlay({
  trades,
  calibration,
  hoveredTradeId,
  onHoverEnter,
  onHoverLeave,
  onClick,
}: Props) {
  const placed = useMemo<PlacedTrade[]>(() => {
    const out: PlacedTrade[] = []
    for (const trade of trades) {
      const entry = tradeToPixelPct(trade, calibration)
      if (!entry || !inBounds(entry)) continue
      const exit = tradeExitToPixelPct(trade, calibration)
      const exitInBounds = exit && inBounds(exit) ? exit : null
      out.push({ trade, entry, exit: exitInBounds })
    }
    return out
  }, [trades, calibration])

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
      {/* SVG overlay covering the whole image — used for the entry→exit
          connecting lines and the hollow-circle exit markers. Per-trade
          entry triangles + PnL labels stay as positioned divs (they need
          per-element hover/click and CSS transforms). */}
      <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
        {placed.map(({ trade, entry, exit }) => {
          if (!exit) return null
          const pnl = trade.pnl ?? 0
          const lineColor = pnl > 0 ? '#22c55e' : pnl < 0 ? '#ef4444' : '#9ca3af'
          return (
            <g key={`line-${trade.id}`} opacity={hoveredTradeId === trade.id ? 1 : 0.55}>
              <line
                x1={`${entry.x_pct}%`}
                y1={`${entry.y_pct}%`}
                x2={`${exit.x_pct}%`}
                y2={`${exit.y_pct}%`}
                stroke={lineColor}
                strokeWidth={1.5}
                strokeDasharray="3 3"
              />
              <circle
                cx={`${exit.x_pct}%`}
                cy={`${exit.y_pct}%`}
                r={EXIT_R}
                fill="#0a0a0a"
                stroke={lineColor}
                strokeWidth={2}
              />
            </g>
          )
        })}
      </svg>

      {placed.map(({ trade, entry }) => {
        const isLong = trade.direction === 'long'
        const isHovered = hoveredTradeId === trade.id
        const color = isLong ? '#22c55e' : '#ef4444'
        const pnl = trade.pnl ?? 0
        // Triangle points (relative to local SVG coords, ARROW_SIZE box)
        const half = ARROW_SIZE / 2
        const points = isLong
          ? `${half},2 ${ARROW_SIZE - 1},${ARROW_SIZE - 2} 1,${ARROW_SIZE - 2}`   // up
          : `${half},${ARROW_SIZE - 2} ${ARROW_SIZE - 1},2 1,2`                    // down

        return (
          <div
            key={trade.id}
            className="absolute pointer-events-auto cursor-pointer transition-transform"
            style={{
              left: `${entry.x_pct}%`,
              top: `${entry.y_pct}%`,
              transform: `translate(-50%, -50%) ${isHovered ? 'scale(1.4)' : 'scale(1)'}`,
            }}
            onMouseEnter={e => onHoverEnter(trade.id, e)}
            onMouseLeave={onHoverLeave}
            onClick={() => onClick?.(trade.id)}
          >
            <svg width={ARROW_SIZE} height={ARROW_SIZE} className="block drop-shadow">
              <polygon
                points={points}
                fill={color}
                stroke="white"
                strokeWidth={1.25}
                fillOpacity={isHovered ? 1 : 0.85}
              />
            </svg>
            {/* PnL label */}
            <div
              className="absolute left-1/2 -translate-x-1/2 mt-0.5 px-1 rounded text-[10px] font-mono font-bold whitespace-nowrap"
              style={{
                top: '100%',
                color: 'white',
                backgroundColor: pnl >= 0 ? 'rgba(22, 163, 74, 0.85)' : 'rgba(220, 38, 38, 0.85)',
              }}
            >
              {pnl >= 0 ? '+' : ''}
              {pnl.toFixed(0)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
