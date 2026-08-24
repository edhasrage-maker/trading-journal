'use client'

import { readConditions, type VerdictTone } from '@/lib/condition-verdicts'
import { cn } from '@/lib/utils'
import type { MarketContext } from '@/lib/supabase/types'
import type { IbDayType, RegimeBand } from '@/lib/ib-day-type'

/** IB÷ATR regime → the day-character verdict word + tone shown in the ledger. */
const IB_CHARACTER: Record<RegimeBand, { word: string; tone: VerdictTone }> = {
  chop: { word: 'Choppy', tone: 'amber' },
  mid: { word: 'Normal', tone: 'dim' },
  expanded: { word: 'Extended', tone: 'plain' },
}

/**
 * Market context as a reference LEDGER, not a form.
 *
 * This block is the densest part of Prep and the place the generic look creeps
 * back in — levels + IB + volatility is exactly the "grid of labelled number
 * inputs" that reads as a stock admin dashboard. So it's inverted: the derived
 * VERDICT leads each group, the raw numbers are demoted to quiet tabular
 * numerals on hairline rows, and editing lives behind a disclosure (nearly
 * every value auto-fills from the bar feed anyway).
 *
 * Verdict words come from the same `readConditions` bands as the hero and the
 * analytics condition buckets, so the language agrees everywhere.
 */

const numOr = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

const CHIP_CLS: Record<VerdictTone, string> = {
  red: 'text-red-400 bg-red-400/10',
  amber: 'text-yellow-400 bg-yellow-400/10',
  dim: 'text-gray-500 bg-gray-950',
  plain: 'text-gray-300 bg-gray-950',
}

const VERDICT_CLS: Record<VerdictTone, string> = {
  red: 'text-red-400',
  amber: 'text-yellow-400',
  dim: 'text-gray-400',
  plain: 'text-gray-300',
}

function Row({
  label, value, chip, chipTone = 'dim', title, basis,
}: {
  label: string
  value: string | null
  chip?: string
  chipTone?: VerdictTone
  /** Hover text — used where the number cannot be reproduced from the other
   *  values on the panel and would otherwise look wrong. */
  title?: string
  /** The arithmetic, printed under the label: "27.75 ÷ 36.20 pts". A tooltip is
   *  not enough — a number you have to hover to verify is a number you can't
   *  check on a phone, and this row divides by a value that is deliberately NOT
   *  the ADR shown two rows up. */
  basis?: string | null
}) {
  const empty = value == null
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5 border-t border-gray-800">
      <span className="text-[13px] text-gray-400" title={title}>
        {label}
        {basis && (
          <span className="block font-mono text-[10.5px] text-gray-600 leading-tight mt-0.5">{basis}</span>
        )}
      </span>
      <span
        className={cn(
          'text-[14.5px] tabular-nums text-right min-w-[74px]',
          empty ? 'font-light text-gray-500' : 'font-bold text-gray-100',
        )}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value ?? '—'}
      </span>
      {chip
        ? <span className={cn('text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap', CHIP_CLS[chipTone])}>{chip}</span>
        : <span />}
    </div>
  )
}

function Group({
  title, verdict, verdictTone = 'dim', note, children,
}: {
  title: string
  verdict: string
  verdictTone?: VerdictTone
  note?: string
  children: React.ReactNode
}) {
  return (
    <div className="pt-1 pb-3.5">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span
          className="text-[13px] font-bold tracking-[-0.01em] text-gray-100"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {title}
        </span>
        <span className={cn('text-xs font-semibold', VERDICT_CLS[verdictTone])}>{verdict}</span>
      </div>
      {children}
      {note && <p className="text-[11px] text-gray-500 pt-1.5">{note}</p>}
    </div>
  )
}

const pts = (v: number | null) => (v == null ? null : `${Math.round(v)} pts`)
const price = (v: number | null) => (v == null ? null : v.toLocaleString('en-US', { maximumFractionDigits: 2 }))

