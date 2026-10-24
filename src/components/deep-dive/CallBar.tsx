'use client'

/**
 * Your call — the same Good / Mistake / Unsure + one line as Game film, saved
 * to the same place (trades.review_json.verdict), so a trade has one call
 * wherever you make it. In Blind (and a replay before your exit) the bar starts
 * empty: showing a call you made earlier would tell you how the trade went.
 */
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { TradeVerdict } from '@/lib/supabase/types'

type Call = TradeVerdict['call']
const CALLS: { k: Call; label: string; cls: string }[] = [
  { k: 'good', label: 'Good', cls: 'text-green-400' },
  { k: 'mistake', label: 'Mistake', cls: 'text-red-400' },
  { k: 'unsure', label: 'Unsure', cls: 'text-gray-300' },
]

export default function CallBar({
  tradeId, blind, initial, onSaved, onNext, onDraft, compact = false,
}: {
  tradeId: string
  blind: boolean
  /** The saved call, shown in Full review only. */
  initial: { call: Call | null; note: string } | null
  onSaved: (id: string, v: { call: Call; note: string }) => void
  onNext?: () => void
  /** The pick as it stands (not saved yet): Coach Review's "Save my call and ask" saves it. */
  onDraft?: (id: string, call: Call | null, note: string) => void
  /** Phone: two rows, bigger targets. */
  compact?: boolean
}) {
  const [call, setCall] = useState<Call | null>(blind ? null : initial?.call ?? null)
  const [note, setNote] = useState(blind ? '' : initial?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => { onDraft?.(tradeId, call, note) }, [onDraft, tradeId, call, note])

  const save = async () => {
    if (!call || saving) return
    setSaving(true); setStatus(null)
    try {
      const res = await fetch(`/api/trades/${tradeId}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: { call, note } }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setStatus(data.error ?? `Save failed (${res.status})`); return }
      onSaved(tradeId, { call, note: note.trim() })
      if (onNext) onNext(); else setStatus('Saved')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'network error')
    } finally {
      setSaving(false)
    }
  }

  const buttons = (
    <span role="group" aria-label="Your call" className={cn('border border-gray-800 rounded overflow-hidden', compact ? 'grid grid-cols-3' : 'inline-flex')}>
      {CALLS.map(c => (
        <button
          key={c.k}
          type="button"
          aria-pressed={call === c.k}
          onClick={() => { setCall(c.k); setStatus(null) }}
          className={cn(
            'border-r border-gray-800 last:border-r-0 transition-colors',
            compact ? 'h-10 text-[13px]' : 'px-3.5 py-1.5 text-[12.5px]',
            call === c.k ? cn('bg-gray-800/60 font-semibold shadow-[inset_0_-2px_0_currentColor]', c.cls) : 'text-gray-400 hover:text-gray-200',
          )}
        >{c.label}</button>
      ))}
    </span>
  )
  const input = (
    <input
      type="text"
      aria-label="One line note"
      value={note}
      onChange={e => { setNote(e.target.value); setStatus(null) }}
      onKeyDown={e => { if (e.key === 'Enter') save() }}
      placeholder={blind ? (compact ? 'What you see at the fill' : 'One line: what you see at the fill') : (compact ? 'What you see in hindsight' : 'One line: what you see in hindsight')}
      maxLength={500}
      className={cn('flex-1 min-w-0 border border-gray-800 rounded bg-transparent text-gray-100 placeholder-gray-500 focus:outline-none focus:border-gray-600', compact ? 'h-10 px-2.5 text-[16px]' : 'px-2.5 py-[7px] text-[13px] min-w-[180px]')}
    />
  )
  const saveBtn = (
    <button type="button" onClick={save} disabled={!call || saving}
      className={cn('rounded bg-blue-500 text-white font-semibold whitespace-nowrap disabled:opacity-50', compact ? 'h-10 px-3.5 text-[13px]' : 'px-3.5 py-[7px] text-[12.5px]')}>
      {saving ? 'Saving…' : compact ? 'Save' : 'Save & next'}
    </button>
  )
  const msg = status && <span className={cn('text-[12px] whitespace-nowrap', status === 'Saved' ? 'text-green-400' : 'text-red-400')}>{status}</span>

  if (compact) {
    return (
      <div className="flex flex-col gap-1.5 pt-2">
        {buttons}
        <div className="flex gap-1.5">{input}{saveBtn}</div>
        {msg}
      </div>
    )
  }
  return (
    <div className="h-[54px] flex-none flex items-center gap-3">
      <span className="text-[12.5px] text-gray-400 whitespace-nowrap">Your call</span>
      {buttons}{input}{saveBtn}{msg}
      <span className="text-[11.5px] text-gray-500 whitespace-nowrap">← → trades · B Blind / Full · Space play / pause</span>
    </div>
  )
}
