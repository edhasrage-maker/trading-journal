'use client'

import { useState } from 'react'
import { X, Plus, Check } from 'lucide-react'

export type CaptureStatus = 'unset' | 'has' | 'default' | 'scratch' | 'skipped'
export interface CaptureValue { status: CaptureStatus; items: string[] }

/**
 * The onboarding gating primitive. For any list-type thing (setups, confluences,
 * order-flow reads, entry models): asks "do you use this?", then presents our
 * defaults as an opt-IN tap-to-select grid (nothing pre-selected) plus an
 * add-your-own field. Fully controlled — the parent owns { status, items }.
 *
 * Legacy statuses 'default'/'scratch' still render as the editing grid so old
 * saved profiles keep working; new selections only ever produce 'has'.
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

  const has = (v: string) => items.some(i => i.toLowerCase() === v.toLowerCase())
  const toggle = (v: string) => set('has', has(v) ? items.filter(i => i.toLowerCase() !== v.toLowerCase()) : [...items, v])

  const addChip = (raw?: string) => {
    const v = (raw ?? draft).trim()
    if (!v) return
    if (!has(v)) set('has', [...items, v])
    if (!raw) setDraft('')
  }

  // Items the trader typed that aren't one of our presets.
  const custom = items.filter(i => !defaults.some(d => d.toLowerCase() === i.toLowerCase()))

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
          {defaults.length > 0 && (
            <>
              <p className="text-xs text-gray-500">Tap the ones you use{custom.length ? '' : ' — or add your own below'}.</p>
              <div className="flex flex-wrap gap-1.5">
                {defaults.map(d => {
                  const on = has(d)
                  return (
                    <button key={d} type="button" onClick={() => toggle(d)}
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${on ? 'border-blue-600 bg-blue-950/40 text-blue-200' : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'}`}>
                      {on ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3 opacity-60" />}{d}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {custom.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {custom.map(it => (
                <span key={it} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-blue-700 bg-blue-950/30 text-blue-200">
                  {it}
                  <button type="button" onClick={() => set('has', items.filter(x => x !== it))} className="text-blue-400/70 hover:text-red-400"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addChip() } }} placeholder={placeholder}
              className="flex-1 bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
            <button type="button" onClick={() => addChip()} className="px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 inline-flex items-center gap-1 text-sm"><Plus className="w-3.5 h-3.5" />Add your own</button>
          </div>
        </div>
      )}
    </div>
  )
}
