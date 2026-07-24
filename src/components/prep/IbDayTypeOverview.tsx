'use client'

import { useMemo } from 'react'
import { Check, Plus } from 'lucide-react'
import { classifyIbDayType, type RegimeBand, type SizeBand } from '@/lib/ib-day-type'
import {
  IB_FADE_BASIS,
  PLAYBOOK_A_SETUP,
  PLAYBOOK_RULES,
  PLAYBOOK_CAUTIONS,
  CONFIDENCE_LABEL,
  sessionEdge,
  regimeEdge,
  sizeEdge,
  formatNetR,
  type Confidence,
} from '@/lib/ib-fade-reference'
import type { SessionKind } from '@/lib/session-levels'
import type { DayContextStats } from '@/lib/market-context-from-bars'

/**
 * IB-fade Day-Type Overview — a prep-time read that classifies today's Initial
 * Balance along three independent lenses and surfaces the historical fade edge +
 * playbook for each. Same idea as Morning Conditions (condition_lookup), but the
 * reference edge is the static IB-fade study (ib-fade-reference.ts), not the
 * trader's own trade history, and the classification is deterministic
 * (ib-day-type.ts) rather than a DB lookup.
 *
 * The lenses are marginal (each read on its own axis), never crossed into one
 * bucket — the fully-crossed cell is too thin. Honesty is explicit: the chop-day
 * fade + 0.5×ATR floor + 2-entry sequence are VERIFIED; "mid/expanded also work"
 * and the whole size lens are PRELIMINARY, and rendered muted.
 *
 * Beyond the fade edge, the two IB lenses also OBJECTIVELY suggest day-type
 * chips — validated against the trader's own tagging history:
 *   - IB/ATR regime → Trend Day / Range Day (it measures directionality; Trend
 *     11.0 vs Range 8.4 median separate cleanly, High/Med/Low do not).
 *   - IB size (÷10d) → High / Medium / Low action (medians 1.31/0.85/0.58 fall
 *     right on the size cuts; this is the magnitude axis IB/ATR can't see).
 * Suggestions are one-click and only offered for labels that exist in the
 * trader's library. (Phase 2: persist these to market_context/day_types[] so
 * condition_lookup can bucket actual trades against the edge.)
 */

