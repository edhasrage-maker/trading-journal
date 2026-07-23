'use client'

import { useEffect, useState } from 'react'
import { readConditions, type VerdictTone } from '@/lib/condition-verdicts'
import { cn } from '@/lib/utils'
import type { MarketContext, PrepNotes } from '@/lib/supabase/types'

/**
 * The Prep hero — the forward read, and the trader's stance on it.
 *
 * Where Review leads with a retrospective finding and the score ring, Prep is
 * prospective: the headline is what the tape is doing *now*, and the credential
 * slot beside it is the trader's own stance. There is deliberately NO score on
 * Prep — nothing has been traded, so there is nothing to grade, and a ring here
 * would collide with the "graded decisions" meaning it carries on Review.
 *
 * Three honest states, all of which already existed in the data and are simply
 * elevated here: the read is SET (bars have printed), FORMING (pre-session, so
 * we show what the last 10 days would expect), or absent entirely. The hero
 * refuses to manufacture a read it doesn't have.
 *
 * The read states FACTS, not direction: RVOL / ADR / overnight establish speed
 * and extension. They say nothing about which way price goes, and the copy here
 * is careful never to imply otherwise.
 */

export type ReadState = 'set' | 'forming' | 'none'

const VERDICT_CLS: Record<VerdictTone, string> = {
  red: 'text-red-400',
  amber: 'text-yellow-400',
  dim: 'text-gray-400',
  plain: 'text-gray-200',
}

const STANCE = {
  go: { word: 'Go', cls: 'text-green-400' },
  caution: { word: 'Selective', cls: 'text-yellow-400' },
  avoid: { word: 'Sit out', cls: 'text-red-400' },
} as const

type StanceKey = keyof typeof STANCE

const numOr = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

/** Current time in the PT session timezone, e.g. "06:52". */
function ptClock(): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

