'use client'

import { useMemo } from 'react'
import { Check, Plus } from 'lucide-react'
import { classifyIbDayType, type RegimeBand, type SizeBand } from '@/lib/ib-day-type'
import type { SessionKind } from '@/lib/session-levels'
import type { DayContextStats } from '@/lib/market-context-from-bars'

/**
 * IB Day-Type read — a prep-time classifier that reads today's Initial Balance
 * and answers two questions the trader uses to characterize the day:
 *   - Is it CHOPPY / NORMAL / EXTENDED?  (IB range ÷ ATR — directionality)
 *   - How big is the IB vs typical?      (IB range ÷ 10-day avg — magnitude)
 *
 * It exists to feed the day-type classification, NOT to prescribe a trade. The
 * two reads map onto the trader's own day-type chips — validated against their
 * tagging history:
 *   - IB÷ATR → Trend Day / Range Day  (Trend 11.0 vs Range 8.4 median separate;
 *     High/Med/Low do not — IB÷ATR sees direction, not magnitude)
 *   - IB size → High / Medium / Low action  (medians 1.31/0.85/0.58 fall on the
 *     size cuts — the magnitude axis IB÷ATR can't see)
 * Suggestions are one-click and only offered for labels that exist in the
 * library. (Phase 2: persist these to market_context/day_types[] so
 * condition_lookup can bucket actual trades by day type.)
 *
 * NQ-focused. RTH fully supported; overnight sessions keep the regime read but
 * mute IB size (ib_vs_10d isn't baselined overnight).
 */

interface Props {
  /** The session this prep targets — drives the IB windows + size support. */
  session: SessionKind
  /** Bar-derived stats for the day. Null until bars load. `ib_size` = IB range,
   *  `meanHL10` = study ATR, `atr_at_ib_close` = Wilder fallback, `ib_vs_10d_avg`
   *  = size ratio. */
  stats: DayContextStats | null
  /** Day-type chips in the trader's library — a mapped suggestion is only
   *  offered when its label exists here (degrades if the library is renamed). */
  dayTypeOptions: string[]
  /** Currently-selected day-type chips, so suggestions mark already-set labels. */
  currentDayTypes: string[]
  /** Append handler — same contract as DayTypePredictor's onAccept. */
  onSuggest: (labels: string[]) => void
}

// IB-size band → action-level chip; IB/ATR regime band → structure chip. Labels
// mirror the trader's day_type library; guarded by dayTypeOptions membership.
const SIZE_TO_CHIP: Record<SizeBand, string> = {
  small: 'Low Participation/Compressed',
  normal: 'Medium Mush Market (Indecisive)',
  large: 'High Action Market',
}
const REGIME_TO_CHIP: Partial<Record<RegimeBand, string>> = {
  chop: 'Range Day',
  expanded: 'Trend Day',
  // mid → deliberately no structural call (the ambiguous middle)
}

// The trader's language for the regime, plus how common each band is (base rate
// across the study's day sample — useful context, not a trade edge).
const REGIME_DISPLAY: Record<RegimeBand, { label: string; share: number }> = {
  chop: { label: 'Choppy', share: 0.22 },
  mid: { label: 'Normal', share: 0.54 },
  expanded: { label: 'Extended', share: 0.24 },
}
const SIZE_DISPLAY: Record<SizeBand, string> = { small: 'Small', normal: 'Normal', large: 'Large' }

const REGIME_SCALE = [
  { key: 'chop', label: 'choppy <7.7' },
  { key: 'mid', label: 'normal 7.7–13' },
  { key: 'expanded', label: 'extended 13+' },
]
const SIZE_SCALE = [
  { key: 'small', label: 'small <0.75' },
  { key: 'normal', label: 'normal 0.75–1.25' },
  { key: 'large', label: 'large >1.25' },
]

/** Subtle non-judgmental tint on the regime headline (a cue, not good/bad). */
function regimeTint(b: RegimeBand): string {
  return b === 'chop' ? 'text-yellow-300' : b === 'expanded' ? 'text-blue-300' : 'text-gray-100'
}

