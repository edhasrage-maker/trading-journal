'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Target, ChevronRight } from 'lucide-react'
import { useUiMode } from '@/lib/ui-mode'

/**
 * Beginner ("Highlights") dashboard — a coach REPORT, not a lighter journal.
 * Leads with a one-line verdict (the diagnosis) + net P&L, then the single
 * focus (the prescription), a calm row of clean stat chips, the equity curve,
 * recent sessions, and a seam into Detailed Tape. Same engine as Pro, translated
 * to plain English (docs/BEGINNER_PRO_MODES.md, docs highlights-redesign).
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
  // Performance charts (equity curve), rendered below the stat chips.
  charts?: ReactNode
}

function money(n: number | null): string {
  if (n == null) return '—'
  return `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`
}

function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// Deterministic period verdict — the one-line "how am I doing + the pattern"
// read. Derived from the same signals the focus line uses; this is the
// DIAGNOSIS, the "Your one focus" card carries the PRESCRIPTION, so they
// complement rather than repeat. No AI call — instant and reproducible.
function periodVerdict(opts: { pnl: number; capturePct: number | null; winRate: number | null; tradedDays: number }):
  { tone: 'good' | 'watch' | 'down'; label: string; text: string } {
  const { pnl, capturePct, winRate, tradedDays } = opts
  if (tradedDays === 0) return { tone: 'watch', label: 'Getting started', text: 'Log or import a few sessions and your read shows up here.' }
  if (pnl > 0) {
    if (capturePct != null && capturePct < 50) return { tone: 'watch', label: 'Strong month, one leak', text: "You're green this month, but you're leaving profit on the table." }
    if (capturePct != null) return { tone: 'good', label: 'Strong month', text: "Green month — and you're converting your setups well." }
    if (winRate != null && winRate < 50) return { tone: 'good', label: 'Winners are working', text: 'Green even below a 50% win rate — your winners outsize your losers.' }
    return { tone: 'good', label: 'Strong month', text: "Green this month — keep doing what's working." }
  }
  if (pnl < 0) {
    if (capturePct != null && capturePct < 50) return { tone: 'down', label: 'Down — exits are the leak', text: "Down this stretch, and you're giving back the moves you catch." }
    return { tone: 'down', label: 'Down this stretch', text: "Down over the last 30 days — let's tighten one thing at a time." }
  }
  return { tone: 'watch', label: 'Around breakeven', text: 'Flat this month — roughly breakeven.' }
}

const TONE: Record<'good' | 'watch' | 'down', { dot: string; text: string }> = {
  good: { dot: 'bg-green-400', text: 'text-green-400' },
  watch: { dot: 'bg-amber-400', text: 'text-amber-400' },
  down: { dot: 'bg-red-400', text: 'text-red-400' },
}

export default function BeginnerDashboard({ pnl, winRate, capturePct, greenDays, tradedDays, bestDay, focus, sessions, charts }: Props) {
  const { setMode } = useUiMode()
  const v = periodVerdict({ pnl, capturePct, winRate, tradedDays })
  const tone = TONE[v.tone]

  // Calm reference row. Conversion only appears when there's capture data (a
  // bare "—" reads as broken). Best day is signed-colored.
  const chips: { label: string; value: string; valueClass?: string; title?: string }[] = [
    { label: 'Day win rate', value: tradedDays > 0 ? `${Math.round((greenDays / tradedDays) * 100)}%` : '—' },
    { label: 'Win rate', value: winRate == null ? '—' : `${Math.round(winRate)}%` },
    ...(capturePct != null
      ? [{ label: 'Conversion', value: `${capturePct}%`, title: 'Of the best point your trade reached in your favor, how much you kept at exit, on average.' }]
      : []),
    {
      label: 'Best day',
      value: money(bestDay),
      valueClass: (bestDay ?? 0) > 0 ? 'text-green-400' : (bestDay ?? 0) < 0 ? 'text-red-400' : 'text-gray-100',
    },
  ]
  const chipCols = chips.length === 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'

  return (
    <div className="space-y-4">
      {/* Hero report card — the period verdict + net P&L. The sentence carries
          the meaning; the number is the evidence beneath it. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
          <span className={`text-xs font-medium ${tone.text}`}>{v.label}</span>
        </div>
        <p className="text-lg font-semibold text-white leading-snug">{v.text}</p>
        <div className="flex items-baseline gap-2 mt-3 flex-wrap">
          <span className={`text-3xl font-bold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{money(pnl)}</span>
          <span className="text-xs text-gray-500">net P&amp;L · last 30 days · {tradedDays} session{tradedDays === 1 ? '' : 's'}</span>
        </div>
      </div>

      {/* Your one focus — the single action, in plain English. */}
      <div className="rounded-xl border p-4" style={{ background: 'rgba(224,163,60,0.08)', borderColor: 'rgba(224,163,60,0.35)' }}>
        <div className="flex items-center gap-2 mb-1.5">
          <Target className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-400">Your one focus</span>
        </div>
        <p className="text-sm text-gray-200 leading-relaxed">{focus}</p>
      </div>

      {/* Clean stat chips — the calm reference row (numbers, not verdicts). */}
      <div className={`grid grid-cols-2 ${chipCols} gap-3`}>
        {chips.map(c => (
          <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4" title={c.title}>
            <div className="text-xs text-gray-500 mb-1">{c.label}</div>
            <div className={`text-xl font-semibold ${c.valueClass ?? 'text-gray-100'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Equity curve (kept in Highlights — intuitive). */}
      {charts}

      {/* Recent sessions — each day gets a plain-English note vs your own baseline. */}
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

      {/* Graduation seam — one tap into the full Detailed Tape view. */}
      <button
        type="button"
        onClick={() => setMode('pro')}
        className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 border border-gray-800 hover:border-gray-600 rounded-xl py-2.5 transition-colors"
      >
        See your full breakdown <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}
