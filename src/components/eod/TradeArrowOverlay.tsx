'use client'

import { useMemo } from 'react'
import { tradeToPixelPct } from '@/lib/eod-transforms'
import type { ChartCalibration, Trade } from '@/lib/supabase/types'

interface Props {
  trades: Trade[]
  calibration: ChartCalibration
  hoveredTradeId: string | null
  onHoverEnter: (tradeId: string, e: React.MouseEvent) => void
  onHoverLeave: () => void
  onClick?: (tradeId: string) => void
}

interface PlacedArrow {
  trade: Trade
  x_pct: number
  y_pct: number
}

const ARROW_SIZE = 16

export default function TradeArrowOverlay({
  trades,
  calibration,
  hoveredTradeId,
  onHoverEnter,
  onHoverLeave,
  onClick,
}: Props) {
  const arrows = useMemo<PlacedArrow[]>(() => {
    const out: PlacedArrow[] = []
    for (const trade of trades) {
      const pos = tradeToPixelPct(trade, calibration)
      if (!pos) continue
      if (pos.x_pct < 0 || pos.x_pct > 100 || pos.y_pct < 0 || pos.y_pct > 100) continue
      out.push({ trade, x_pct: pos.x_pct, y_pct: pos.y_pct })
    }
    return out
  }, [trades, calibration])

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
      {arrows.map(({ trade, x_pct, y_pct }) => {
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
              left: `${x_pct}%`,
              top: `${y_pct}%`,
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