export default function IbDayTypeOverview({
  session, stats, dayTypeOptions, currentDayTypes, onSuggest,
}: Props) {
  const cls = useMemo(() => classifyIbDayType({
    session,
    ibRange: stats?.ib_size ?? null,
    atrMeanHL10: stats?.meanHL10 ?? null,
    atrWilder10: stats?.atr_at_ib_close ?? null,
    ibVs10dAvg: stats?.ib_vs_10d_avg ?? null,
  }), [session, stats])

  const ibPrinted = cls.regimeBand != null
  const preSession = !stats?.realized || !ibPrinted

  // One-click chip suggestions from the two IB reads (only labels that exist in
  // the library and aren't already set).
  const currentSet = useMemo(() => new Set(currentDayTypes), [currentDayTypes])
  const optionSet = useMemo(() => new Set(dayTypeOptions), [dayTypeOptions])
  const suggestions = useMemo(() => {
    const out: Array<{ label: string; axis: 'action' | 'structure' }> = []
    if (cls.sizeBand) {
      const l = SIZE_TO_CHIP[cls.sizeBand]
      if (optionSet.has(l)) out.push({ label: l, axis: 'action' })
    }
    if (cls.regimeBand) {
      const l = REGIME_TO_CHIP[cls.regimeBand]
      if (l && optionSet.has(l)) out.push({ label: l, axis: 'structure' })
    }
    return out
  }, [cls.sizeBand, cls.regimeBand, optionSet])
  const toAdd = suggestions.filter(s => !currentSet.has(s.label)).map(s => s.label)

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500 -mt-1 max-w-[64ch]">
        Where today’s initial balance sits — is it choppy, normal, or extended, and how big vs your typical IB. NQ.
      </p>

      <div className="space-y-4">
        {/* Regime — choppy / normal / extended (IB ÷ ATR) */}
        <div className="border-l-2 border-gray-700 pl-4 py-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Day character · IB ÷ ATR</div>
          {ibPrinted && cls.regimeBand && cls.regimeRatio != null ? (
            <>
              <ClassLine
                value={REGIME_DISPLAY[cls.regimeBand].label}
                valueTone={regimeTint(cls.regimeBand)}
                sub={`IB ${fmtPts(stats?.ib_size)} ÷ ATR ${fmtPts(cls.regimeBasis === 'wilder' ? stats?.atr_at_ib_close : stats?.meanHL10)} = ${cls.regimeRatio.toFixed(1)}×${cls.regimeBasis === 'wilder' ? ' (Wilder — approx.)' : ''} · ~${Math.round(REGIME_DISPLAY[cls.regimeBand].share * 100)}% of days`}
              />
              <ScaleLine segments={REGIME_SCALE} active={cls.regimeBand} />
            </>
          ) : (
            <PendingLine text="IB not printed yet — this updates at IB close." />
          )}
        </div>

        {/* IB size — small / normal / large vs the 10-day average */}
        <div className="border-l-2 border-gray-700 pl-4 py-1">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">IB size · vs 10-day avg</div>
          {!cls.sizeSupported ? (
            <PendingLine text="RTH-only — IB size isn’t baselined overnight." muted />
          ) : ibPrinted && cls.sizeBand && cls.sizeRatio != null ? (
            <>
              <ClassLine
                value={SIZE_DISPLAY[cls.sizeBand]}
                sub={`${cls.sizeRatio.toFixed(2)}× your 10-day average IB`}
              />
              <ScaleLine segments={SIZE_SCALE} active={cls.sizeBand} />
            </>
          ) : (
            <PendingLine text="IB not printed yet — this updates at IB close." />
          )}
        </div>
      </div>

      {/* Suggested day types (one-click) — the objective read → your chips. */}
      {suggestions.length > 0 && (
        <div className="pt-3 border-t border-gray-800">
          <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">Suggested day types</span>
            {toAdd.length > 0 && (
              <button
                type="button"
                onClick={() => onSuggest(toAdd)}
                className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 border border-gray-700 hover:border-gray-600 rounded px-2.5 py-1.5 transition-colors"
                title="Append these day-type chips to today's selection (you can remove any above)"
              >
                <Plus className="w-3 h-3" />
                Add {toAdd.length} day type{toAdd.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map(s => {
              const isSet = currentSet.has(s.label)
              return (
                <button
                  key={s.label}
                  type="button"
                  disabled={isSet}
                  onClick={() => onSuggest([s.label])}
                  className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors ${
                    isSet
                      ? 'opacity-45 border-gray-700 bg-gray-900/40 cursor-default'
                      : 'border-blue-800 text-blue-200 hover:border-blue-600 hover:bg-blue-950/40'
                  }`}
                  title={isSet ? `${s.label} is already set` : `Add ${s.label}`}
                >
                  <span className="text-[9px] uppercase tracking-wider font-mono text-gray-500">
                    {s.axis === 'action' ? 'action' : 'structure'}
                  </span>
                  <span className="text-gray-200 font-medium">{s.label}</span>
                  {isSet ? <Check className="w-2.5 h-2.5 text-green-500" /> : <Plus className="w-2.5 h-2.5" />}
                </button>
              )
            })}
          </div>
          {preSession && (
            <p className="text-[11px] text-gray-500 mt-2 leading-normal">
              Estimated pre-IB — the read firms up once the initial balance closes.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

/** Today's classification for a read: a bold display value + a quiet detail. */
function ClassLine({ value, valueTone = 'text-gray-100', sub }: { value: string; valueTone?: string; sub: string }) {
  return (
    <div>
      <div
        className={`text-[22px] font-bold tracking-tight leading-tight ${valueTone}`}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5 max-w-[60ch]">{sub}</div>
    </div>
  )
}

/** The band scale for a read, with today's band emphasized. */
function ScaleLine({ segments, active }: { segments: Array<{ key: string; label: string }>; active: string | null }) {
  return (
    <div className="mt-1.5 text-[11px] text-gray-600 flex flex-wrap gap-x-2">
      {segments.map((s, i) => (
        <span key={s.key} className={s.key === active ? 'text-gray-200 font-semibold' : ''}>
          {s.label}{i < segments.length - 1 ? ' ·' : ''}
        </span>
      ))}
    </div>
  )
}

/** Placeholder for a read whose input hasn't printed yet (or isn't supported). */
function PendingLine({ text, muted = false }: { text: string; muted?: boolean }) {
  return <div className={`text-sm ${muted ? 'text-gray-600' : 'text-gray-400'} leading-normal max-w-[52ch]`}>{text}</div>
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format a point value compactly (e.g. 118.5 → "118"). Null → "—". */
function fmtPts(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(v >= 100 ? 0 : 1)
}
