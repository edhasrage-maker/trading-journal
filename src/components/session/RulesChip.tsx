'use client'

import { ChevronDown, ChevronUp } from 'lucide-react'
import { rulesChip, type RuleResult } from '@/lib/entry-rules'

const TONE: Record<'ok' | 'bad' | 'mid', string> = {
  ok: 'text-emerald-400 border-emerald-400/40',
  bad: 'text-red-400 border-red-400/45',
  mid: 'text-gray-200 border-gray-700',
}
const DOT: Record<RuleResult['status'], string> = {
  pass: 'bg-emerald-400',
  fail: 'bg-red-400',
  unknown: 'bg-gray-600',
}
const WORD: Record<RuleResult['status'], string> = {
  pass: 'text-emerald-400',
  fail: 'text-red-400',
  unknown: 'text-gray-500',
}

/**
 * The trade's entry rules, passed out of checked (Settings → Trading Rules →
 * Entry rules). Green when every check passed, red when fewer than half did.
 * Click to open the reasons (RulesDetail) under the row. A dash when the tape
 * has not been read for this fill (or cannot be).
 */
export function RulesChip({ results, open, onToggle }: { results: RuleResult[]; open: boolean; onToggle: () => void }) {
  const c = rulesChip(results)
  if (c.tone === 'none') {
    return <span className="text-gray-700" title="No tick data for this trade.">—</span>
  }
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle() }}
      aria-expanded={open}
      title="Your entry rules, passed out of checked. Click for the reasons."
      className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-1.5 py-0.5 rounded border bg-gray-900 hover:border-gray-500 shrink-0 leading-none align-middle ${TONE[c.tone]} ${open ? 'ring-1 ring-blue-400/60' : ''}`}
    >
      <span className="tabular-nums">{c.passed}/{c.checked}</span>
      {open ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
    </button>
  )
}

/** Each rule's pass / fail / unknown with its reason, one line each. */
export function RulesDetail({ results, readAt }: { results: RuleResult[]; readAt: string | null }) {
  const c = rulesChip(results)
  const heading = c.unknown
    ? `Entry rules · ${c.passed} of ${c.checked} checked passed · ${c.unknown} unknown`
    : `Entry rules · ${c.passed} of ${c.checked} passed`
  const greyed = results.some(r => !r.counted)
  return (
    <div className="font-sans text-xs text-gray-300 py-2 max-w-2xl">
      <p className="text-gray-400 font-semibold mb-1.5">{heading}</p>
      <div className="grid grid-cols-[10px_34px_56px_minmax(0,1fr)] gap-x-2 gap-y-1 items-baseline">
        {results.map(r => (
          <div key={r.id} className={`contents ${r.counted ? '' : '[&>*]:opacity-50'}`}>
            <span className={`w-1.5 h-1.5 rounded-full self-center ${DOT[r.status]}`} aria-hidden="true" />
            <span className="font-bold text-gray-200 truncate" title={r.name}>{r.name}</span>
            <span className={WORD[r.status]}>{r.status}</span>
            <span>{r.reason}</span>
          </div>
        ))}
      </div>
      {(readAt || greyed) && (
        <div className="mt-1.5 text-[11px] text-gray-600">
          {readAt && <>Read from the candles that closed before your fill at {readAt} PT and the tape up to that second. Nothing after the fill is used.</>}
          {greyed && <>{readAt ? ' ' : ''}Greyed rules started after this trade, so they don&apos;t count toward its Entry grade.</>}
        </div>
      )}
    </div>
  )
}
