'use client'

/**
 * The small boxes the rule sections in Settings → Trading Rules share (Entry
 * rules, Runner rules). Each keeps what is typed and saves on blur / Enter;
 * callers key them by the saved value, so a value changed elsewhere (clamped,
 * reloaded) re-seeds the box.
 */
import { useState } from 'react'

export const ruleField = 'bg-gray-950 border border-gray-700 text-gray-200 rounded-md px-1.5 py-0.5 text-[13px] focus:outline-none focus:border-blue-500'

/** A number box. */
export function NumInput({ value, decimals, aria, onCommit }: { value: number; decimals: number; aria: string; onCommit: (v: number) => void }) {
  const shown = decimals ? value.toFixed(decimals) : String(Math.round(value))
  const [text, setText] = useState(shown)
  const commit = () => {
    const v = Number(text.replace(',', '.'))
    if (Number.isFinite(v) && v >= 0) { if (v !== value) onCommit(decimals ? v : Math.round(v)) } else setText(shown)
  }
  return (
    <input
      value={text} inputMode="decimal" aria-label={aria}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className={`${ruleField} w-[52px] text-right tabular-nums`}
    />
  )
}

/** A time box, "HH:MM" (24-hour). Anything else reverts. */
export function TimeInput({ value, aria, onCommit }: { value: string; aria: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  const commit = () => {
    const m = text.trim().match(/^(\d{1,2}):(\d{2})$/)
    const v = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null
    if (v) { if (v !== value) onCommit(v) } else setText(value)
  }
  return (
    <input
      value={text} aria-label={aria}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className={`${ruleField} w-[64px] text-right tabular-nums`}
    />
  )
}

/** The rule's own short name. */
export function TextInput({ value, aria, onCommit }: { value: string; aria: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  return (
    <input
      value={text} aria-label={aria} maxLength={24}
      onChange={e => setText(e.target.value)}
      onBlur={() => { if (text !== value) onCommit(text) }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className={`${ruleField} w-14 text-center font-bold`}
    />
  )
}
