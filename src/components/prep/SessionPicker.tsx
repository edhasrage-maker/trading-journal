'use client'

import { Clock, Moon } from 'lucide-react'
import type { SessionKind, SessionLevels } from '@/lib/session-levels'

const SESSIONS: { key: SessionKind; label: string; window: string }[] = [
  { key: 'rth', label: 'RTH', window: '06:30–13:00 PT' },
  { key: 'asia', label: 'Asia', window: '17:00–02:00 PT' },
  { key: 'london', label: 'London', window: '00:00–06:30 PT' },
]

function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/**
 * Session selector for the Prep page — RTH / Asia / London. RTH is the normal
 * day session; Asia/London re-anchor the chart's IB + extensions to that
 * overnight session and surface the prior-cycle Asia/London reference ranges.
 * The choice persists in prep_notes_json.session (see PrepClient). On Asia/London
 * a read-only levels readout shows the numbers, since they're deliberately NOT
 * written into the RTH-semantic market_context.
 */
export default function SessionPicker({
  value,
  onChange,
  levels,
}: {
  value: SessionKind
  onChange: (s: SessionKind) => void
  /** Live session levels for the readout — pass null to hide it (RTH). */
  levels: SessionLevels | null
}) {
  const active = SESSIONS.find(s => s.key === value) ?? SESSIONS[0]
  const ibTag = value === 'asia' ? 'Asia IB' : value === 'london' ? 'London IB' : 'IB'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        <span className="flex items-center gap-1.5 text-sm text-gray-400">
          <Clock className="w-4 h-4" /> Session
        </span>
        <div className="inline-flex bg-gray-800 border border-gray-700 rounded-lg overflow-hidden text-xs">
          {SESSIONS.map(s => (
            <button
              key={s.key}
              type="button"
              onClick={() => onChange(s.key)}
              className={`px-4 py-1.5 transition-colors ${
                value === s.key ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="font-mono text-xs text-gray-500">{active.window}</span>
        {value !== 'rth' && (
          <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-yellow-500/15 text-yellow-300 border border-yellow-500/30">
            <Moon className="w-3 h-3" /> Planned GBX
          </span>
        )}
      </div>

      {value !== 'rth' && levels && (
        <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs border-t border-gray-800 pt-3">
          <Readout label={`${ibTag}`} lo={levels.ibl} hi={levels.ibh} />
          <Readout label="Prior Asia" lo={levels.priorAsiaL} hi={levels.priorAsiaH} />
          <Readout label="Prior London" lo={levels.priorLondonL} hi={levels.priorLondonH} />
          <span className="text-gray-600 self-center">Reference levels drawn on the chart · not saved to Market Context</span>
        </div>
      )}
    </div>
  )
}

function Readout({ label, lo, hi }: { label: string; lo: number | null; hi: number | null }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-gray-300">{fmt(lo)}</span>
      <span className="text-gray-600">–</span>
      <span className="font-mono text-gray-300">{fmt(hi)}</span>
    </span>
  )
}
