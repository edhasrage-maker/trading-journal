'use client'

import { useState } from 'react'
import { X, Plus } from 'lucide-react'

export type CaptureStatus = 'unset' | 'has' | 'default' | 'scratch' | 'skipped'
export interface CaptureValue { status: CaptureStatus; items: string[] }

/**
 * The onboarding gating primitive. For any list-type thing (setups, confluences,
 * order-flow reads, entry models): asks "do you use this?", then lets the trader
 * ADD their own, start from OUR defaults, BUILD from scratch, or SKIP (remind
 * later). Fully controlled — the parent owns { status, items }.
 */
export function CaptureItem({
  label, question, defaults, value, onChange, placeholder = 'Type and press Enter',
}: {
  label: string
  question: string
  defaults: string[]
  value: CaptureValue
  onChange: (v: CaptureValue) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')
  const { status, items } = value
  const editing = status === 'has' || status === 'default' || status === 'scratch'
  const set = (s: CaptureStatus, its: string[]) => onChange({ status: s, items: its })

  const addChip = (raw?: string) => {
    const v = (raw ?? draft).trim()
    if (!v) return
    if (!items.some(i => i.toLowerCase() === v.toLowerCase())) set(status, [...items, v])
    if (!raw) setDraft('')
  }

  return (
    <div className="border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-sm font-medium text-gray-200">{label}</span>
        {status !== 'unset' && (
          <button type="button" onClick={() => set('unset', items)} className="text-xs text-gray-500 hover:text-gray-300">Change</button>
        )}
      </div>

      {status === 'unset' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">{question}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => set('has', items)} className="text-sm px-3 py-1.5 rounded-lg border border-blue-700 text-blue-300 hover:bg-blue-950/40">Yes, I do</button>
            <button type="button" onClick={() => set('default', [...defaults])} className="text-sm px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800">Use TapeScore defaults</button>
            <button type="button" onClick={() => set('scratch', [])} className="text-sm px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800">Build from scratch</button>
            <button type="button" onClick={() => set('skipped', [])} className="text-sm px-3 py-1.5 rounded-lg border border-gray-800 text-gray-500 hover:text-gray-300">Skip — remind me later</button>
          </div>
        </div>
      )}

      {status === 'skipped' && (
        <p className="text-sm text-gray-500">Skipped — we&apos;ll remind you to add these later.{' '}
          <button type="button" onClick={() => set('unset', items)} className="text-blue-400 hover:underline">Add now</button>
        </p>
      )}

      {editing && (
        <div className="space-y-3">
          {status === 'default' && <p className="text-xs text-gray-500">Starting from our defaults — edit freely.</p>}
          <div className="flex flex-wrap gap-1.5">
            {items.map(it => (
              <span key={it} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-gray-700 bg-gray-800/50 text-gray-200">
                {it}
                <button type="button" onClick={() => set(status, items.filter(x => x !== it))} className="text-gray-500 hover:text-red-400"><X className="w-3 h-3" /></button>
              </span>
            ))}
            {items.length === 0 && <span className="text-xs text-gray-600">Nothing yet — add below.</span>}
          </div>
          <div className="flex gap-2">
            <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addChip() } }} placeholder={placeholder}
              className="flex-1 bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
            <button type="button" onClick={() => addChip()} className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 inline-flex items-center gap-1 text-sm"><Plus className="w-3.5 h-3.5" />Add</button>
          </div>
          {status !== 'default' && defaults.some(d => !items.some(i => i.toLowerCase() === d.toLowerCase())) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-gray-600">Suggestions</span>
              {defaults.filter(d => !items.some(i => i.toLowerCase() === d.toLowerCase())).map(d => (
                <button key={d} type="button" onClick={() => addChip(d)} className="text-xs px-2 py-0.5 rounded-full border border-dashed border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200">+ {d}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
