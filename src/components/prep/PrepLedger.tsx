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
  label, value, chip, chipTone = 'dim',
}: {
  label: string
  value: string | null
  chip?: string
  chipTone?: VerdictTone
}) {
  const empty = value == null
  return (
    <div className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-1.5 border-t border-gray-800">
      <span className="text-[13px] text-gray-400">{label}</span>
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
  drAdrAuto,
  ibDayType,
}: {
  context: Partial<MarketContext>
  atrBaseline: number | null
  /** Server-computed DR/ADR fallback for days whose day_range hasn't been read
   *  off a screenshot yet. */
  drAdrAuto: number | null
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
  const read = readConditions({ rvol, atr1m: atr, atrBaseline, adr, onh, onl, dayRange, ibRatio })
  const chipFor = (label: string) => read.chips.find(c => c.label === label)

  const onPct = onh != null && onl != null && adr != null && adr > 0
    ? Math.round(((onh - onl) / adr) * 100)
    : null
  const drPct = dayRange != null && adr != null && adr > 0
    ? Math.round((dayRange / adr) * 100)
    : drAdrAuto != null ? Math.round(drAdrAuto * 100) : null

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
          label="Range used (DR/ADR)"
          value={drPct != null ? `${drPct}%` : null}
          chip={rangeUsed?.verdict ?? undefined}
          chipTone={rangeUsed?.tone ?? 'dim'}
        />
      </Group>
    </div>
  )
}
