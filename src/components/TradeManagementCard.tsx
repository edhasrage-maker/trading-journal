'use client'

import { ArrowDown, ArrowUp } from 'lucide-react'
import { useMfeUnit, formatMfeMae, type MfeUnit } from '@/lib/mfe-unit'
import {
  mgmtView, mgmtBarGeometry, formatKept,
  type MgmtTotals, type MgmtGroupView,
} from '@/lib/trade-management'
import { formatPfDelta, type LiftDragFactor, type LiftDragView } from '@/lib/lift-drag'
import { fmtR, fmtUsd, USUAL_SESSIONS, type PerTrade } from '@/lib/trade-r'

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
  /** Recap only: the day's Net $ / R / Risk per trade, each with the trader's
   *  usual over their last USUAL_SESSIONS sessions (src/lib/trade-r.ts; founder 2026-10-22,
   *  mockup https://claude.ai/artifact/5QWKdATNpTntCQ6Ar9neZn). Replaces the
   *  "Net per trade" line. Absent (the dashboard) = that line, unchanged. */
  perTrade?: { day: PerTrade; usual: PerTrade | null } | null
  /** Outer class. Defaults to the dashboard's blend-in stat tile. */
  className?: string
  /** Dashboard only: the profit factor, with the one thing lifting it and the
   *  one dragging it (src/lib/lift-drag.ts), under "Net per trade". `window`
   *  says which sessions it covers — it can be wider than the card's period. */
  profitFactor?: { view: LiftDragView; window: string } | null
  /** Dashboard: the title in the small caps every dashboard card opens with. */
  eyebrow?: boolean
  /** Detailed scoreboard (founder, 2026-11-01): a heading instead of the small
   *  caps, a line saying how to read the bars, "kept N% of the best move". */
  heading?: boolean
}

const UNIT_OPTIONS: { value: MfeUnit; label: string }[] = [
  { value: 'pts', label: 'pts per trade' },
  { value: 'dollars', label: '$ per trade' },
  { value: 'atr', label: '× ATR per trade' },
]

const plural = (n: number) => (n === 1 ? '' : 's')

