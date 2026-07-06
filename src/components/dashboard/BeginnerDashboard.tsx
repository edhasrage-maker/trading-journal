'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Target } from 'lucide-react'

/**
 * Beginner dashboard body — plain-English summary + one focus + a simple session
 * list. No jargon (MFE/MAE/capture/process live in Pro). The numbers here are the
 * same engine's output, just translated. See docs/BEGINNER_PRO_MODES.md.
 */
type Session = { date: string; pnl: number | null; note: string }

type Props = {
  pnl: number
  winRate: number | null
  capturePct: number | null
  greenDays: number
  tradedDays: number
  bestDay: number | null
  focus: string
  sessions: Session[]
  // Performance charts, rendered directly below the summary boxes so the
  // Highlights layout mirrors Detailed Tape (boxes → charts → the rest).
  charts?: ReactNode
}

function money(n: number | null): string {
  if (n == null) return '—'
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`
}

function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function BeginnerDashboard({ pnl, winRate, capturePct, greenDays, tradedDays, bestDay, focus, sessions, charts }: Props) {
  return (
    <div className="space-y-4">
      {/* Plain summary — a few "how am I doing" signals in plain language.
          "Move captured" only shows when there's capture data (imports without
          MFE/stops have none — a bare "—" reads as broken, so hide it). */}
      <div className={`grid grid-cols-2 sm:grid-cols-3 gap-3 ${capturePct == null ? 'xl:grid-cols-4' : 'xl:grid-cols-5'}`}>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Last 30 days</div>
          <div className={`text-2xl font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(pnl)}</div>
          <div className="text-[10px] text-gray-600 mt-0.5">net P&amp;L</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Win rate</div>
          <div className="text-2xl font-semibold text-gray-100" style={{ fontVariantNumeric: 'tabular-nums' }}>{winRate == null ? '—' : `${Math.round(winRate)}%`}</div>
        </div>
        {capturePct != null && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" title="Of the best point your trade reached in your favor, how much you kept at exit, on average. 100% = you exited at the high.">
            <div className="text-xs text-gray-500 mb-1">Profit conversion</div>
            <div className="text-2xl font-semibold text-gray-100" style={{ fontVariantNumeric: 'tabular-nums' }}>{capturePct}%</div>
            <div className="text-[10px] text-gray-600 mt-0.5">of your trade&apos;s best point</div>
          </div>
        )}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Green days</div>
          <div className="text-2xl font-semibold text-gray-100" style={{ fontVariantNumeric: 'tabular-nums' }}>{greenDays} <span className="text-gray-500 text-base font-normal">of {tradedDays}</span></div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Best day</div>
          <div className="text-2xl font-semibold text-green-400" style={{ fontVariantNumeric: 'tabular-nums' }}>{money(bestDay)}</div>
        </div>
      </div>

      {/* Performance charts — directly below the summary boxes (mirrors Pro). */}
      {charts}

      {/* Your one focus — the coach, in plain English */}
      <div className="rounded-xl border p-4" style={{ background: 'rgba(224,163,60,0.08)', borderColor: 'rgba(224,163,60,0.35)' }}>
        <div className="flex items-center gap-2 mb-1.5">
          <Target className="w-4 h-4 text-blue-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-blue-400">Your one focus</span>
        </div>
        <p className="text-sm text-gray-200 leading-relaxed">{focus}</p>
      </div>

      {/* Recent sessions — each day gets a plain-English note vs your own baseline */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Recent sessions</h2>
        </div>
        {sessions.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">No sessions yet.</div>
        ) : (
          sessions.map(s => (
            <Link
              key={s.date}
              href={`/eod/${s.date}`}
              className="flex items-start gap-3 px-4 py-3 border-b border-gray-800 last:border-0 hover:bg-gray-800 transition-colors"
            >
              <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${(s.pnl ?? 0) >= 0 ? 'bg-green-400' : 'bg-red-400'}`} />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-300">{fmtDate(s.date)}</div>
                {s.note && <div className="text-xs text-gray-500 mt-0.5 leading-snug">{s.note}</div>}
              </div>
              <span className={`text-sm font-semibold flex-shrink-0 ${(s.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(s.pnl)}</span>
            </Link>
          ))
        )}
      </div>

      <p className="text-xs text-gray-600 text-center">
        Want the full metrics — MFE, capture %, process scores? <span className="text-blue-400">Switch to Detailed Tape in the sidebar →</span>
      </p>
    </div>
  )
}
