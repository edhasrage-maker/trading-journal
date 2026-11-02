'use client'

import { useMemo } from 'react'
import { computeBehavioralProxies, type ProxyTrade, type BehavioralProxy, type StackMarketReading } from '@/lib/behavioral-proxies'
import type { RoundTripStats } from '@/lib/trade-excursion'
import type { TodayHeat } from '@/lib/heat-baseline'
import { todaySentence } from './HeatBaseline'

/**
 * Highlights' "What happened" (founder-approved, docs/tapescore-recap-highlights-mockup-r1.html).
 *
 * The same evidence Detailed shows in Session behavior and the heat line, said
 * as one plain sentence per point with the trade numbers the trade list now
 * carries — no "evaluable", no "×ATR", no lifetime split. Only what was
 * checked is claimed: the all-clear names the checks, nothing more.
 */

const PLAIN: Record<BehavioralProxy['key'], string> = {
  revenge_reentry: 'You got back in soon after a loss',
  shrinking_hold: 'You held each trade for less time as the day went on',
  stacking: 'You took several trades in a row the same direction',
  pressing_drawdown: 'You sized up while red on the day or right after a loss',
  reopened_after_ending: 'You traded again after calling the session done',
}

/** A losing stack whose market move was read says which way the market went
 *  (founder-approved wording, 2026-11-02). */
const PLAIN_STACK: Record<StackMarketReading, string> = {
  against: 'You took several trades in a row the same direction, and the market went against you',
  with: 'You took several trades in a row the same direction. The market went your way; the entries cost you',
  flat: 'You took several trades in a row the same direction while price went nowhere',
}

type Line = { tone: 'bad' | 'ok' | 'info'; text: string; refs: number[] }

function refsLabel(refs: number[]): string {
  if (!refs.length) return ''
  return refs.length === 1 ? `trade ${refs[0]}` : `trades ${refs.join(', ')}`
}

export default function RecapWhatHappened({
  trades,
  sessionEndedAt,
  roundTrip,
  pressingIds,
  atrByTradeId,
  today,
}: {
  trades: ProxyTrade[]
  sessionEndedAt?: string | null
  roundTrip?: RoundTripStats | null
  pressingIds?: readonly string[] | null
  /** Live ATR at each entry, for the stacking proxy's market read. */
  atrByTradeId?: Readonly<Record<string, number>> | null
  today: TodayHeat | null
}) {
  const { tradeCount, proxies } = useMemo(
    () => computeBehavioralProxies(trades, sessionEndedAt, { pressingIds, atrByTradeId }),
    [trades, sessionEndedAt, pressingIds, atrByTradeId],
  )
  if (trades.length === 0) return null

  const seqById = new Map(trades.map((t, i) => [t.id, i + 1]))
  const lines: Line[] = []

  // Fill-sequence habits — only with two or more trades, as Detailed reads them.
  if (tradeCount >= 2) {
    for (const p of proxies) {
      if (p.severity === 'none') continue
      const plain = p.market ? PLAIN_STACK[p.market.reading] : PLAIN[p.key] ?? p.label
      lines.push({ tone: 'bad', text: `${plain}.`, refs: [...p.evidence].sort((a, b) => a - b) })
    }
  }

  if (roundTrip && roundTrip.count > 0) {
    const refs = roundTrip.ids.map(id => seqById.get(id)).filter((n): n is number => n != null).sort((a, b) => a - b)
    const who = refs.length === 0 ? 'A trade' : refs.length === 1 ? `Trade ${refs[0]}` : `Trades ${refs.join(' and ')}`
    lines.push({
      tone: 'bad',
      text: `${who} went your way, then closed at breakeven or worse: $${Math.round(roundTrip.giveBackUsd).toLocaleString('en-US')} given back from the best point.`,
      refs,
    })
  }

  const flagged = lines.length > 0
  if (today) lines.push({ tone: 'info', text: todaySentence(today), refs: [] })
  if (!flagged && tradeCount >= 2) {
    lines.unshift({
      tone: 'ok',
      text: 'No quick re-entries after a loss, no sizing up, no winner given back. A steady session.',
      refs: [],
    })
  }
  if (!lines.length) return null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="flex items-baseline justify-between gap-3 mb-3">
        <span className="font-semibold text-white text-sm" style={{ fontFamily: 'var(--font-display)' }}>What happened</span>
        <span className="text-[11px] text-gray-500">from your fills and what price did</span>
      </h2>
      <ul className="space-y-2.5">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[14px] text-gray-200 leading-snug">
            <span
              className={`mt-[1px] w-[18px] h-[18px] shrink-0 rounded-full grid place-items-center text-[11px] font-bold ${
                l.tone === 'bad' ? 'bg-red-950/60 text-red-300' : l.tone === 'ok' ? 'bg-green-950/60 text-green-300' : 'bg-gray-800 text-gray-400'
              }`}
              aria-hidden="true"
            >
              {l.tone === 'bad' ? '!' : l.tone === 'ok' ? '✓' : '·'}
            </span>
            <span className="min-w-0">
              {l.text}
              {l.refs.length > 0 && (
                <span className="ml-1.5 text-[11px] font-semibold text-gray-400 border border-gray-700 rounded px-1.5 py-px whitespace-nowrap">
                  {refsLabel(l.refs)}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