export default function TradeManagementCard({ totals, className, profitFactor, perTrade, eyebrow = false, heading = false }: Props) {
  const [unit, setUnit] = useMfeUnit()
  const v = mgmtView(totals, unit)
  const scale = {
    maxMae: Math.max(v.went.mae ?? 0, v.never.mae ?? 0),
    maxMfe: Math.max(v.went.mfe ?? 0, v.never.mfe ?? 0),
  }
  const fmt = (x: number | null) => formatMfeMae(x, unit)

  return (
    <div className={className ?? 'border border-gray-800 rounded-[3px] p-[18px]'}>
      <div className={`flex flex-wrap items-center justify-between gap-2 ${heading ? 'mb-1' : 'mb-2.5'}`}>
        <p
          className={heading
            ? 'text-[20px] font-bold text-gray-100 whitespace-nowrap font-[family-name:var(--font-display)]'
            : eyebrow ? 'ts-eyebrow whitespace-nowrap' : 'text-xs text-gray-500 whitespace-nowrap'}
          title="Every trade is sorted first: did it go at least 1×ATR your way at some point, or not? MFE is the best point it reached, MAE the worst. Kept is what you banked out of the run, losses included."
        >
          Trade management
        </p>
        <select
          aria-label="Unit"
          value={unit}
          onChange={e => setUnit(e.target.value as MfeUnit)}
          className={heading
            ? 'bg-transparent border border-gray-700 text-gray-200 text-[13px] rounded-md px-2 py-1 focus:outline-none focus:border-blue-500'
            : 'bg-gray-800 border border-gray-700 text-gray-400 text-[10px] rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-tight'}
          title="Display unit (shared across the app)"
        >
          {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {heading && v.classified > 0 && (
        <p className="mb-3.5 text-[13px] leading-snug text-gray-400">
          Each bar runs from the worst point against you (MAE) to the best point for you (MFE); the tick is your entry.
        </p>
      )}

      {v.classified === 0 ? (
        <p className="text-sm text-gray-500">
          {v.unclassified > 0
            ? `No price data behind ${v.unclassified === 1 ? 'this trade' : 'these trades'} yet.`
            : 'No trades yet.'}
        </p>
      ) : (
        <>
          <Row
            label={`${v.went.count} trade${plural(v.went.count)} went your way`}
            title={
              v.went.count === 0
                ? 'No trade got 1×ATR your way.'
                : `Up at least 1×ATR at some point.${v.went.red > 0 ? ` ${v.went.red} of ${v.went.count === 1 ? 'it' : 'these'} still finished red.` : ''}`
            }
            group={v.went}
            scale={scale}
            fmt={fmt}
            trailing={v.went.keptPct != null ? `kept ${formatKept(v.went.keptPct)}${heading ? ' of the best move' : ''}` : null}
          />
          <div className="h-2.5" />
          <Row
            label={`${v.never.count} trade${plural(v.never.count)} never got going`}
            title="Never got 1×ATR your way — an entry problem, not an exit one."
            group={v.never}
            scale={scale}
            fmt={fmt}
            trailing={null}
          />
          {/* "Net per trade" is the founder's wording and it is literally the
              sum: everything these trades made minus everything they lost,
              divided by how many there are. It is NOT the two rows above
              subtracted (+$117 − $103 ≠ +$5) — each row is the average of its
              own group — so the tooltip spells the sum out for anyone who tries. */}
          {perTrade ? <PerTradeLines day={perTrade.day} usual={perTrade.usual} /> : (
          <div
            className="mt-2.5 pt-2 border-t border-gray-800 flex items-baseline justify-between gap-2 text-[13px]"
            title={v.netCount > 1
              ? `${fmt(v.netTotal)} in total across ${v.netCount} trades, divided by ${v.netCount}. Not the two lines above subtracted: each of those is the average for its own group.`
              : undefined}
          >
            <span className="text-gray-500">Net per trade</span>
            <span className="font-bold text-gray-200 whitespace-nowrap">{fmt(v.net)}</span>
          </div>
          )}
          {v.unclassified > 0 && (
            <p className="mt-1 text-[10px] text-gray-600">
              {v.unclassified} trade{plural(v.unclassified)} without price data not shown
            </p>
          )}
        </>
      )}
      {profitFactor && <ProfitFactorSection view={profitFactor.view} windowLabel={profitFactor.window} />}
    </div>
  )
}

/** The Recap's per-trade lines: Net $, R and Risk per trade, each "(usual …)"
 *  over the trader's last USUAL_SESSIONS sessions. A line without a number is left out. */
function PerTradeLines({ day, usual }: { day: PerTrade; usual: PerTrade | null }) {
  const lines: { label: string; value: string; usual: string | null; title: string }[] = []
  if (day.netPerTrade != null) lines.push({
    label: 'Net $ per trade', value: fmtUsd(day.netPerTrade),
    usual: usual?.netPerTrade != null ? fmtUsd(usual.netPerTrade) : null,
    title: `The day's P&L divided by its ${day.trades} trade${plural(day.trades)}.`,
  })
  if (day.rPerTrade != null) lines.push({
    label: 'R per trade', value: fmtR(day.rPerTrade),
    usual: usual?.rPerTrade != null ? fmtR(usual.rPerTrade) : null,
    title: `Each trade's P&L divided by what it risked to its planned stop, averaged${day.withStop < day.trades ? ` (${day.withStop} of ${day.trades} trades had a stop)` : ''}. Position size doesn't change it.`,
  })
  if (day.riskPerTrade != null) lines.push({
    label: 'Risk per trade', value: `$${Math.round(day.riskPerTrade).toLocaleString('en-US')}`,
    usual: usual?.riskPerTrade != null ? `$${Math.round(usual.riskPerTrade).toLocaleString('en-US')}` : null,
    title: 'What a trade stood to lose at its planned stop, averaged.',
  })
  return (
    <div className="mt-2.5 pt-2 border-t border-gray-800 space-y-1 text-[13px]">
      {lines.map(l => (
        <div key={l.label} className="flex items-baseline justify-between gap-2" title={`${l.title}${l.usual ? ` Usual = your last ${USUAL_SESSIONS} sessions before this day.` : ''}`}>
          <span className="text-gray-500">{l.label}</span>
          <span className="whitespace-nowrap">
            <span className="font-bold text-gray-200">{l.value}</span>
            {l.usual && <span className="text-gray-500 text-[12px]"> (usual {l.usual})</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

const fmtPf = (x: number | null) => (x == null ? 'no losses' : x.toFixed(2))
const fmtPct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`)

/** "Profit factor 1.22" and, under it, the one thing lifting it and the one
 *  dragging it. Fills the space the card's rows leave under Net per trade
 *  (founder, 2026-10-13). Profit factor is in R whatever the unit menu says. */
function pfTitle(view: LiftDragView): string {
  const base = 'Profit factor = R won ÷ R lost, in R so position size doesn\'t change it.'
  if (view.extended && view.period) {
    return `${base} The big number is the range you picked: ${view.period.trades} trades across ${view.period.sessions} sessions. What moves it is read over your last ${view.sessions} sessions (${view.trades} trades, profit factor ${view.pf.toFixed(2)}), because a short range changes its pick almost every week. Each line is the one thing, out of ${view.candidates} known at entry, that moves it most when its trades are left out.`
  }
  return `${base} ${view.trades} trades across ${view.sessions} sessions. Each line below is the one thing, out of ${view.candidates} known at entry, that moves it most when its trades are left out.${view.extended ? ' Shorter periods are widened to your last 60 sessions so the pick holds still from week to week.' : ''}`
}

/** The big number: the picked range's own profit factor when the read was
 *  widened past it, otherwise the read's. */
function headlinePf(view: LiftDragView): { value: string; note: string | null } {
  const p = view.extended ? view.period : undefined
  if (!p) return { value: view.pf.toFixed(2), note: null }
  if (p.pf != null) return { value: p.pf.toFixed(2), note: null }
  return {
    value: '—',
    note: p.trades === 0 ? 'No trades in this range yet.' : 'No losing trades in this range, so there is nothing to divide by.',
  }
}

function ProfitFactorSection({ view, windowLabel }: { view: LiftDragView; windowLabel: string }) {
  return (
    <div className="mt-2.5 pt-2 border-t border-gray-800">
      <div
        className="flex items-baseline justify-between gap-2 text-[13px]"
        title={pfTitle(view)}
      >
        <span className="text-gray-500 min-w-0">
          Profit factor <span className="text-[11px] text-gray-600">· {windowLabel}</span>
        </span>
        <span className="font-bold text-gray-200 whitespace-nowrap">{view.pf.toFixed(2)}</span>
      </div>
      {view.lift && <FactorRow kind="lift" f={view.lift} pf={view.pf} candidates={view.candidates} />}
      {view.drag && <FactorRow kind="drag" f={view.drag} pf={view.pf} candidates={view.candidates} />}
      {!view.lift && !view.drag && (
        <p className="mt-1.5 text-[11px] text-gray-500">
          Nothing lifts or drags it clearly enough to name yet.
        </p>
      )}
    </div>
  )
}

/** The range a lifter / drag moves the profit factor, nearest zero first. */
function factorRange(kind: 'lift' | 'drag', f: LiftDragFactor): string {
  return kind === 'lift'
    ? `${formatPfDelta(f.lo)} to ${formatPfDelta(f.hi)}`
    : `${formatPfDelta(f.hi)} to ${formatPfDelta(f.lo)}`
}

function factorTitle(kind: 'lift' | 'drag', f: LiftDragFactor, candidates: number): string {
  return [
    `${f.label}: ${f.n} trade${plural(f.n)}, ${fmtPct(f.winRate)} won, profit factor ${fmtPf(f.pf)}.`,
    `Every other trade: ${f.restN} trade${plural(f.restN)}, ${fmtPct(f.restWinRate)} won, profit factor ${fmtPf(f.pfWithout)}.`,
    '',
    `In 8 of 10 reshuffles of these sessions, leaving them out ${kind === 'lift' ? 'lowered' : 'raised'} your profit factor by ${factorRange(kind, f).replace(/[+−]/g, '')}. Picked as the strongest of ${candidates} things known at entry, so next month it usually reads smaller.`,
  ].join('\n')
}

/**
 * Dashboard: the profit factor as its own card beside Trade management
 * (founder, 2026-10-31) — the number large, then the one thing lifting it and
 * the one dragging it in tinted boxes. Same reads and hover text as the
 * section the recap-style card carries.
 */
export function ProfitFactorCard({ view, windowLabel, periodLabel, className, ruled = false }: {
  view: LiftDragView
  windowLabel: string
  /** The picked range, e.g. "last 30 days · 14 sessions" — the headline's
   *  label when the read was widened past it. */
  periodLabel?: string
  className?: string
  ruled?: boolean
}) {
  if (ruled) return <ProfitFactorRuled view={view} windowLabel={windowLabel} periodLabel={periodLabel} className={className} />
  const split = view.extended && view.period != null && periodLabel != null
  const head = split ? headlinePf(view) : { value: view.pf.toFixed(2), note: null }
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3" title={pfTitle(view)}>
        <span className="ts-eyebrow whitespace-nowrap">Profit factor</span>
        <span className="text-xs text-gray-500 text-right">{split ? periodLabel : windowLabel}</span>
      </div>
      <div className="mt-2 text-[30px] font-bold leading-none tabular-nums text-gray-100" style={{ fontFamily: 'var(--font-display)' }} title={pfTitle(view)}>
        {head.value}
      </div>
      {head.note && <p className="mt-1 text-xs text-gray-500">{head.note}</p>}
      {split && (
        <p className="mt-3 text-xs text-gray-500" title={pfTitle(view)}>
          <span className="font-semibold text-gray-300">What moves it</span> · last {view.sessions} sessions, where it&apos;s {view.pf.toFixed(2)}
        </p>
      )}
      <div className={`${split ? 'mt-2' : 'mt-4'} space-y-2`}>
        {view.lift && <FactorBox kind="lift" f={view.lift} candidates={view.candidates} />}
        {view.drag && <FactorBox kind="drag" f={view.drag} candidates={view.candidates} />}
        {!view.lift && !view.drag && (
          <p className="text-[13px] text-gray-500">Nothing lifts or drags it clearly enough to name yet.</p>
        )}
      </div>
    </div>
  )
}

/** Detailed scoreboard (founder, 2026-11-01): a heading, the window said out
 *  loud when it reaches past the page's period, lift and drag on coloured
 *  left rules instead of tinted boxes.
 *
 *  Split when the read was widened (founder, 2026-11-06): the big number is
 *  the range picked at the top of the page, and "What moves it" below says
 *  it reads the last 60 sessions — with that window's own profit factor,
 *  which every "without them it would be" compares against. */
function ProfitFactorRuled({ view, windowLabel, periodLabel, className }: { view: LiftDragView; windowLabel: string; periodLabel?: string; className?: string }) {
  const span = windowLabel.split(' · ').slice(1).join(' · ')
  const rows = (
    <div className="mt-3.5 space-y-3.5">
      {([['lift', view.lift], ['drag', view.drag]] as const).map(([kind, f]) => f && (
        <div
          key={kind}
          className={`flex items-center gap-3 border-l-[3px] pl-3.5 py-0.5 ${kind === 'lift' ? 'border-green-400' : 'border-red-400'}`}
          title={factorTitle(kind, f, view.candidates)}
        >
          <div className="flex-1 min-w-0">
            <p className="text-[15px] text-gray-100 leading-snug">
              <b className={kind === 'lift' ? 'text-green-400' : 'text-red-400'}>{kind === 'lift' ? 'Lifts it' : 'Drags it'}</b>{' '}{f.label}
            </p>
            <p className="text-[13px] text-gray-400 leading-snug">{f.n} trade{plural(f.n)} · without them it would be {f.pfWithout.toFixed(2)}</p>
          </div>
          <span className={`flex-none text-[20px] font-bold tabular-nums ${kind === 'lift' ? 'text-green-400' : 'text-red-400'}`} style={{ fontFamily: 'var(--font-display)' }}>
            {formatPfDelta(f.delta)}
          </span>
        </div>
      ))}
      {!view.lift && !view.drag && (
        <p className="text-[13px] text-gray-400">Nothing lifts or drags it clearly enough to name yet.</p>
      )}
    </div>
  )
  const bigNumber = (value: string) => (
    <div className="mt-2.5 text-[40px] font-bold leading-none tabular-nums text-gray-100" style={{ fontFamily: 'var(--font-display)' }} title={pfTitle(view)}>
      {value}
    </div>
  )

  if (view.extended && view.period && periodLabel) {
    const head = headlinePf(view)
    return (
      <div className={className}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1" title={pfTitle(view)}>
          <h2 className="text-[20px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Profit factor</h2>
          <span className="text-[13px] text-gray-400">{periodLabel}</span>
        </div>
        {bigNumber(head.value)}
        {head.note && <p className="mt-1.5 text-[13px] text-gray-400">{head.note}</p>}
        <div className="mt-5 pt-4 border-t border-gray-800">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1" title={pfTitle(view)}>
            <h3 className="text-[16px] font-bold text-gray-100">What moves it</h3>
            <span className="text-[13px] font-semibold text-gray-100 bg-gray-800 rounded-md px-2.5 py-0.5">Last {view.sessions} sessions</span>
          </div>
          <p className="mt-1 text-[13px] text-gray-400">
            {span}, where it&apos;s {view.pf.toFixed(2)}. Read over more sessions than your range so the pick holds still.
          </p>
          {rows}
        </div>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1" title={pfTitle(view)}>
        <h2 className="text-[20px] font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>Profit factor</h2>
        {view.extended
          ? <span className="text-[13px] font-semibold text-gray-100 bg-gray-800 rounded-md px-2.5 py-0.5">Last {view.sessions} sessions</span>
          : <span className="text-[13px] text-gray-400">{windowLabel}</span>}
      </div>
      {view.extended && (
        <p className="mt-1 text-[13px] text-gray-400">
          {span}. This one looks further back than the rest of the page, so the pick holds still.
        </p>
      )}
      {bigNumber(view.pf.toFixed(2))}
      {rows}
    </div>
  )
}

function FactorBox({ kind, f, candidates }: { kind: 'lift' | 'drag'; f: LiftDragFactor; candidates: number }) {
  const lift = kind === 'lift'
  return (
    <div
      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${lift ? 'bg-green-950' : 'bg-red-950'}`}
      title={factorTitle(kind, f, candidates)}
    >
      <span className={`flex-none w-[60px] text-xs font-bold ${lift ? 'text-green-400' : 'text-red-400'}`}>
        {lift ? 'Lifts it' : 'Drags it'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-200 leading-snug">{f.label}</p>
        <p className="text-[11px] text-gray-500 leading-snug">
          {f.n} trade{plural(f.n)} · without them it would be {f.pfWithout.toFixed(2)}
        </p>
      </div>
      <span className={`flex-none font-bold tabular-nums ${lift ? 'text-green-400' : 'text-red-400'}`}>{formatPfDelta(f.delta)}</span>
    </div>
  )
}

function FactorRow({ kind, f, pf, candidates }: { kind: 'lift' | 'drag'; f: LiftDragFactor; pf: number; candidates: number }) {
  const lift = kind === 'lift'
  const range = factorRange(kind, f)
  const title = factorTitle(kind, f, candidates)
  return (
    <div className="mt-2 flex items-center gap-2.5" title={title}>
      <span
        className={`flex-none inline-flex items-center justify-center w-6 h-6 rounded-full ${lift ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}
        aria-hidden="true"
      >
        {lift ? <ArrowUp className="w-3.5 h-3.5" strokeWidth={2.5} /> : <ArrowDown className="w-3.5 h-3.5" strokeWidth={2.5} />}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200 leading-snug">
          <span className={`text-xs font-semibold ${lift ? 'text-green-400' : 'text-red-400'}`}>{lift ? 'Lifting it' : 'Dragging it'}</span>{' '}
          <span className="font-semibold">{f.label}</span>
        </p>
        <p className="text-[11px] text-gray-500 leading-snug">
          {f.n} trade{plural(f.n)} · {pf.toFixed(2)} would be {f.pfWithout.toFixed(2)} without them · range {range}
        </p>
      </div>
      <span className={`flex-none font-bold ${lift ? 'text-green-400' : 'text-red-400'}`}>{formatPfDelta(f.delta)}</span>
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-sm font-semibold text-gray-200 whitespace-nowrap">{label}</span>
        {group.count > 0 && (
          <span className="ml-auto text-right">
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