export default function PrepLedger({
  context,
  atrBaseline,
  adrAtNow,
  drAdrPctAuto,
  dayRangeAuto,
  ibDayType,
}: {
  context: Partial<MarketContext>
  atrBaseline: number | null
  /** Time-matched ADR for the range-used ratio while a session is running. */
  adrAtNow?: number | null
  /** Server-computed DR/ADR fallback, as a PERCENT, for days whose day_range
   *  hasn't landed in market_context yet. Was a ratio; the row multiplied it by
   *  100 here while the Morning Conditions lookup passed the same prop through
   *  unscaled. */
  drAdrPctAuto: number | null
  /** The realized RTH range behind that percent, in points — the numerator the
   *  row prints so the division can be checked. */
  dayRangeAuto: number | null
  /** IB day-character classification (choppy/normal/extended via IB÷ATR). Shown
   *  as one compact row in the Initial Balance group — the standalone panel it
   *  replaced was too sparse. Null until the bars/IB print. */
  ibDayType?: IbDayType | null
}) {
  const pdh = numOr(context.pdh), pdl = numOr(context.pdl)
  const onh = numOr(context.onh), onl = numOr(context.onl)
  const ibh = numOr(context.ibh), ibl = numOr(context.ibl)
  const adr = numOr(context.adr), atr = numOr(context.atr_1m)
  const rvol = numOr(context.rvol), ibRatio = numOr(context.ib_vs_10d_avg)
  const dayRange = numOr(context.day_range)

  // One shared read so every verdict word here matches the hero's.
  const read = readConditions({ rvol, atr1m: atr, atrBaseline, adr, adrAtNow, onh, onl, dayRange, ibRatio })
  const chipFor = (label: string) => read.chips.find(c => c.label === label)

  const onPct = onh != null && onl != null && adr != null && adr > 0
    ? Math.round(((onh - onl) / adr) * 100)
    : null
  // Same denominator the verdict used, or the percentage and the word disagree.
  const adrForRatio = adrAtNow ?? adr
  // True while the session is still running: the time-matched baseline has not
  // yet grown into the whole-day one.
  const midSession = adrAtNow != null && adr != null && Math.abs(adrAtNow - adr) > 0.01
  // The displayed range and the denominator it was actually divided by, kept
  // together so the sub-line can never drift from the percentage above it.
  const drNumer = dayRange ?? dayRangeAuto
  const drDenom = dayRange != null ? adrForRatio : adr
  const drPct = dayRange != null && adrForRatio != null && adrForRatio > 0
    ? Math.round((dayRange / adrForRatio) * 100)
    : drAdrPctAuto != null ? Math.round(drAdrPctAuto) : null

  const overnight = chipFor('Overnight range')
  const rangeUsed = chipFor('Range used')
  const volume = chipFor('Volume pace')
  const barVol = chipFor('Bar volatility')
  const openingRange = chipFor('Opening range')

  const ibPrinted = ibh != null || ibl != null
  const atrRatio = atr != null && atrBaseline != null && atrBaseline > 0 ? atr / atrBaseline : null

  return (
    <div className="grid gap-x-10 md:grid-cols-2">
      <Group
        title="Prior day"
        verdict={pdh != null && pdl != null ? `${Math.round(pdh - pdl)} pt range` : 'not set'}
      >
        <Row label="PDH" value={price(pdh)} chip="high" />
        <Row label="PDL" value={price(pdl)} chip="low" />
      </Group>

      <Group
        title="Overnight"
        verdict={overnight?.verdict ?? 'not set'}
        verdictTone={overnight?.tone ?? 'dim'}
      >
        <Row label="ONH" value={price(onh)} chip="high" />
        <Row label="ONL" value={price(onl)} chip="low" />
        <Row
          label="Overnight % of ADR"
          value={onPct != null ? `${onPct}%` : null}
          chip={overnight?.verdict ?? undefined}
          chipTone={overnight?.tone ?? 'dim'}
        />
      </Group>

      <Group
        title="Initial balance"
        verdict={ibPrinted ? (openingRange?.verdict ?? 'printed') : 'not printed'}
        verdictTone={ibPrinted ? (openingRange?.tone ?? 'dim') : 'dim'}
        note={ibPrinted ? undefined : 'Fills in once the 06:30–07:30 PT range prints.'}
      >
        <Row label="IBH" value={price(ibh)} chip={ibh == null ? 'pending' : 'high'} />
        <Row label="IBL" value={price(ibl)} chip={ibl == null ? 'pending' : 'low'} />
        <Row
          label="IB vs 10-day avg"
          value={ibRatio != null ? `${(ibRatio > 5 ? ibRatio / 100 : ibRatio).toFixed(2)}×` : null}
          chip={openingRange?.verdict ?? 'pending'}
          chipTone={openingRange?.tone ?? 'dim'}
        />
        {/* Day character — IB÷ATR (choppy / normal / extended). The size verdict
            is the row above; this is the shape read the standalone panel used to
            carry, now one compact line. */}
        {(() => {
          const rb = ibDayType?.regimeBand ?? null
          const rr = ibDayType?.regimeRatio ?? null
          const c = rb ? IB_CHARACTER[rb] : null
          return (
            <Row
              label="IB vs ATR (character)"
              value={rr != null ? `${rr.toFixed(1)}×` : null}
              chip={c?.word ?? 'pending'}
              chipTone={c?.tone ?? 'dim'}
              // The denominator is NOT the "1-min ATR" shown a few rows down.
              // Two different ATRs sat next to each other unlabelled, so dividing
              // the IB by the visible one gave a different answer and the panel
              // looked wrong. Name the basis where it is read.
              title={'IB size ÷ meanHL10 — the mean High−Low of the LAST 10 IB 1-minute bars, not the Wilder ATR-10 shown under Volatility. The study this lens comes from is calibrated on that basis (chop < 7.7, expanded ≥ 13), so swapping in Wilder would change what the words mean.'}
            />
          )
        })()}
      </Group>

      <Group
        title="Volatility"
        verdict={barVol?.verdict ?? volume?.verdict ?? 'not set'}
        verdictTone={barVol?.tone ?? volume?.tone ?? 'dim'}
      >
        <Row
          label="RVOL"
          value={rvol != null ? `${Math.round(rvol < 5 ? rvol * 100 : rvol)}%` : null}
          chip={volume?.verdict ?? undefined}
          chipTone={volume?.tone ?? 'dim'}
        />
        <Row label="ADR (RTH)" value={pts(adr)} chip="baseline" />
        <Row
          label="1-min ATR"
          value={atr != null ? `${atr.toFixed(1)} pts` : null}
          chip={atrRatio != null ? `${atrRatio.toFixed(1)}× normal` : undefined}
          chipTone={barVol?.tone ?? 'dim'}
        />
        <Row
          // Mid-session this divides by the range prior days had covered BY THIS
          // POINT, not by the whole-day ADR displayed two rows up — otherwise a
          // morning always reads as a fraction of a finished day. But that
          // leaves two numbers on screen that cannot be reconciled (27.75 / 42
          // = 66%, not 102%), so the label names the basis it actually used.
          label={midSession ? 'Range used (vs typical by now)' : 'Range used (DR/ADR)'}
          value={drPct != null ? `${drPct}%` : null}
          basis={drNumer != null && drDenom != null
            ? `${drNumer.toFixed(2)} ÷ ${drDenom.toFixed(2)} pts${midSession ? ' (range by this hour)' : ''}`
            : null}
          chip={rangeUsed?.verdict ?? undefined}
          chipTone={rangeUsed?.tone ?? 'dim'}
          title={
            adrAtNow != null && adr != null && Math.abs(adrAtNow - adr) > 0.01
              ? `Day range so far ${dayRange?.toFixed(2) ?? '—'} ÷ ${adrAtNow.toFixed(2)} — the range your last 10 sessions had covered by this point in the day. NOT the ${adr.toFixed(2)} whole-day ADR shown above: dividing a part-day range by a full-day average reports the hour, not the day. Once the session closes the two are the same number.`
              : `Day range ${dayRange?.toFixed(2) ?? '—'} ÷ ${adr?.toFixed(2) ?? '—'} ADR.`
          }
        />
      </Group>
    </div>
  )
}
