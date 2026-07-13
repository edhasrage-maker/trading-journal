'use client'

import { useState } from 'react'
import { ChevronDown, Waves } from 'lucide-react'
import { readConditions, type VerdictTone } from '@/lib/condition-verdicts'
import type { MarketContext } from '@/lib/supabase/types'

/**
 * "Today's Tape" — verdict-first conditions card (alpha-readiness item 14).
 *
 * Leads with a plain-language headline + sentence, then one chip per metric
 * with the verdict word first and the raw number in a quiet pill. The raw
 * numbers grid is collapsed behind a disclosure (cut-list: "raw conditions
 * grid collapses behind the verdict chips"). Renders for every user — it
 * needs only market_context values, no history tables.
 */

interface Props {
  context: Partial<MarketContext>
  /** 10-day average of the 1-min ATR (from /api/bars/market-context) — the
   *  "typical" baseline behind the "2.7× normal" read. Null = no baseline;
   *  the bar-volatility chip degrades to the labeled raw value. */
  atrBaseline: number | null
}

const numOr = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

const VERDICT_CLS: Record<VerdictTone, string> = {
  red: 'text-red-400',
  amber: 'text-yellow-400',
  dim: 'text-gray-400',
  plain: 'text-gray-200',
}

export default function ConditionVerdicts({ context, atrBaseline }: Props) {
  const [showRaw, setShowRaw] = useState(false)

  const read = readConditions({
    rvol: numOr(context.rvol),
    atr1m: numOr(context.atr_1m),
    atrBaseline,
    adr: numOr(context.adr),
    onh: numOr(context.onh),
    onl: numOr(context.onl),
    dayRange: numOr(context.day_range),
    ibRatio: numOr(context.ib_vs_10d_avg),
  })

  // Nothing to say yet (no bars, empty form) — render nothing rather than an
  // empty shell card.
  if (read.chips.length === 0) return null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
        <Waves className="w-4 h-4 text-yellow-500" />
        <h2 className="font-semibold text-white">Today&apos;s Tape</h2>
      </div>

      <div className="p-5 space-y-4">
        {read.headline && (
          <div className="border-l-2 border-yellow-500/70 pl-3">
            <div className="text-lg font-semibold text-white">{read.headline}</div>
            {read.sentence && (
              <p className="text-xs text-gray-400 mt-1 max-w-prose">{read.sentence}</p>
            )}
          </div>
        )}
        {!read.headline && read.sentence && (
          <p className="text-xs text-gray-400 max-w-prose">{read.sentence}</p>
        )}

        {/* Verdict chips — plain label, verdict word, raw number in a quiet pill */}
        <div className="flex flex-wrap gap-2">
          {read.chips.map(c => (
            <span
              key={c.label}
              title={c.title}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border border-gray-700 bg-gray-950 text-gray-500"
            >
              {c.label}
              {c.verdict && (
                <>
                  {' — '}
                  <b className={`font-semibold ${VERDICT_CLS[c.tone]}`}>{c.verdict}</b>
                </>
              )}
              <span className="font-mono text-[10px] text-gray-500 bg-gray-900 border border-gray-800 rounded px-1.5 py-px whitespace-nowrap">
                {c.pill}
              </span>
            </span>
          ))}
        </div>

        {/* Raw numbers, collapsed by default */}
        {read.raw.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowRaw(o => !o)}
              className="flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${showRaw ? '' : '-rotate-90'}`} />
              {showRaw ? 'Hide raw numbers' : 'Show raw numbers'}
            </button>
            {showRaw && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                {read.raw.map(r => (
                  <div key={r.label} className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{r.label}</div>
                    <div className="font-mono text-sm text-gray-200">{r.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
