'use client'

import { useState } from 'react'
import type { TradeTag, TradeTags, TagCategory } from '@/lib/supabase/types'
import { normalizeTagArray } from '@/lib/supabase/types'

interface Props {
  tags: TradeTag[]
  selected: TradeTags
  suggested?: TradeTags
  onChange: (tags: TradeTags) => void
  /** Called after a new custom tag has been successfully created via the
   *  inline "+ Add" affordance. Parents should append it to their `tags`
   *  state so every TagSelector instance sees the new chip immediately
   *  (the journal can have several TradeForms mounted at once). */
  onTagCreated?: (tag: TradeTag) => void
}

const CATEGORY_LABELS: Record<TagCategory, string> = {
  setups: 'Setup',
  confluences: 'Confluences',
  order_flow: 'Order Flow',
  entry_model: 'Entry Model',
  trade_management: 'Management',
  day_type: 'Day Type',
  mistakes: 'Mistakes',
  emotions: 'Emotions',
}

const CATEGORY_COLORS: Partial<Record<TagCategory, string>> = {
  mistakes: 'bg-red-700 border-red-600 text-white',
  emotions: 'bg-purple-700 border-purple-600 text-white',
}

const DEFAULT_SELECTED = 'bg-blue-700 border-blue-600 text-white'

const CATEGORY_ORDER: TagCategory[] = [
  'setups',
  'confluences',
  'order_flow',
  'entry_model',
  'trade_management',
  'day_type',
  'mistakes',
  'emotions',
]

export default function TagSelector({ tags, selected, suggested, onChange, onTagCreated }: Props) {
  // Which category currently has its inline input expanded (only one at a
  // time; the affordance is rarely used and stays out of the way otherwise).
  const [addingFor, setAddingFor] = useState<TagCategory | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorFor, setErrorFor] = useState<string | null>(null)

  const byCategory = tags.reduce((acc, tag) => {
    if (!acc[tag.category]) acc[tag.category] = []
    acc[tag.category].push(tag)
    return acc
  }, {} as Record<TagCategory, TradeTag[]>)

  const toggle = (tag: TradeTag) => {
    const cat = tag.category
    // Normalize: tolerate legacy single-string day_type values from old rows
    const arr = normalizeTagArray(selected[cat])
    const next = arr.includes(tag.label) ? arr.filter(l => l !== tag.label) : [...arr, tag.label]
    onChange({ ...selected, [cat]: next.length > 0 ? next : undefined })
  }

  const isSelected = (tag: TradeTag): boolean => {
    return normalizeTagArray(selected[tag.category]).includes(tag.label)
  }

  const isSuggested = (tag: TradeTag): boolean => {
    if (!suggested) return false
    return normalizeTagArray(suggested[tag.category]).includes(tag.label)
  }

  const commitNewTag = async (cat: TagCategory) => {
    const label = draft.trim()
    if (!label || busy) return
    setBusy(true)
    setErrorFor(null)
    try {
      const res = await fetch('/api/trade-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, label }),
      })
      const json = (await res.json()) as { tag?: TradeTag; error?: string }
      if (!res.ok || !json.tag) {
        setErrorFor(json.error ?? `Failed (${res.status})`)
        return
      }
      // Pre-select the new tag on the current trade so the affordance
      // doubles as "add this to my list and tag this trade with it".
      const arr = normalizeTagArray(selected[cat])
      if (!arr.includes(json.tag.label)) {
        onChange({ ...selected, [cat]: [...arr, json.tag.label] })
      }
      onTagCreated?.(json.tag)
      setDraft('')
      setAddingFor(null)
    } catch (e) {
      setErrorFor(e instanceof Error ? e.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  // Show every category in CATEGORY_ORDER, even empty ones — otherwise the
  // user can't add the very first tag to an empty category.
  return (
    <div className="space-y-4">
      {CATEGORY_ORDER.map(cat => {
        const list = byCategory[cat] ?? []
        const adding = addingFor === cat
        return (
          <div key={cat}>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              {CATEGORY_LABELS[cat] ?? cat}
            </h4>
            <div className="flex flex-wrap gap-1.5 items-center">
              {list.map(tag => {
                const sel = isSelected(tag)
                const sug = isSuggested(tag)
                return (
                  <button key={tag.id} type="button" onClick={() => toggle(tag)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      sel
                        ? (CATEGORY_COLORS[cat] ?? DEFAULT_SELECTED)
                        : sug
                          ? 'bg-yellow-900/20 border-dashed border-yellow-600 text-yellow-400 hover:bg-yellow-900/40'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                    }`}
                  >
                    {sug && !sel ? '+ ' : ''}{tag.label}
                  </button>
                )
              })}
              {adding ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    autoFocus
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitNewTag(cat) }
                      else if (e.key === 'Escape') { setAddingFor(null); setDraft(''); setErrorFor(null) }
                    }}
                    placeholder="New tag…"
                    className="px-2 py-1 rounded-full text-xs bg-gray-900 border border-gray-600 text-gray-100 focus:border-blue-500 focus:outline-none w-36"
                    disabled={busy}
                  />
                  <button type="button" onClick={() => void commitNewTag(cat)} disabled={busy || !draft.trim()}
                    className="px-2 py-1 rounded-full text-xs bg-blue-700 border border-blue-600 text-white disabled:opacity-50">
                    {busy ? '…' : 'Add'}
                  </button>
                  <button type="button" onClick={() => { setAddingFor(null); setDraft(''); setErrorFor(null) }}
                    className="px-2 py-1 rounded-full text-xs text-gray-500 hover:text-gray-300">
                    ✕
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => { setAddingFor(cat); setErrorFor(null) }}
                  className="px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-gray-600 text-gray-500 hover:border-gray-400 hover:text-gray-300 transition-colors">
                  + Add tag
                </button>
              )}
            </div>
            {adding && errorFor && (
              <p className="text-xs text-red-400 mt-1">{errorFor}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
