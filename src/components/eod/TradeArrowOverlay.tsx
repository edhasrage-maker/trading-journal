'use client'

import { useMemo } from 'react'
import { tradeToPixelPct, pointToPixelPct } from '@/lib/eod-transforms'
import type { ChartCalibration, Trade, TradeExit } from '@/lib/supabase/types'

interface Props {
  trades: Trade[]
  calibration: ChartCalibration
  hoveredTradeId: string | null
  onHoverEnter: (tradeId: string, e: React.MouseEvent) => void
  onHoverLeave: () => void
  onClick?: (tradeId: string) => void
}

interface PlacedExit {
  x_pct: number
  y_pct: number
  price: number
  qty: number
  favorable: boolean  // exit price beat entry price (long: above; short: below)
}

interface PlacedTrade {
  trade: Trade
  entry: { x_pct: number; y_pct: number }
  exits: PlacedExit[]
}

const ARROW_SIZE = 16
const EXIT_R = 5

const inBounds = (p: { x_pct: number; y_pct: number }) =>
  p.x_pct >= 0 && p.x_pct <= 100 && p.y_pct >= 0 && p.y_pct <= 100

/**
 * Derive the list of exit points to render. Prefers exits_json (per-fill
 * partial exits from the SC importer); falls back to the aggregated single
 * exit_time/exit_price pair for older trades that pre-date exits_json.
 */
function getExitList(trade: Trade): TradeExit[] {
  if (Array.isArray(trade.exits_json) && trade.exits_json.length > 0) {
    return trade.exits_json
  }
  if (trade.exit_time && trade.exit_price != null) {
    return [{ time: trade.exit_time, price: trade.exit_price, qty: trade.quantity ?? 0 }]
  }
  return []
}

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
      const exitList = getExitList(trade)
      const isLong = trade.direction === 'long'
      const placedExits: PlacedExit[] = []
      for (const exit of exitList) {
        const pos = pointToPixelPct({ time: exit.time, price: exit.price }, calibration)
        if (!pos || !inBounds(pos)) continue
        const favorable = trade.entry_price != null
          ? (isLong ? exit.price > trade.entry_price : exit.price < trade.entry_price)
          : true
        placedExits.push({ x_pct: pos.x_pct, y_pct: pos.y_pct, price: exit.price, qty: exit.qty, favorable })
      }
      out.push({ trade, entry, exits: placedExits })
    }
    return out
  }, [trades, calibration])

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5 }}>
      {placed.map(({ trade, entry, exits }) => {
        const isLong = trade.direction === 'long'
        const isHovered = hoveredTradeId === trade.id
        const color = isLong ? '#22c55e' : '#ef4444'
        const pnl = trade.pnl ?? 0
        const half = ARROW_SIZE / 2
        const points = isLong
          ? `${half},2 ${ARROW_SIZE - 1},${ARROW_SIZE - 2} 1,${ARROW_SIZE - 2}`
          : `${half},${ARROW_SIZE - 2} ${ARROW_SIZE - 1},2 1,2`

        return (
          <div key={trade.id}>
            {/* Entry arrow + PnL label */}
            <div
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

            {/* Per-exit qty labels — small annotation next to each exit circle. */}
            {exits.map((exit, i) => (
              <div
                key={`label-${trade.id}-${i}`}
                className="absolute pointer-events-none"
                style={{
                  left: `${exit.x_pct}%`,
                  top: `${exit.y_pct}%`,
                  transform: `translate(9px, -50%)`,
                  zIndex: 7,
                }}
              >
                <span className="text-[9px] font-mono font-bold text-gray-100 bg-gray-900/90 px-1 rounded whitespace-nowrap">
                  ×{exit.qty}
                </span>
              </div>
            ))}
          </div>
        )
      })}

      {/* Exit layer rendered LAST so it paints on top of the entry arrows +
          PnL labels — otherwise a loss exit sitting just below/near its
          entry gets hidden behind them. pointer-events-none keeps the entry
          arrows underneath clickable. Lines at 75% opacity baseline, 100%
          on hover. */}
      <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none', zIndex: 6 }}>
        {placed.map(({ trade, entry, exits }) =>
          exits.map((exit, i) => {
            const color = exit.favorable ? '#22c55e' : '#ef4444'
            return (
              <g key={`exit-${trade.id}-${i}`} opacity={hoveredTradeId === trade.id ? 1 : 0.75}>
                <line
                  x1={`${entry.x_pct}%`}
                  y1={`${entry.y_pct}%`}
                  x2={`${exit.x_pct}%`}
                  y2={`${exit.y_pct}%`}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                <circle
                  cx={`${exit.x_pct}%`}
                  cy={`${exit.y_pct}%`}
                  r={EXIT_R}
                  fill="#0a0a0a"
                  stroke={color}
                  strokeWidth={2}
                />
              </g>
            )
          }),
        )}
      </svg>
    </div>
  )
}