interface Props {
  /** The session this prep targets (drives the session-keyed edge + IB windows). */
  session: SessionKind
  /** Full bar-derived stats for the day. Null until bars load. `ib_size` = IB
   *  range, `meanHL10` = study ATR, `atr_at_ib_close` = Wilder fallback,
   *  `ib_vs_10d_avg` = size ratio. */
  stats: DayContextStats | null
  /** Day-type chips available in the trader's library — a mapped suggestion is
   *  only offered when its label exists here (degrades if the library differs). */
  dayTypeOptions: string[]
  /** Currently-selected day-type chips, so suggestions mark already-set labels. */
  currentDayTypes: string[]
  /** Append handler — same contract as DayTypePredictor's onAccept; the parent
   *  dedupes and appends to its day_types[] state. */
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

const REGIME_LABEL: Record<RegimeBand, string> = { chop: 'Chop', mid: 'Mid', expanded: 'Expanded' }
const SIZE_LABEL: Record<SizeBand, string> = { small: 'Small', normal: 'Normal', large: 'Large' }

/** Left-rule tone by fade confidence — verified reads lead in green, preliminary
 *  ones are muted so they never masquerade as the A-setup. */
function ruleTone(c: Confidence): string {
  return c === 'verified' ? 'border-green-700' : 'border-gray-700'
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

  const sEdge = sessionEdge(session)
  const ibPrinted = cls.regimeBand != null
  const preSession = !stats?.realized || !ibPrinted

  // Objective chip suggestions from the two IB lenses (only labels that exist in
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
      {/* Provenance — the section owns the heading. */}
      <div className="text-xs text-gray-500 -mt-1">{IB_FADE_BASIS}</div>

      {/* ── Three lenses ── */}
      <div className="space-y-4">
        {/* Lens 1 — Session (chop-day fade edge, verified) */}
        <Lens
          label="Session"
          tone={ruleTone(sEdge.confidence)}
          classification={
            <ClassLine
              value={`${sEdge.label}${sEdge.star ? ' ★' : ''}`}
              sub={`${sEdge.windowPT} · ${sEdge.ibWindowPT}`}
            />
          }
        >
          <EdgeReadout
            headline={formatNetR(sEdge.twoEntryR)}
            headlineNote="net R · 2-entry chop-day fade"
            sub={`win ${(sEdge.chopWinRate * 100).toFixed(0)}% · single ${formatNetR(sEdge.singleEntryR)}${sEdge.splits ? ` · ${sEdge.splits} yrs` : ''}`}
            confidence={sEdge.confidence}
          />
          <MetaLine text={`Timing: ${sEdge.timing}`} />
          {sEdge.note && <MetaLine text={sEdge.note} />}
        </Lens>

        {/* Lens 2 — IB / ATR regime (fade edge by band + Trend/Range read) */}
        <Lens
          label="IB / ATR regime"
          tone={cls.regimeBand ? ruleTone(regimeEdge(cls.regimeBand).confidence) : 'border-gray-700'}
          classification={
            ibPrinted && cls.regimeBand && cls.regimeRatio != null ? (
              <ClassLine
                value={`${REGIME_LABEL[cls.regimeBand]} · ${cls.regimeRatio.toFixed(1)}×`}
                sub={`IB ${fmtPts(stats?.ib_size)} ÷ ATR ${fmtPts(cls.regimeBasis === 'wilder' ? stats?.atr_at_ib_close : stats?.meanHL10)}${cls.regimeBasis === 'wilder' ? ' (Wilder — approx.)' : ''} · ${(regimeEdge(cls.regimeBand).share * 100).toFixed(0)}% of days`}
              />
            ) : (
              <PendingLine text="IB not yet printed — updates at IB close." />
            )
          }
        >
          {ibPrinted && cls.regimeBand && (() => {
            const e = regimeEdge(cls.regimeBand)
            const r = session === 'rth' ? e.rthR : e.allNqR
            return (
              <EdgeReadout
                headline={formatNetR(r)}
                headlineNote={`net R · 2-entry${session === 'rth' ? ' · RTH' : ' · all-NQ'}`}
                sub={`${session === 'rth' && e.rthSplits ? `${e.rthSplits} yrs · ` : ''}${e.band === 'chop' ? 'A-setup' : 'edge tilts to chop'}`}
                confidence={e.confidence}
              />
            )
          })()}
          {ibPrinted && cls.regimeBand && REGIME_TO_CHIP[cls.regimeBand] && (
            <MetaLine text={`Reads as a ${REGIME_TO_CHIP[cls.regimeBand]} (IB÷ATR gauges direction).`} />
          )}
          {ibPrinted && cls.regimeBand === 'mid' && (
            <MetaLine text="Mid is the ambiguous middle — no Trend/Range call." />
          )}
        </Lens>

        {/* Lens 3 — IB size (magnitude → action level; RTH-only, thin) */}
        <Lens
          label="IB size"
          tone={cls.sizeBand ? ruleTone(sizeEdge(cls.sizeBand).confidence) : 'border-gray-700'}
          classification={
            !cls.sizeSupported ? (
              <PendingLine text="RTH-only — IB-vs-10d isn’t baselined overnight." muted />
            ) : cls.sizeBand && cls.sizeRatio != null ? (
              <ClassLine
                value={`${SIZE_LABEL[cls.sizeBand]} · ${cls.sizeRatio.toFixed(2)}×`}
                sub={`IB vs 10-day avg${cls.sizeBand === 'normal' ? ' (normal)' : ''}`}
              />
            ) : (
              <PendingLine text="IB not yet printed — updates at IB close." />
            )
          }
        >
          {cls.sizeSupported && cls.sizeBand && (() => {
            const e = sizeEdge(cls.sizeBand)
            return (
              <EdgeReadout
                headline={formatNetR(e.rthR)}
                headlineNote="net R · 2-entry · RTH"
                sub={`${e.splits} yrs · thin${e.star ? ' · best size band' : ''}`}
                confidence={e.confidence}
              />
            )
          })()}
          {cls.sizeSupported && cls.sizeBand && SIZE_TO_CHIP[cls.sizeBand] && optionSet.has(SIZE_TO_CHIP[cls.sizeBand]) && (
            <MetaLine text={`Reads as a ${SIZE_TO_CHIP[cls.sizeBand]} day (IB magnitude gauges action).`} />
          )}
        </Lens>
      </div>

      {/* ── Playbook ── */}
      <PlaybookCard regimeBand={cls.regimeBand} sizeBand={cls.sizeBand} />

      {/* ── Objective day-type suggestions (one-click) ── */}
      {suggestions.length > 0 && (
        <div className="pt-3 border-t border-gray-800">
          <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">
              Objective day-type read
            </span>
            {toAdd.length > 0 && (
              <button
                type="button"
                onClick={() => onSuggest(toAdd)}
                className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 border border-gray-700 hover:border-gray-600 rounded px-2.5 py-1.5 transition-colors"
                title="Append these objective day-type chips to today's selection (you can remove any above)"
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

/** One lens block — a left-ruled card with a lens label, today's classification,
 *  and the historical edge underneath. Mirrors the ConditionFilterPanel idiom. */
function Lens({
  label, tone, classification, children,
}: {
  label: string
  tone: string
  classification: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className={`border-l-2 pl-4 py-1 ${tone}`}>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      {classification}
      {children && <div className="mt-2 space-y-1.5">{children}</div>}
    </div>
  )
}

/** Today's classification for a lens: a bold display value + a quiet sub. */
function ClassLine({ value, sub }: { value: string; sub: string }) {
  return (
    <div>
      <div
        className="text-[19px] font-bold tracking-tight text-gray-100 leading-tight"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>
    </div>
  )
}

/** Placeholder line for a lens whose input hasn't printed yet (or isn't supported). */
function PendingLine({ text, muted = false }: { text: string; muted?: boolean }) {
  return <div className={`text-sm ${muted ? 'text-gray-600' : 'text-gray-400'} leading-normal max-w-[52ch]`}>{text}</div>
}

/** The historical edge readout: a signed net-R display numeral + a confidence tag. */
function EdgeReadout({
  headline, headlineNote, sub, confidence,
}: {
  headline: string
  headlineNote: string
  sub: string
  confidence: Confidence
}) {
  const tone = headline.startsWith('+') ? 'text-green-400' : 'text-red-400'
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <div className="flex items-baseline gap-2">
        <span
          className={`text-[17px] font-bold tabular-nums ${tone}`}
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {headline}
        </span>
        <span className="text-[11px] text-gray-500">{headlineNote}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-gray-400">{sub}</span>
        <ConfidenceTag confidence={confidence} />
      </div>
    </div>
  )
}

function ConfidenceTag({ confidence }: { confidence: Confidence }) {
  const cls = confidence === 'verified'
    ? 'border-green-700/60 text-green-300'
    : 'border-yellow-700/60 text-yellow-300'
  return (
    <span className={`text-[9px] uppercase font-mono border rounded px-1 py-px ${cls}`}>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  )
}

/** A quiet secondary line under an edge readout (timing, caveats, chip reads). */
function MetaLine({ text }: { text: string }) {
  return <p className="text-[11px] text-gray-500 leading-normal max-w-[64ch]">{text}</p>
}

/** The recommended fade sequence + situational cautions raised by the day-type. */
function PlaybookCard({
  regimeBand, sizeBand,
}: {
  regimeBand: RegimeBand | null
  sizeBand: SizeBand | null
}) {
  const cautions: string[] = []
  if (sizeBand === 'large') cautions.push(PLAYBOOK_CAUTIONS.largeIb)
  if (regimeBand === 'mid' || regimeBand === 'expanded') cautions.push(PLAYBOOK_CAUTIONS.nonChopRegime)

  return (
    <div className="border-l-2 border-green-700 pl-4 py-1">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Playbook</div>
      <p className="text-sm text-gray-200 leading-normal max-w-[66ch]">{PLAYBOOK_A_SETUP}</p>
      <ol className="mt-2 space-y-1 text-[13px] text-gray-300 list-decimal list-inside max-w-[66ch]">
        {PLAYBOOK_RULES.map((r, i) => <li key={i} className="leading-normal">{r}</li>)}
      </ol>
      {cautions.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {cautions.map((c, i) => (
            <p key={i} className="text-[11px] text-yellow-400/90 leading-normal max-w-[66ch]">
              ⚠ {c}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format a point value compactly (e.g. 118.5 → "118"). Null → "—". */
function fmtPts(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(v >= 100 ? 0 : 1)
}
