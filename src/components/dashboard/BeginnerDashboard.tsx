'use client'

import Link from 'next/link'
import { Target } from 'lucide-react'

/**
 * Beginner dashboard body — plain-English summary + one focus + a simple session
 * list. No jargon (MFE/MAE/capture/process live in Pro). The numbers here are the
 * same engine's output, just translated. See docs/BEGINNER_PRO_MODES.md.
 */
type Session = { date: string; pnl: number | null; grade: number | null; breach: boolean }

type Props = {
  pnl: number
  greenDays: number
  tradedDays: number
  bestDay: number | null
  focus: string
  sessions: Session[]
}

function money(n: number | null): string {
  if (n == null) return '—'
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`
}

function quality(s: Session): { word: string; dot: string } {
  if (s.breach) return { word: 'Breached a rule', dot: 'bg-red-400' }
  if (s.grade == null) return { word: 'Logged', dot: 'bg-gray-500' }
  if (s.grade >= 7) return { word: 'Clean session', dot: 'bg-green-400' }
  if (s.grade >= 4) return { word: 'Solid', dot: 'bg-gray-400' }
  return { word: 'Rushed a few', dot: 'bg-yellow-400' }
}

function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function BeginnerDashboard({ pnl, greenDays, tradedDays, bestDay, focus, sessions }: Props) {
  return (
    <div className="space-y-4">
      {/* Plain summary — no jargon */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Last 30 days</div>
          <div className={`text-2xl font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(pnl)}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Green days</div>
          <div className="text-2xl font-semibold text-gray-100" style={{ fontVariantNumeric: 'tabular-nums' }}>{greenDays} <span className="text-gray-500 text-base font-normal">of {tradedDays}</span></div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="text-xs text-gray-500 mb-1">Best day</div>
          <div className="text-2xl font-semibold text-green-400" style={{ fontVariantNumeric: 'tabular-nums' }}>{money(bestDay)}</div>
        </div>
      </div>

      {/* Your one focus — the coach, in plain English */}
      <div className="rounded-xl border p-4" style={{ background: 'rgba(224,163,60,0.08)', borderColor: 'rgba(224,163,60,0.35)' }}>
        <div className="flex items-center gap-2 mb-1.5">
          <Target className="w-4 h-4 text-blue-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-blue-400">Your one focus</span>
        </div>
        <p className="text-sm text-gray-200 leading-relaxed">{focus}</p>
      </div>

      {/* Recent sessions — plain result + quality word */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white" style={{ fontFamily: 'var(--font-display)' }}>Recent sessions</h2>
        </div>
        {sessions.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500 text-center">No sessions yet.</div>
        ) : (
          sessions.map(s => {
            const q = quality(s)
            return (
              <Link
                key={s.date}
                href={`/eod/${s.date}`}
                className="flex items-center justify-between px-4 py-3 text-sm border-b border-gray-800 last:border-0 hover:bg-gray-800 transition-colors"
              >
                <span className="text-gray-300">{fmtDate(s.date)}</span>
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-2 text-gray-500 text-xs"><span className={`w-2 h-2 rounded-full ${q.dot}`} />{q.word}</span>
                  <span className={`font-semibold min-w-[64px] text-right ${(s.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(s.pnl)}</span>
                </span>
              </Link>
            )
          })
        )}
      </div>

      <p className="text-xs text-gray-600 text-center">
        Want the full metrics — MFE, capture %, process scores? <span className="text-blue-400">Switch to Pro in the sidebar →</span>
      </p>
    </div>
  )
}