export default function PrepHero({
  context,
  atrBaseline,
  prepNotes,
  onPrepNotesChange,
  eyebrow,
  isToday,
  maxConditions = 4,
}: {
  context: Partial<MarketContext>
  atrBaseline: number | null
  prepNotes: PrepNotes
  onPrepNotesChange: (v: PrepNotes) => void
  /** e.g. "FRI JUL 25 · RTH · NQ" */
  eyebrow: string
  isToday: boolean
  maxConditions?: number
}) {
  const [overriding, setOverriding] = useState(false)
  const [reason, setReason] = useState(prepNotes.day_stance_reason ?? '')

  // Hydration-safe clock: the server renders at time T and the client hydrates
  // a moment later, so computing the time during render would mismatch. Gate it
  // on a mount flag and tick so a prep left open stays honest about freshness.
  const [now, setNow] = useState<string | null>(null)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-gated clock for hydration safety
  useEffect(() => { setNow(ptClock()) }, [])
  useEffect(() => {
    if (!isToday) return
    const id = setInterval(() => setNow(ptClock()), 60_000)
    return () => clearInterval(id)
  }, [isToday])

  const adr = numOr(context.adr)
  const atr = numOr(context.atr_1m)
  const dayRange = numOr(context.day_range)

  const read = readConditions({
    rvol: numOr(context.rvol),
    atr1m: atr,
    atrBaseline,
    adr,
    onh: numOr(context.onh),
    onl: numOr(context.onl),
    dayRange,
    ibRatio: numOr(context.ib_vs_10d_avg),
  })

  // Pre-session: no realized range yet, but the last 10 days carried an
  // ADR/ATR expectation over. Show it as an expectation, never judged as if it
  // were live.
  const preSession = dayRange == null && (adr != null || atr != null)
  const state: ReadState = read.chips.length === 0 && !preSession
    ? 'none'
    : preSession ? 'forming' : 'set'

  const stateLabel = { set: 'Read is set', forming: 'Read is forming', none: 'No read yet' }[state]
  const stateCls = { set: 'text-blue-400', forming: 'text-yellow-400', none: 'text-gray-500' }[state]

  const headline =
    state === 'set' ? (read.headline ?? 'Conditions are printing.')
      : state === 'forming' ? 'Read fills in as the session prints.'
        : 'No read yet.'

  const sub =
    state === 'set' ? read.sentence
      : state === 'forming' ? 'Nothing has printed a range yet — this is what your last 10 days would expect for today.'
        : 'Waiting for today’s bars — nothing has printed and no expectation is stored.'

  const subnote =
    state === 'forming' ? 'The live read replaces this the moment bars start printing.'
      : state === 'none' ? 'Paste a morning chart or wait for the feed; the read appears here on its own.'
        : null

  const freshness =
    state === 'none' ? null
      : state === 'forming'
        ? `${now ? `As of ${now} PT · ` : ''}pre-session · from your last 10 days`
        : `${now ? `As of ${now} PT · ` : ''}read from your 1-min bars`

  // Pre-session expectations get their own heading so a carried-over ADR is
  // never mistaken for something today actually did.
  const conditions = state === 'forming'
    ? [
      ...(adr != null ? [{ label: 'Expected range', verdict: '~ADR', tone: 'dim' as VerdictTone, pill: `~${Math.round(adr)} pts` }] : []),
      ...(atr != null ? [{ label: 'Expected bar volatility', verdict: '~ATR', tone: 'dim' as VerdictTone, pill: `~${Math.round(atr)} pts` }] : []),
    ]
    : read.chips.slice(0, maxConditions).map(c => ({
      label: c.label, verdict: c.verdict, tone: c.tone, pill: c.pill,
    }))

  const stanceKey = prepNotes.day_stance as StanceKey | undefined
  const stance = stanceKey ? STANCE[stanceKey] : null
  const ownedByTrader = prepNotes.day_stance_source === 'trader'

  const setStance = (k: StanceKey, why?: string) => {
    onPrepNotesChange({
      ...prepNotes,
      day_stance: k,
      day_stance_source: 'trader',
      ...(why !== undefined ? { day_stance_reason: why || undefined } : {}),
    })
  }

  const confirmStance = () => {
    if (!stanceKey) return
    onPrepNotesChange({ ...prepNotes, day_stance_source: 'trader' })
  }

  return (
    <div className="grid gap-0 lg:grid-cols-[1fr_auto] items-stretch">
      {/* ── The read ── */}
      <div className="lg:pr-10 pb-6">
        <div className="font-mono text-[11.5px] tracking-wide text-gray-500 mb-3">{eyebrow}</div>
        <div className={cn('flex items-center gap-2 text-[12.5px] font-semibold mb-2.5', stateCls)}>
          {stateLabel}
          <span aria-hidden className="text-[11px] opacity-70">▸</span>
        </div>
        <h1
          className="text-[clamp(24px,3.2vw,32px)] font-bold leading-[1.08] tracking-[-0.025em] text-gray-100 text-balance max-w-[20ch]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {headline}
        </h1>
        {sub && <p className="mt-3.5 text-[15px] text-gray-100 max-w-[52ch] leading-normal">{sub}</p>}
        {subnote && <p className="mt-2 text-[13.5px] text-gray-400 max-w-[52ch] leading-normal">{subnote}</p>}
        {freshness && <div className="mt-3.5 font-mono text-[11px] text-gray-500">{freshness}</div>}
      </div>

      {/* ── Your stance + conditions ── */}
      <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 pb-6 lg:pl-8 lg:border-l border-gray-800 pt-6 lg:pt-0 border-t lg:border-t-0">
        <div className="flex flex-col justify-center sm:min-w-[150px]">
          <div className="text-[12.5px] text-gray-500 mb-2.5">Your stance</div>

          {stance ? (
            <>
              <div
                className={cn('text-[34px] font-bold leading-none tracking-[-0.02em]', stance.cls)}
                style={{ fontFamily: 'var(--font-display)' }}
              >
                {stance.word}
              </div>
              <div className="text-xs text-gray-500 mt-2.5 leading-snug">
                <span className="text-blue-400 border-b border-dotted border-blue-700">TapeScore suggested</span>
                {ownedByTrader
                  ? <> · <b className="text-gray-100 font-semibold">Confirmed by you</b></>
                  : null}
              </div>
              {prepNotes.day_stance_reason && (
                <p className="text-xs text-gray-400 mt-1.5 max-w-[26ch]">“{prepNotes.day_stance_reason}”</p>
              )}
              {!ownedByTrader && (
                <button
                  type="button"
                  onClick={confirmStance}
                  className="mt-2 self-start text-xs text-blue-400 hover:text-blue-300 border border-gray-700 rounded px-2 py-1 transition-colors"
                >
                  Confirm
                </button>
              )}
            </>
          ) : (
            <>
              <div
                className="text-[26px] font-light text-gray-500 tracking-[-0.01em]"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                No stance yet
              </div>
              <p className="text-xs text-gray-500 mt-2.5 max-w-[26ch]">
                A stance is yours to set once conditions print.
              </p>
            </>
          )}

          <button
            type="button"
            onClick={() => setOverriding(o => !o)}
            className="mt-2 self-start text-xs text-gray-400 hover:text-gray-200 transition-colors inline-flex items-center gap-1.5"
          >
            <span aria-hidden className="text-gray-500">⤺</span>
            {stance ? 'Override with a reason' : 'Set your stance'}
          </button>

          {overriding && (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(STANCE) as StanceKey[]).map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setStance(k, reason)}
                    className={cn(
                      'text-xs px-2.5 py-1.5 rounded border transition-colors',
                      stanceKey === k
                        ? 'border-gray-600 bg-gray-800 text-gray-100'
                        : 'border-gray-700 text-gray-400 hover:text-gray-200',
                    )}
                  >
                    {STANCE[k].word}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={reason}
                onChange={e => setReason(e.target.value)}
                onBlur={() => { if (stanceKey) setStance(stanceKey, reason) }}
                placeholder="Why? (optional)"
                className="w-full bg-gray-950 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-600"
              />
            </div>
          )}
        </div>

        {conditions.length > 0 && (
          <div className="flex flex-col sm:min-w-[210px]">
            <div className="text-[12.5px] text-gray-500 mb-3">
              {state === 'forming' ? 'Expected from your last 10 days' : 'Conditions'}
            </div>
            {conditions.map((c, i) => (
              <div key={c.label} className={cn('py-2.5', i > 0 && 'border-t border-gray-800')}>
                <div className="flex items-baseline justify-between gap-3.5">
                  <span className="text-[13.5px] font-semibold text-gray-100">{c.label}</span>
                  {c.verdict && (
                    <span
                      className={cn('text-sm font-bold tracking-[-0.01em] capitalize', VERDICT_CLS[c.tone])}
                      style={{ fontFamily: 'var(--font-display)' }}
                    >
                      {c.verdict}
                    </span>
                  )}
                </div>
                <div className="font-mono text-[11px] text-gray-400 mt-0.5">{c.pill}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
