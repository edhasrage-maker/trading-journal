'use client'

import { useMfeUnit, formatMfeMae, type MfeUnit } from '@/lib/mfe-unit'
import {
  mgmtView, mgmtBarGeometry, formatKept,
  type MgmtTotals, type MgmtGroupView,
} from '@/lib/trade-management'

/**
 * The trade-management card — one component for the dashboard (a period) and
 * the recap (a day), so the two can never drift into different wording or
 * different arithmetic.
 *
 * It replaces "Avg MFE / MAE · kept N% of the move ≈ X", which stitched three
 * numbers that did not belong together: an average of daily averages, a
 * percentage over a subset of the trades with losers counted as zero, and the
 * two multiplied. Here every figure is counted over the trades themselves and
 * the lines add up: (went × its result) + (never × its result) = net.
 *
 * Both bars share ONE scale and ONE entry line — red (heat) runs left of entry,
 * green (the run) right of it; the solid part is what was kept or lost.
 */

interface Props {
  totals: MgmtTotals
  /** Outer class. Defaults to the dashboard's blend-in stat tile. */
  className?: string
}

const UNIT_OPTIONS: { value: MfeUnit; label: string }[] = [
  { value: 'pts', label: 'pts per trade' },
  { value: 'dollars', label: '$ per trade' },
  { value: 'atr', label: '× ATR per trade' },
]

const plural = (n: number) => (n === 1 ? '' : 's')

export default function TradeManagementCard({ totals, className }: Props) {
  const [unit, setUnit] = useMfeUnit()
  const v = mgmtView(totals, unit)
  const scale = {
    maxMae: Math.max(v.went.mae ?? 0, v.never.mae ?? 0),
    maxMfe: Math.max(v.went.mfe ?? 0, v.never.mfe ?? 0),
  }
  const fmt = (x: number | null) => formatMfeMae(x, unit)

  return (
    <div className={className ?? 'border border-gray-800 rounded-[3px] p-[18px]'}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <p
          className="text-xs text-gray-500 whitespace-nowrap"
          title="Every trade is sorted first: did it go at least 1×ATR your way at some point, or not? MFE is the best point it reached, MAE the worst. Kept is what you banked out of the run, losses included."
        >
          Trade management
        </p>
        <select
          aria-label="Unit"
          value={unit}
          onChange={e => setUnit(e.target.value as MfeUnit)}
          className="bg-gray-800 border border-gray-700 text-gray-400 text-[10px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight"
          title="Display unit (shared across the app)"
        >
          {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {v.classified === 0 ? (
        <p className="text-sm text-gray-500">
          {v.unclassified > 0
            ? `No price data behind ${v.unclassified === 1 ? 'this trade' : 'these trades'} yet.`
            : 'No trades yet.'}
        </p>
      ) : (
        <>
          <Row
            label={`${v.went.count} went your way`}
            title={
              v.went.count === 0
                ? 'No trade got 1×ATR your way.'
                : `Up at least 1×ATR at some point.${v.went.red > 0 ? ` ${v.went.red} of ${v.went.count === 1 ? 'it' : 'these'} still finished red.` : ''}`
            }
            group={v.went}
            scale={scale}
            fmt={fmt}
            trailing={v.went.keptPct != null ? `kept ${formatKept(v.went.keptPct)}` : null}
          />
          <div className="h-2.5" />
          <Row
            label={`${v.never.count} never got going`}
            title="Never got 1×ATR your way — an entry problem, not an exit one."
            group={v.never}
            scale={scale}
            fmt={fmt}
            trailing={null}
          />
          {/* Names the trades it averages over. As a bare "Net per trade" it was
              read as the two rows above subtracted (+$117 − $103 ≠ +$5): each
              row is the average of its own group, this is the average of both. */}
          <div
            className="mt-2.5 pt-2 border-t border-gray-800 flex items-baseline justify-between gap-2 text-[13px]"
            title={v.netCount > 1
              ? `${fmt(v.netTotal)} across ${v.netCount} trades, divided by ${v.netCount}. Not the two lines above subtracted: each of those is the average for its own group.`
              : undefined}
          >
            <span className="text-gray-500">
              {v.netCount > 1
                ? `Average of ${v.unclassified > 0 ? 'these' : 'all'} ${v.netCount} trades`
                : v.netCount === 1 ? 'This trade' : 'Average per trade'}
            </span>
            <span className="font-bold text-gray-200 whitespace-nowrap">{fmt(v.net)}</span>
          </div>
          {v.unclassified > 0 && (
            <p className="mt-1 text-[10px] text-gray-600">
              {v.unclassified} trade{plural(v.unclassified)} without price data not shown
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Row({
  label, title, group, scale, fmt, trailing,
}: {
  label: string
  title: string
  group: MgmtGroupView
  scale: { maxMae: number; maxMfe: number }
  fmt: (x: number | null) => string
  trailing: string | null
}) {
  const geo = group.count > 0 ? mgmtBarGeometry(group, scale) : null
  const resultClass =
    group.result == null ? 'text-gray-500'
    : group.result > 0 ? 'text-green-400'
    : group.result < 0 ? 'text-red-400'
    : 'text-gray-300'
  return (
    <div title={title}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-gray-200 whitespace-nowrap">{label}</span>
        {group.count > 0 && (
          <span className="whitespace-nowrap">
            <span className={`font-bold ${resultClass}`}>{fmt(group.result)}</span>
            {trailing && <span className="text-[13px] text-gray-400"> · {trailing}</span>}
          </span>
        )}
      </div>
      {geo && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-none w-[88px] text-right text-xs text-red-400 whitespace-nowrap">
            <span className="font-semibold text-gray-400">MAE</span> {fmt(group.mae == null ? null : -group.mae)}
          </span>
          <div className="relative flex-1 min-w-0 h-[9px] rounded-[3px] bg-gray-800" aria-hidden="true">
            <span className="absolute top-0 h-[9px] bg-red-400/30" style={{ left: `${geo.maeLeft}%`, width: `${geo.maeWidth}%` }} />
            <span className="absolute top-0 h-[9px] bg-green-400/25" style={{ left: `${geo.zero}%`, width: `${geo.mfeWidth}%` }} />
            {geo.solidSide !== 'none' && (
              <span
                className={`absolute top-0 h-[9px] ${geo.solidSide === 'kept' ? 'bg-green-400' : 'bg-red-400'}`}
                style={{ left: `${geo.solidLeft}%`, width: `${geo.solidWidth}%` }}
              />
            )}
            <span className="absolute -top-[3px] h-[15px] w-[2px] bg-gray-200" style={{ left: `${geo.zero}%` }} />
          </div>
          <span className="flex-none w-[88px] text-xs text-green-400 whitespace-nowrap">
            {fmt(group.mfe)} <span className="font-semibold text-gray-400">MFE</span>
          </span>
        </div>
      )}
    </div>
  )
}
